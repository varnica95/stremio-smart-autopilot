import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '../../src/infrastructure/logging/logger.js';
import { CinemetaProvider, parseRuntimeMinutes } from '../../src/providers/metadata/cinemeta.js';
import { InternetArchiveProvider } from '../../src/providers/streams/internet-archive.js';
import { StremioAddonUpstreamProvider } from '../../src/providers/streams/stremio-addon-upstream.js';
import { OpenSubtitlesProvider, userKeyToken } from '../../src/providers/subtitles/opensubtitles.js';
import { EPISODE, MOVIE, fakeFetch, jsonResponse } from '../helpers/factories.js';

const signal = new AbortController().signal;

describe('Internet Archive provider', () => {
  const fetchImpl = fakeFetch({
    'https://archive.org/advancedsearch.php': () =>
      jsonResponse({
        response: {
          docs: [
            { identifier: 'the_wizard_of_oz_1939', title: 'The Wizard of Oz', year: '1939', downloads: 5000 },
            { identifier: 'unrelated', title: 'Oz the Great', year: '2013' },
          ],
        },
      }),
    'https://archive.org/metadata/the_wizard_of_oz_1939': () =>
      jsonResponse({
        metadata: { title: 'The Wizard of Oz' },
        files: [
          { name: 'oz.mp4', format: 'h.264', size: '1500000000', height: '1080' },
          { name: 'oz_512kb.mp4', format: '512Kb MPEG4', size: '300000000', height: '240' },
          { name: 'oz.jpg', format: 'JPEG' },
        ],
      }),
  });

  it('matches the title and turns video files into HTTP streams', async () => {
    const streams = await new InternetArchiveProvider(fetchImpl).findStreams(MOVIE, {
      signal,
      metadata: { title: 'The Wizard of Oz', year: 1939 },
    });
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({
      resolution: '1080p',
      videoCodec: 'h264',
      sizeBytes: 1_500_000_000,
      transport: { kind: 'http', url: 'https://archive.org/download/the_wizard_of_oz_1939/oz.mp4' },
    });
    expect(streams[1]?.resolution).toBe('360p');
  });

  it('reports missing title metadata as an error, and does not handle series', async () => {
    const provider = new InternetArchiveProvider(fetchImpl);
    await expect(provider.findStreams(MOVIE, { signal, metadata: {} })).rejects.toThrow('title metadata unavailable');
    expect(provider.supports(EPISODE)).toBe(false);
  });
});

describe('Stremio addon upstream provider', () => {
  it('normalises URL and torrent streams, including seeders and size from labels', async () => {
    const fetchImpl = fakeFetch({
      'https://addon.example/stream/series/tt0944947:1:5.json': () =>
        jsonResponse({
          streams: [
            {
              name: 'Source\n1080p',
              title: 'Show.S01E05.1080p.WEB-DL.x264-GRP\n👤 87 💾 1.2 GB',
              infoHash: 'C'.repeat(40),
              fileIdx: 2,
              sources: ['tracker:udp://tracker.example:1337', 'dht:' + 'c'.repeat(40)],
            },
            { name: 'Direct', description: 'Show S01E05 720p', url: 'https://cdn.example/e5.mp4', behaviorHints: { videoSize: 5e8, filename: 'e5.mp4' } },
            { name: 'YouTube', ytId: 'abc' },
          ],
        }),
    });
    const provider = new StremioAddonUpstreamProvider('upstream-x', 'X', 'https://addon.example/manifest.json', fetchImpl);
    const streams = await provider.findStreams(EPISODE, { signal, metadata: {} });
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({
      seeders: 87,
      sizeBytes: 1_200_000_000,
      resolution: '1080p',
      transport: { kind: 'torrent', infoHash: 'c'.repeat(40), fileIdx: 2, trackers: ['udp://tracker.example:1337'] },
    });
    expect(streams[1]).toMatchObject({ resolution: '720p', sizeBytes: 5e8, filename: 'e5.mp4', seeders: undefined });
  });
});

describe('OpenSubtitles provider', () => {
  it('sends a sorted, documented query and normalises the response', async () => {
    let requested = '';
    let headers: Record<string, string> = {};
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      requested = String(url);
      headers = init?.headers as Record<string, string>;
      return jsonResponse({
        data: [
          {
            id: '1',
            attributes: {
              language: 'hr',
              release: 'Show.S01E05.1080p.WEB-DL',
              download_count: 900,
              moviehash_match: true,
              fps: 23.976,
              files: [{ file_id: 555, file_name: 'show.srt' }],
            },
          },
          { id: '2', attributes: { language: 'en', files: [] } },
        ],
      });
    };
    const provider = new OpenSubtitlesProvider(
      { apiKey: 'KEY', userAgent: 'Test v1', publicUrl: 'http://addon.local' },
      createSilentLogger(),
      fetchImpl,
    );
    const subs = await provider.findSubtitles(
      { media: EPISODE, languages: ['hr', 'en'], file: { videoHash: 'ABCDEF0123456789' } },
      signal,
    );
    expect(requested).toBe(
      'https://api.opensubtitles.com/api/v1/subtitles?episode_number=5&languages=en%2Chr&moviehash=abcdef0123456789&parent_imdb_id=944947&season_number=1',
    );
    expect(headers['Api-Key']).toBe('KEY');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ id: '555', language: 'hr', hashMatch: true, url: 'http://addon.local/subtitles-file/opensubtitles/555.srt' });
  });
});

describe('OpenSubtitles with a per-user key', () => {
  const USER_KEY = 'UserKey1234567890abcdef';
  const searchResult = {
    data: [{ id: '1', attributes: { language: 'hr', release: 'Movie.2020', files: [{ file_id: 777, file_name: 'm.srt' }] } }],
  };

  function recordingFetch() {
    const calls: Array<{ url: string; apiKey: string }> = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, apiKey: (init?.headers as Record<string, string> | undefined)?.['Api-Key'] ?? '' });
      if (u.includes('/subtitles?')) return jsonResponse(searchResult);
      if (u.endsWith('/download')) return jsonResponse({ link: 'https://dl.example/777.srt', remaining: 50 });
      return new Response('1\n00:00:01,000 --> 00:00:02,000\nBok\n');
    };
    return { calls, fetchImpl };
  }

  it('uses the user key for search and keeps it out of the subtitle URL', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const provider = new OpenSubtitlesProvider({ apiKey: 'ServerKey', userAgent: 'T', publicUrl: 'http://a' }, createSilentLogger(), fetchImpl);
    const [sub] = await provider.findSubtitles(
      { media: MOVIE, languages: ['hr'], file: {}, userCredentials: { opensubtitles: USER_KEY } },
      signal,
    );
    expect(calls[0]?.apiKey).toBe(USER_KEY);
    expect(sub?.url).toBe(`http://a/subtitles-file/opensubtitles/777.srt?u=${userKeyToken(USER_KEY)}`);
    expect(sub?.url).not.toContain(USER_KEY);

    // The download resolves the token back to the same user's key.
    await provider.fetchSubtitleFile('777', signal, userKeyToken(USER_KEY));
    expect(calls.find((c) => c.url.endsWith('/download'))?.apiKey).toBe(USER_KEY);
  });

  it('falls back to the server key, and returns nothing when there is no key at all', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const withServerKey = new OpenSubtitlesProvider({ apiKey: 'ServerKey', userAgent: 'T', publicUrl: 'http://a' }, createSilentLogger(), fetchImpl);
    const [sub] = await withServerKey.findSubtitles({ media: MOVIE, languages: ['hr'], file: {} }, signal);
    expect(calls[0]?.apiKey).toBe('ServerKey');
    expect(sub?.url).toBe('http://a/subtitles-file/opensubtitles/777.srt');

    const noKey = new OpenSubtitlesProvider({ userAgent: 'T', publicUrl: 'http://a' }, createSilentLogger(), fetchImpl);
    expect(await noKey.findSubtitles({ media: MOVIE, languages: ['hr'], file: {} }, signal)).toEqual([]);
    await expect(noKey.fetchSubtitleFile('777', signal, 'f'.repeat(24))).rejects.toThrow('no OpenSubtitles API key');
  });
});

describe('Cinemeta metadata', () => {
  it('extracts title, year and runtime', async () => {
    const fetchImpl = fakeFetch({
      'https://v3-cinemeta.strem.io/meta/movie/tt0032138.json': () =>
        jsonResponse({ meta: { name: 'The Wizard of Oz', releaseInfo: '1939', runtime: '102 min' } }),
    });
    expect(await new CinemetaProvider(fetchImpl).getMetadata(MOVIE, signal)).toEqual({
      title: 'The Wizard of Oz',
      year: 1939,
      runtimeMinutes: 102,
    });
  });

  it('parses runtimes in several formats', () => {
    expect(parseRuntimeMinutes('1h 30min')).toBe(90);
    expect(parseRuntimeMinutes('2 h')).toBe(120);
    expect(parseRuntimeMinutes(undefined)).toBeUndefined();
  });
});
