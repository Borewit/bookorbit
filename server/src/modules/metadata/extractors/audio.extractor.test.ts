import { execFile } from 'child_process';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { promisify } from 'util';
import { createRequire } from 'module';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFile, TrackType, type IAudioMetadata, type ICommonTagsResult, type IFormat } from 'music-metadata';
import { extractAudioCover, extractAudioMetadata, parseAudioDuration, probeAudioChapters } from './audio.extractor';

vi.mock('music-metadata', async (importOriginal) => ({
  ...(await importOriginal<typeof import('music-metadata')>()),
  parseFile: vi.fn(),
}));

const mockParseFile = vi.mocked(parseFile);

function metadata(tags: Record<string, string> = {}, common: Partial<ICommonTagsResult> = {}, format: Partial<IFormat> = {}): IAudioMetadata {
  return {
    format: { tagTypes: [], trackInfo: [], hasAudio: true, duration: 3600, ...format },
    native: { iTunes: Object.entries(tags).map(([id, value]) => ({ id: `mdta:${id}`, value })) },
    common: { track: { no: null, of: null }, disk: { no: null, of: null }, movementIndex: { no: null, of: null }, ...common },
    quality: { warnings: [] },
  };
}

beforeEach(() => {
  mockParseFile.mockReset();
});

async function extract(tags: Record<string, string> = {}, common: Partial<ICommonTagsResult> = {}, format: Partial<IFormat> = {}) {
  mockParseFile.mockResolvedValue(metadata(tags, common, format));
  return extractAudioMetadata('/books/book.m4b');
}

describe('audio metadata field policies', () => {
  it.each([
    [{ albumartist: 'Author', artist: 'Author', composer: 'Narrator' }, ['Author'], ['Narrator']],
    [{ albumartist: 'Author', artist: 'Narrator' }, ['Author'], ['Narrator']],
    [{ albumartist: 'Author', artist: 'author' }, ['Author'], []],
    [{ artist: 'Author' }, ['Author'], []],
    [{ artist: 'Author', composer: 'Narrator' }, ['Author'], ['Narrator']],
    [{ album_artist: 'Author', artist: 'Narrator' }, ['Author'], ['Narrator']],
    [
      { albumartist: 'Last, First; Second / Third', composer: 'One, Two; Three / Four' },
      ['Last, First', 'Second', 'Third'],
      ['One', 'Two', 'Three', 'Four'],
    ],
    [{ albumartist: 'Author; author; Other', composer: 'Narrator; narrator' }, ['Author', 'Other'], ['Narrator']],
    [{}, [], []],
  ])('preserves authors and narrators for %j', async (tags, authors, narrators) => {
    const result = await extract(tags);
    expect(result?.authors).toEqual(authors.map((name) => ({ name, sortName: null })));
    expect(result?.narrators).toEqual(narrators);
  });

  it.each([
    ['ID3v2.4', 'TPE2', 'TPE1'],
    ['ID3v2.3', 'TPE2', 'TPE1'],
    ['ID3v2.2', 'TP2', 'TP1'],
    ['vorbis', 'ALBUMARTIST', 'ARTIST'],
    ['APEv2', 'Album Artist', 'Artist'],
    ['iTunes', 'aART', '©ART'],
    ['iTunes', 'mdta:album_artist', 'mdta:artist'],
  ])('keeps primary credits distinct from supplementary lists in %s', async (type, albumId, artistId) => {
    const combined = 'Last, First & Second';
    const input = metadata(
      {},
      {
        albumartist: combined,
        albumartists: [combined, 'Last, First', 'Second'],
        artist: combined,
        artists: ['Last, First', 'Second'],
      },
    );
    input.native = {
      [type]: [
        { id: albumId, value: combined },
        { id: artistId, value: combined },
      ],
    };
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toMatchObject({ authors: [{ name: combined }], narrators: [] });
  });

  it('preserves repeated primary author and narrator tags without alias enrichment', async () => {
    const input = metadata(
      {},
      {
        albumartist: 'First Author',
        albumartists: ['First Author', 'Second Author', 'Alias Author'],
        artist: 'First Reader',
        artists: ['First Reader', 'Second Reader', 'Alias Reader'],
      },
    );
    input.native = {
      vorbis: [
        { id: 'ALBUMARTIST', value: 'First Author' },
        { id: 'ALBUMARTIST', value: 'Second Author' },
        { id: 'ALBUMARTIST', value: 'first author' },
        { id: 'ARTIST', value: 'First Reader' },
        { id: 'ARTIST', value: 'Second Reader' },
      ],
    };
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toMatchObject({
      authors: [{ name: 'First Author' }, { name: 'Second Author' }],
      narrators: ['First Reader', 'Second Reader'],
    });
  });

  it('uses supplementary credits when the preferred source has no primary tags', async () => {
    const input = metadata({}, { artist: 'First & Second', artists: ['First', 'Second'] });
    input.native = {
      ID3v1: [{ id: 'artist', value: 'Old Artist' }],
      'ID3v2.3': [
        { id: 'TXXX:Artists', value: 'First' },
        { id: 'TXXX:Artists', value: 'Second' },
      ],
    };
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toMatchObject({ authors: [{ name: 'First' }, { name: 'Second' }], narrators: [] });
  });

  it('retains literal common credits when native fields are unrecognized', async () => {
    const combined = 'Last, First & Second';
    const input = metadata(
      {},
      {
        albumartist: combined,
        albumartists: ['Last, First', 'Second'],
        artist: combined,
        artists: ['Last, First', 'Second'],
      },
    );
    input.native = {
      asf: [
        { id: 'WM/AlbumArtist', value: combined },
        { id: 'Author', value: combined },
      ],
    };
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toMatchObject({ authors: [{ name: combined }], narrators: [] });
  });

  it('uses supplementary MP4 artist lists when no primary credit exists', async () => {
    const input = metadata({}, { artist: 'First & Second', artists: ['First', 'Second'] });
    input.native = {
      iTunes: [
        { id: '----:com.apple.iTunes:ARTISTS', value: 'First' },
        { id: '----:com.apple.iTunes:ARTISTS', value: 'Second' },
      ],
    };
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toMatchObject({ authors: [{ name: 'First' }, { name: 'Second' }], narrators: [] });
  });

  it('keeps primary person source precedence and composer priority', async () => {
    const input = metadata({}, { composer: ['Composer Reader'] });
    input.native = {
      ID3v1: [{ id: 'artist', value: 'Old Reader' }],
      'ID3v2.3': [
        { id: 'TPE2', value: 'ID3 Author' },
        { id: 'TPE1', value: 'ID3 Reader' },
      ],
      vorbis: [
        { id: 'ALBUMARTIST', value: 'Vorbis Author' },
        { id: 'ARTIST', value: 'Vorbis Reader' },
      ],
      APEv2: [
        { id: 'Album Artist', value: 'APE Author' },
        { id: 'Artist', value: 'APE Reader' },
      ],
    };
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toMatchObject({ authors: [{ name: 'APE Author' }], narrators: ['Composer Reader'] });
  });

  it('reads normalized common tags, including repeated people', async () => {
    const result = await extract(
      {},
      {
        title: 'Track',
        album: 'Book',
        albumartists: ['Author', 'Other'],
        artists: ['Reader'],
        composer: ['Narrator', 'Second'],
        label: ['Publisher'],
        subtitle: ['Subtitle'],
        date: '2024-02-03',
        description: ['Description'],
        language: 'eng',
        genre: ['Fantasy', 'Adventure'],
        asin: 'B000TEST',
      },
    );
    expect(result).toMatchObject({
      title: 'Book',
      authors: [{ name: 'Author' }, { name: 'Other' }],
      narrators: ['Narrator', 'Second'],
      publisher: 'Publisher',
      subtitle: 'Subtitle',
      publishedDate: '2024-02-03',
      publishedYear: 2024,
      description: 'Description',
      language: 'eng',
      genres: ['Fantasy', 'Adventure'],
      audibleId: 'B000TEST',
    });
  });

  it.each([
    [{ album: 'Book', title: 'Track' }, 'Book'],
    [{ album: ' ', title: 'Track' }, 'Track'],
    [{ title: 'Track' }, 'Track'],
    [{}, null],
  ])('selects book title for %j', async (tags, title) => {
    expect((await extract(tags))?.title).toBe(title);
  });

  it.each([
    [{ series: 'Custom', show: 'Native', 'series-part': '4.5', episode_id: '9' }, 'Custom', '4.5'],
    [{ show: 'Native', episode_id: '9' }, 'Native', '9'],
    [{ series: 'Custom', series_part: '1.5' }, 'Custom', '1.5'],
    [{ series: 'Custom', seriespart: '2' }, 'Custom', '2'],
    [{ series: 'Custom', part: '3' }, 'Custom', '3'],
  ])('preserves series alias precedence for %j', async (tags, seriesName, seriesIndex) => {
    expect(await extract(tags)).toMatchObject({ seriesName, seriesIndex });
  });

  it.each(['mdta:', '----:com.apple.iTunes:', 'TXXX:', ''])('reads custom tags from %s keys', async (prefix) => {
    const input = metadata();
    input.native = {
      iTunes: Object.entries({
        SERIES: 'Series',
        'SERIES-PART': '1.5',
        PUBLISHER: 'Publisher',
        SUBTITLE: 'Subtitle',
        AUDIBLE_ASIN: 'B000TEST',
        LIBROFM_ISBN: '9780000000000',
      }).map(([id, value]) => ({ id: prefix + id, value })),
    };
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toMatchObject({
      seriesName: 'Series',
      seriesIndex: '1.5',
      publisher: 'Publisher',
      subtitle: 'Subtitle',
      audibleId: 'B000TEST',
      librofmId: '9780000000000',
    });
  });

  it('keeps parser source precedence and repeated standard values', async () => {
    const input = metadata({}, { title: 'ID3v2 title', artist: 'First', artists: ['First', 'Second'] });
    input.native = {
      'ID3v2.3': [
        { id: 'TPE1', value: 'First' },
        { id: 'TPE1', value: 'Second' },
      ],
      ID3v1: [
        { id: 'title', value: 'Old title' },
        { id: 'artist', value: 'First' },
      ],
    };
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toMatchObject({ title: 'ID3v2 title', authors: [{ name: 'First' }, { name: 'Second' }] });
  });

  it('prefers ASIN over its alternate and keeps genre splitting', async () => {
    expect(await extract({ asin: 'Primary', audible_asin: 'Alternate', genre: 'Fantasy; Fantasy; Adventure' })).toMatchObject({
      audibleId: 'Primary',
      genres: ['Fantasy', 'Adventure'],
    });
  });

  it.each(['comment', 'description', 'lyrics', 'synopsis'])('selects the longest description including %s', async (key) => {
    expect((await extract({ comment: 'Short', [key]: 'A longer description' }))?.description).toBe('A longer description');
  });

  it('selects the longest text across normalized description fields', async () => {
    expect(
      (
        await extract(
          {},
          {
            comment: [{ text: 'Short' }],
            description: ['Medium text'],
            lyrics: [{ text: 'A much longer description' }],
            longDescription: 'Synopsis',
          },
        )
      )?.description,
    ).toBe('A much longer description');
  });

  it.each([
    ['2024-02-03', '2024-02-03', 2024],
    ['2024', null, 2024],
    ['unknown', null, null],
  ])('preserves publication date precision for %s', async (date, publishedDate, publishedYear) => {
    expect(await extract({ date })).toMatchObject({ publishedDate, publishedYear });
  });

  it('uses common year when no date is available', async () => {
    expect((await extract({}, { year: 2024 }))?.publishedYear).toBe(2024);
  });

  it('uses audio track language after unknown format language and ignores video', async () => {
    const result = await extract(
      { language: 'und' },
      {},
      {
        trackInfo: [
          { type: TrackType.video, language: 'deu' },
          { type: TrackType.audio, language: 'fra' },
        ],
      },
    );
    expect(result?.language).toBe('fra');
  });

  it('prefers explicit language over the audio track', async () => {
    expect((await extract({ language: 'eng' }, {}, { trackInfo: [{ type: TrackType.audio, language: 'fra' }] }))?.language).toBe('eng');
  });

  it('returns null for unknown language placeholders', async () => {
    expect((await extract({ language: 'unknown' }))?.language).toBeNull();
  });
});

describe('duration and chapter reads', () => {
  it('retains container duration rather than decoder padding', async () => {
    const result = await extract({}, {}, { duration: 1.274, containerDuration: 1.25 });
    expect(result?.durationSeconds).toBe(1);
    expect(await probeAudioChapters('/books/book')).toEqual({ chapters: [], durationMs: 1250 });
  });

  it.each([119.994, 7200.4, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])('handles duration %s', async (duration) => {
    mockParseFile.mockResolvedValue(metadata({}, {}, { duration }));
    expect(await parseAudioDuration('/books/book')).toBe(
      duration !== undefined && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
    );
    expect(await probeAudioChapters('/books/book')).toEqual({
      chapters: [],
      durationMs: duration !== undefined && Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 1000) : null,
    });
  });

  it('converts chapter timescales and preserves millisecond precision', async () => {
    const result = await extract(
      {},
      {},
      {
        duration: 119.994,
        chapters: [
          { title: 'First', start: 0, timeScale: 1000 },
          { title: 'Second', start: 66150, timeScale: 44100 },
          { title: '', start: 2 },
          { title: 'Broken', start: Number.NaN },
          { title: 'Bad scale', start: 0, timeScale: 0 },
          { title: 'Infinite scale', start: 1, timeScale: Number.POSITIVE_INFINITY },
          { title: 'Unsafe offset', start: Number.MAX_SAFE_INTEGER },
          { title: 'Negative', start: -1 },
        ],
      },
    );
    expect(result?.chapters).toEqual([
      { title: 'First', startMs: 0 },
      { title: 'Second', startMs: 1500 },
      { title: '', startMs: 2000 },
    ]);
    expect((await probeAudioChapters('/books/book')).durationMs).toBe(119994);
  });

  it('skips covers on duration and chapter reads and sets an explicit chapter limit', async () => {
    mockParseFile.mockResolvedValue(metadata());
    await parseAudioDuration('/books/book');
    expect(mockParseFile).toHaveBeenLastCalledWith('/books/book', expect.objectContaining({ duration: true, skipCovers: true }));
    await probeAudioChapters('/books/book');
    expect(mockParseFile).toHaveBeenLastCalledWith(
      '/books/book',
      expect.objectContaining({ includeChapters: true, skipCovers: true, maxChapterCount: 100000 }),
    );
  });

  it('does not return a truncated chapter list as complete', async () => {
    const input = metadata({}, {}, { chapters: [{ title: 'Partial', start: 0 }] });
    input.quality.warnings = [{ message: 'Chapter count exceeds the 100000 chapter limit' }];
    mockParseFile.mockResolvedValue(input);
    expect(await extractAudioMetadata('/books/book')).toBeNull();
    expect(await probeAudioChapters('/books/book')).toEqual({ chapters: [], durationMs: null });
    expect(await parseAudioDuration('/books/book')).toBe(3600);
  });
});

describe('embedded pictures and failures', () => {
  it('selects the front cover and returns its original PNG bytes', async () => {
    const picture = Uint8Array.from(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64'),
    );
    await extract(
      {},
      {
        picture: [
          { type: 'Cover (back)', format: 'image/jpeg', data: Uint8Array.of(1) },
          { type: 'Cover (front)', format: 'image/png', data: picture },
        ],
      },
    );
    const cover = await extractAudioCover('/books/book');
    expect(cover).toEqual(Buffer.from(picture));
    picture[0] = 0;
    expect(cover?.[0]).toBe(137);
    expect(mockParseFile).toHaveBeenLastCalledWith('/books/book', expect.objectContaining({ duration: false }));
  });

  it.each([0, 32 * 1024 * 1024 + 1])('rejects a cover of %s bytes without losing other metadata', async (length) => {
    const result = await extract({ title: 'Book' }, { picture: [{ format: 'image/jpeg', data: new Uint8Array(length) }] });
    expect(result?.title).toBe('Book');
    expect(result?.coverBytes).toBeNull();
  });

  it('returns null for malformed artwork without discarding the tags', async () => {
    expect(await extract({ title: 'Book' }, { picture: [{ format: 'image/png', data: Uint8Array.of(1, 2) }] })).toMatchObject({
      title: 'Book',
      coverBytes: null,
    });
  });

  it('returns null for absent covers', async () => {
    mockParseFile.mockResolvedValue(metadata());
    expect(await extractAudioCover('/books/book')).toBeNull();
  });

  it('distinguishes unreadable files from untagged audio', async () => {
    expect(await extract()).toMatchObject({ title: null, authors: [], narrators: [], chapters: [], coverBytes: null });
    mockParseFile.mockRejectedValue(new Error('Unreadable input'));
    await expect(extractAudioMetadata('/books/book')).resolves.toBeNull();
    await expect(extractAudioCover('/books/book')).resolves.toBeNull();
    await expect(parseAudioDuration('/books/book')).resolves.toBeNull();
    await expect(probeAudioChapters('/books/book')).resolves.toEqual({ chapters: [], durationMs: null });
  });

  it('rejects a container without audio', async () => {
    expect(await extract({}, {}, { hasAudio: false })).toBeNull();
  });
});

const exec = promisify(execFile);
const fixture = (name: string) => resolve(__dirname, '../../../../test/fixtures/audio', name);

describe('real audio metadata', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('music-metadata')>('music-metadata');
    mockParseFile.mockImplementation(actual.parseFile);
  });

  it.each(['person-tags-primary.mp3', 'person-tags-primary.flac'])('retains primary combined credits in %s', async (name) => {
    expect(await extractAudioMetadata(fixture(name))).toMatchObject({
      authors: [{ name: 'Last, First & Second', sortName: null }],
      narrators: [],
    });
  });

  it('retains repeated primary author and narrator tags in playable FLAC', async () => {
    expect(await extractAudioMetadata(fixture('person-tags-repeated.flac'))).toMatchObject({
      authors: [{ name: 'First Author' }, { name: 'Second Author' }],
      narrators: ['First Reader', 'Second Reader'],
    });
  });

  it.each([3, 4])('reads ID3v2.%s chapter starts in seconds, including untitled chapters', async (version) => {
    const expected =
      version === 3
        ? [
            { title: '', startMs: 0 },
            { title: '', startMs: 250 },
            { title: '', startMs: 500 },
            { title: 'Named chapter', startMs: 750 },
          ]
        : [
            { title: '', startMs: 500 },
            { title: '', startMs: 0 },
            { title: '', startMs: 250 },
            { title: 'Named chapter', startMs: 750 },
          ];
    const path = fixture(`id3v2.${version}-untitled-chapters.mp3`);
    expect((await probeAudioChapters(path)).chapters).toEqual(expected);
    expect((await extractAudioMetadata(path))?.chapters).toEqual(expected);
  });
  it('reads indexed mdta fields with the published music-metadata package', async () => {
    expect(await extractAudioMetadata(fixture('mdta-tags.m4b'))).toMatchObject({
      title: 'Metadata Audiobook',
      authors: [{ name: 'Sample Author', sortName: null }],
      narrators: ['Sample Narrator'],
      publisher: 'Sample Publisher',
      subtitle: 'A playable regression sample',
      publishedDate: '2024-02-03',
      publishedYear: 2024,
      description: 'An original generated tone for MP4 metadata regression testing.',
      seriesName: 'Sample Series',
      seriesIndex: '4.5',
      audibleId: 'B000TEST',
      librofmId: '9780000000000',
    });
  });

  it.each(['chapters-nero.m4b', 'chapters-trailing.m4b'])('reads chapters from %s', async (name) => {
    expect((await probeAudioChapters(fixture(name))).chapters).toEqual([
      { title: 'Opening Credits', startMs: 0 },
      { title: 'Chapter 1', startMs: 3000 },
      { title: 'Chapter 2', startMs: 7000 },
    ]);
    expect((await extractAudioMetadata(fixture(name)))?.chapters).toHaveLength(3);
  });

  let dir: string;
  let ffmpeg: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bookorbit-audio-metadata-'));
    const requirePackage = createRequire(import.meta.url);
    const installer = requirePackage('@ffmpeg-installer/ffmpeg') as { path: string };
    ffmpeg = join(dir, 'ffmpeg');
    await copyFile(installer.path, ffmpeg);
    await chmod(ffmpeg, 0o755);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['mp3', 'libmp3lame'],
    ['flac', 'flac'],
    ['ogg', 'libvorbis'],
    ['opus', 'libopus'],
    ['m4a', 'aac'],
  ])('reads common tags from a playable %s file', async (extension, codec) => {
    const file = join(dir, `tagged.${extension}`);
    await exec(ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1.25',
      '-c:a',
      codec,
      '-metadata',
      'title=Track',
      '-metadata',
      'album=Book',
      '-metadata',
      'artist=Author',
      '-metadata',
      'composer=Narrator',
      '-metadata',
      'genre=Fiction',
      file,
    ]);
    expect(await extractAudioMetadata(file)).toMatchObject({
      title: 'Book',
      authors: [{ name: 'Author', sortName: null }],
      narrators: ['Narrator'],
      genres: ['Fiction'],
      durationSeconds: 1,
    });
    expect(await parseAudioDuration(file)).toBe(1);
  });

  it('extracts original PNG artwork from MP3 without encoding it as JPEG', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } })
      .png()
      .toBuffer();
    const pngPath = join(dir, 'cover.png');
    const file = join(dir, 'cover.mp3');
    await writeFile(pngPath, png);
    await exec(ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1.25',
      '-i',
      pngPath,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'libmp3lame',
      '-c:v',
      'copy',
      '-id3v2_version',
      '3',
      '-metadata:s:v',
      'comment=Cover (front)',
      file,
    ]);
    expect(await extractAudioCover(file)).toEqual(png);
    expect((await extractAudioMetadata(file))?.coverBytes).toEqual(png);
  });
});
