import sharp from 'sharp';
import { parseFile, selectCover, TrackType, type IAudioMetadata, type IChapter, type IOptions } from 'music-metadata';
import { parseSeriesIndex as parseSeriesIndexLabel, type AudiobookChapter } from '@bookorbit/types';
import { parsePublishedDateKey, parsePublishedYear, publishedYearFromDateKey } from '../../../common/utils/published-date.utils';

const MAX_EMBEDDED_COVER_BYTES = 32 * 1_024 * 1_024;
const CUSTOM_AUDIO_TAGS = new Set([
  'series',
  'series-part',
  'part',
  'series_part',
  'seriespart',
  'show',
  'episode_id',
  'episode_sort',
  'audible_asin',
  'librofm_isbn',
  'publisher',
  'subtitle',
]);
// Match parser source precedence while reading only primary credits, not supplemental artist aliases.
const PERSON_TAG_SOURCES = ['APEv2', 'vorbis', 'ID3v2.4', 'ID3v2.3', 'ID3v2.2', 'iTunes', 'ID3v1'] as const;
const PERSON_TAG_IDS = {
  artist: new Set(['artist', 'tpe1', 'tp1', '©art']),
  albumartist: new Set(['albumartist', 'album_artist', 'album artist', 'tpe2', 'tp2', 'aart']),
};
const SUPPLEMENTARY_PERSON_TAG_IDS = {
  artist: new Set(['artists', 'discogs_artists', 'discogs_artist_name']),
  albumartist: new Set(['albumartists', 'discogs_album_artists']),
};
const DESCRIPTION_TAGS = new Set(['comment', 'description', 'lyrics', 'synopsis']);
const AUDIO_PARSE_OPTIONS: IOptions = {
  duration: true,
  maxMemoryAllocation: 64 * 1_024 * 1_024,
  maxMetadataEntries: 100_000,
  maxChapterCount: 100_000,
};

export interface AudioExtractResult {
  title: string | null;
  subtitle: string | null;
  authors: { name: string; sortName: string | null }[];
  narrators: string[];
  publisher: string | null;
  publishedDate: string | null;
  publishedYear: number | null;
  description: string | null;
  language: string | null;
  seriesName: string | null;
  seriesIndex: string | null;
  genres: string[];
  audibleId: string | null;
  librofmId: string | null;
  durationSeconds: number | null;
  chapters: AudiobookChapter[];
  coverBytes: Buffer | null;
}

export interface AudioChapterProbe {
  chapters: AudiobookChapter[];
  durationMs: number | null;
}

// Null means the file could not be read, which is not the same as a file that carries no tags:
// callers persist what they get, so a failed read must never be mistaken for empty metadata.
export async function extractAudioMetadata(absolutePath: string, options: { cover?: boolean } = {}): Promise<AudioExtractResult | null> {
  try {
    const metadata = await readAudio(absolutePath, { includeChapters: true });
    if (!metadata) return null;
    const tags = metadataTags(metadata);

    const rawAlbumArtist = tagValue(tags, 'albumartist') ?? tagValue(tags, 'album_artist');
    const rawArtist = tagValue(tags, 'artist');
    const rawComposer = tagValue(tags, 'composer');

    const authorNames = rawAlbumArtist ? splitArtists(rawAlbumArtist) : rawArtist ? splitArtists(rawArtist) : [];
    const narratorNames = rawComposer
      ? splitNarrators(rawComposer)
      : rawAlbumArtist && rawArtist && normalizePersonTag(rawAlbumArtist) !== normalizePersonTag(rawArtist)
        ? splitNarrators(rawArtist)
        : [];

    // Album tag is the audiobook title; fall back to track title.
    const title = tagValue(tags, 'album') ?? tagValue(tags, 'title');
    const subtitle = tagValue(tags, 'subtitle');

    const publisher = tagValue(tags, 'publisher');
    const rawPublicationDate = tagValue(tags, 'date') ?? tagValue(tags, 'year');
    const publishedDate = parsePublishedDateKey(rawPublicationDate) ?? null;
    const publishedYear = publishedDate ? publishedYearFromDateKey(publishedDate) : (parsePublishedYear(rawPublicationDate) ?? null);
    const description = resolveDescription(
      tagValue(tags, 'comment'),
      tagValue(tags, 'description'),
      tagValue(tags, 'lyrics'),
      tagValue(tags, 'synopsis'),
    );
    const language = resolveLanguage(tags, metadata);
    const seriesName = tagValue(tags, 'series') ?? tagValue(tags, 'show');
    const seriesIndex = parseSeriesIndex(
      tagValue(tags, 'series-part') ??
        tagValue(tags, 'part') ??
        tagValue(tags, 'series_part') ??
        tagValue(tags, 'seriespart') ??
        tagValue(tags, 'episode_id') ??
        tagValue(tags, 'episode_sort'),
    );
    const genres = splitTagList(tagValue(tags, 'genre'), ';');
    const audibleId = tagValue(tags, 'asin') ?? tagValue(tags, 'audible_asin');
    const librofmId = tagValue(tags, 'librofm_isbn');
    const durationSeconds = roundedDuration(audioDuration(metadata), 1);

    const mappedChapters = mapChapters(metadata.format.chapters ?? []);

    const coverBytes = options.cover === false ? null : await extractCoverBytes(metadata);

    return {
      title,
      subtitle,
      authors: authorNames.map((name) => ({ name, sortName: null })),
      narrators: narratorNames,
      publisher,
      publishedDate,
      publishedYear,
      description,
      language,
      seriesName,
      seriesIndex,
      genres,
      audibleId,
      librofmId,
      durationSeconds,
      chapters: mappedChapters,
      coverBytes,
    };
  } catch {
    return null;
  }
}

export async function parseAudioDuration(absolutePath: string): Promise<number | null> {
  try {
    const metadata = await readAudio(absolutePath, { skipCovers: true });
    return metadata ? roundedDuration(audioDuration(metadata), 1) : null;
  } catch {
    return null;
  }
}

// Keep millisecond precision here: rounding each file to seconds compounds chapter offsets.
export async function probeAudioChapters(absolutePath: string): Promise<AudioChapterProbe> {
  try {
    const metadata = await readAudio(absolutePath, { includeChapters: true, skipCovers: true });
    if (!metadata) return { chapters: [], durationMs: null };
    return { chapters: mapChapters(metadata.format.chapters ?? []), durationMs: roundedDuration(audioDuration(metadata), 1000) };
  } catch {
    return { chapters: [], durationMs: null };
  }
}

function mapChapters(chapters: readonly IChapter[]): AudiobookChapter[] {
  return chapters.flatMap((chapter) => {
    const scale = chapter.timeScale ?? 1;
    const startMs = Math.round((chapter.start / scale) * 1000);
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(startMs) || startMs < 0) return [];
    return [{ title: chapter.title ?? '', startMs }];
  });
}

export async function extractAudioCover(absolutePath: string): Promise<Buffer | null> {
  try {
    const metadata = await readAudio(absolutePath, { duration: false });
    return metadata ? await extractCoverBytes(metadata) : null;
  } catch {
    return null;
  }
}

async function readAudio(absolutePath: string, options: IOptions = {}): Promise<IAudioMetadata | null> {
  const metadata = await parseFile(absolutePath, { ...AUDIO_PARSE_OPTIONS, ...options });
  if (
    metadata.format.hasAudio === false ||
    (options.includeChapters && metadata.quality.warnings.some((warning) => /chapter limit/i.test(warning.message)))
  ) {
    return null;
  }
  return metadata;
}

async function extractCoverBytes(metadata: IAudioMetadata): Promise<Buffer | null> {
  const cover = selectCover(metadata.common.picture);
  if (!cover || cover.data.byteLength === 0 || cover.data.byteLength > MAX_EMBEDDED_COVER_BYTES) return null;
  const bytes = Buffer.from(cover.data);
  try {
    await sharp(bytes, { failOn: 'error' }).metadata();
    return bytes;
  } catch {
    return null;
  }
}

function audioDuration(metadata: IAudioMetadata): number | undefined {
  return metadata.format.containerDuration ?? metadata.format.duration;
}

function roundedDuration(duration: number | undefined, scale: number): number | null {
  return duration !== undefined && Number.isFinite(duration) && duration >= 0 ? Math.round(duration * scale) : null;
}

function metadataTags(metadata: IAudioMetadata): Record<string, string> {
  const { common } = metadata;
  const tags: Record<string, string> = Object.create(null) as Record<string, string>;
  const commonTags = {
    title: common.title,
    album: common.album,
    albumartist: primaryPersonTag(metadata, 'albumartist') ?? common.albumartist ?? common.albumartists?.join(';'),
    artist: primaryPersonTag(metadata, 'artist') ?? common.artist ?? common.artists?.join(';'),
    composer: common.composer?.join(';'),
    publisher: (common.publisher ?? common.label)?.join(';'),
    subtitle: common.subtitle?.join(';'),
    date: common.date ?? common.year?.toString(),
    comment: resolveDescription(...(common.comment ?? []).map((comment) => comment.text)),
    description: resolveDescription(...(common.description ?? [])),
    lyrics: resolveDescription(...(common.lyrics ?? []).map((lyrics) => lyrics.text)),
    synopsis: common.longDescription,
    language: common.language,
    genre: common.genre?.join(';'),
    asin: common.asin,
    show: common.tvShow,
    episode_id: common.tvEpisodeId,
  };
  for (const [key, value] of Object.entries(commonTags)) {
    if (value !== undefined && value !== null) tags[key] = value;
  }
  // Common tags do not cover application-specific fields such as series and Libro.fm ISBN.
  for (const entries of Object.values(metadata.native)) {
    for (const { id, value } of entries) {
      if (typeof value !== 'string') continue;
      const key = id.replace(/^mdta:|^TXXX:|^----:[^:]+:/i, '').toLowerCase();
      if (CUSTOM_AUDIO_TAGS.has(key) || tags[key] === undefined) {
        tags[key] = value;
      } else if (DESCRIPTION_TAGS.has(key)) {
        tags[key] = resolveDescription(tags[key], value) ?? '';
      }
    }
  }
  return tags;
}

function primaryPersonTag(metadata: IAudioMetadata, field: keyof typeof PERSON_TAG_IDS): string | undefined {
  for (const source of PERSON_TAG_SOURCES) {
    const primary: string[] = [];
    const supplementary: string[] = [];
    for (const { id, value } of metadata.native[source] ?? []) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const key = id.replace(/^mdta:/i, '').toLowerCase();
      if (PERSON_TAG_IDS[field].has(key)) primary.push(value);
      else if (SUPPLEMENTARY_PERSON_TAG_IDS[field].has(key.replace(/^txxx:|^----:[^:]+:/, ''))) supplementary.push(value);
    }
    if (primary.length > 0) return primary.join(';');
    if (supplementary.length > 0) return supplementary.join(';');
  }
  return undefined;
}

function tagValue(tags: Record<string, string>, key: string): string | null {
  const value = tags[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function splitArtists(raw: string): string[] {
  return splitTagList(raw, ';/');
}

function splitNarrators(raw: string): string[] {
  return splitTagList(raw, ',;/');
}

function normalizePersonTag(raw: string): string {
  return raw.trim().toLowerCase();
}

function splitTagList(raw: string | null, separators: string): string[] {
  if (!raw) return [];
  const pattern = new RegExp(`[${escapeCharClass(separators)}]`);
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of raw.split(pattern)) {
    const value = part.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

function escapeCharClass(value: string): string {
  return value.replace(/[\\\]^/-]/g, '\\$&');
}

function parseSeriesIndex(raw: string | null): string | null {
  if (!raw) return null;
  return parseSeriesIndexLabel(raw);
}

function resolveDescription(...values: (string | null | undefined)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length)[0] ?? null;
}

function resolveLanguage(tags: Record<string, string>, metadata: IAudioMetadata): string | null {
  const language = normalizeLanguageValue(tagValue(tags, 'language'));
  if (language) return language;
  for (const track of metadata.format.trackInfo ?? []) {
    if (track.type !== TrackType.audio) continue;
    const trackLanguage = normalizeLanguageValue(track.language ?? null);
    if (trackLanguage) return trackLanguage;
  }
  return null;
}

function normalizeLanguageValue(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  return lower === 'und' || lower === 'unknown' ? null : normalized;
}
