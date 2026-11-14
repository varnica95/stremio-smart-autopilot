import { describe, expect, it } from 'vitest';
import { NO_SIGNALS, rankStreams } from '../../src/core/ranking/ranker.js';
import { formatStreams } from '../../src/stremio/formatters/stream-formatter.js';
import { makeCandidate, prefs, torrentTransport } from '../helpers/factories.js';

function format(candidates = [makeCandidate()]) {
  const ranked = rankStreams(candidates, { prefs: prefs(), signals: NO_SIGNALS, isEpisode: false });
  return formatStreams(ranked, { profile: 'best-overall', now: Date.now() });
}

/** Fields allowed on a Stremio stream object by the addon protocol. */
const STREAM_KEYS = new Set(['url', 'ytId', 'infoHash', 'fileIdx', 'externalUrl', 'name', 'title', 'description', 'subtitles', 'sources', 'behaviorHints']);
const HINT_KEYS = new Set(['countryWhitelist', 'notWebReady', 'bingeGroup', 'proxyHeaders', 'videoHash', 'videoSize', 'filename']);

describe('Stremio stream formatting', () => {
  it('produces protocol-compliant objects with exactly one source', () => {
    const streams = format([
      makeCandidate({ id: 'h' }),
      makeCandidate({ id: 't', transport: torrentTransport(), seeders: 10 }),
      makeCandidate({ id: 'e', transport: { kind: 'external', url: 'https://example.org/watch' } }),
    ]);
    for (const s of streams) {
      for (const key of Object.keys(s)) expect(STREAM_KEYS.has(key)).toBe(true);
      for (const key of Object.keys(s.behaviorHints ?? {})) expect(HINT_KEYS.has(key)).toBe(true);
      const sources = [s.url, s.infoHash, s.externalUrl, s.ytId].filter(Boolean);
      expect(sources).toHaveLength(1);
      expect(typeof s.name).toBe('string');
      expect(typeof s.description).toBe('string');
    }
  });

  it('labels the top stream and explains the ranking', () => {
    const [top] = format();
    expect(top?.name).toContain('⭐');
    expect(top?.name).toContain('1080p');
    expect(top?.description).toContain('Ranked first (Best Overall)');
    expect(top?.description).toContain('Not tested');
  });

  it('describes reported seeders as unverified', () => {
    const [s] = format([makeCandidate({ transport: torrentTransport(), seeders: 42 })]);
    expect(s?.description).toContain('42 seeders (reported, unverified)');
    expect(s?.sources?.at(-1)).toMatch(/^dht:/);
    expect(s?.fileIdx).toBe(0);
  });

  it('marks non-MP4/H.264 HTTP files as not web-ready and sets a binge group', () => {
    const [s] = format([makeCandidate({ videoCodec: 'hevc', filename: 'x.mkv' })]);
    expect(s?.behaviorHints?.notWebReady).toBe(true);
    expect(s?.behaviorHints?.bingeGroup).toContain('autopilot|test|1080p');
  });

  it('passes required request headers through proxyHeaders', () => {
    const [s] = format([makeCandidate({ transport: { kind: 'http', url: 'https://x.example/a.mp4', requestHeaders: { Referer: 'https://x.example' } } })]);
    expect(s?.behaviorHints?.proxyHeaders).toEqual({ request: { Referer: 'https://x.example' } });
    expect(s?.behaviorHints?.notWebReady).toBe(true);
  });

  it('serialises to plain JSON', () => {
    const streams = format();
    expect(JSON.parse(JSON.stringify(streams))).toEqual(streams);
  });
});
