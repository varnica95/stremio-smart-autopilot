import { describe, expect, it } from 'vitest';
import { dedupeCandidates, normalizeUrl, transportKey } from '../../src/core/dedupe.js';
import { makeCandidate } from '../helpers/factories.js';

describe('duplicate detection', () => {
  it('treats the same info hash and file as one source regardless of letter case', () => {
    const a = makeCandidate({ providerId: 'p1', providerName: 'P1', transport: { kind: 'torrent', infoHash: 'ABCDEF'.padEnd(40, '0'), fileIdx: 1 }, seeders: 10 });
    const b = makeCandidate({ providerId: 'p2', providerName: 'P2', transport: { kind: 'torrent', infoHash: 'abcdef'.padEnd(40, '0'), fileIdx: 1 }, seeders: 50 });
    const out = dedupeCandidates([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.seeders).toBe(50);
    expect(out[0]?.alsoFrom).toEqual(['P2']);
  });

  it('keeps different files of the same torrent apart', () => {
    const hash = 'b'.repeat(40);
    const out = dedupeCandidates([
      makeCandidate({ transport: { kind: 'torrent', infoHash: hash, fileIdx: 0 } }),
      makeCandidate({ transport: { kind: 'torrent', infoHash: hash, fileIdx: 1 } }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('normalises URLs before comparing them', () => {
    expect(normalizeUrl('https://CDN.example.org:443/a/b/?y=2&x=1#frag')).toBe('https://cdn.example.org/a/b?x=1&y=2');
    expect(transportKey({ kind: 'http', url: 'https://cdn.example.org/a.mp4' })).toBe(
      transportKey({ kind: 'http', url: 'https://CDN.example.org/a.mp4#t=10' }),
    );
  });

  it('merges mirrors of an identical file and keeps the other URL as a fallback', () => {
    const a = makeCandidate({ transport: { kind: 'http', url: 'https://one.example/x.mkv' }, filename: 'X.mkv', sizeBytes: 1234 });
    const b = makeCandidate({ transport: { kind: 'http', url: 'https://two.example/x.mkv' }, filename: 'x.mkv', sizeBytes: 1234 });
    const out = dedupeCandidates([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.mirrors).toEqual([{ kind: 'http', url: 'https://two.example/x.mkv' }]);
  });

  it('keeps files with the same name but different sizes', () => {
    const out = dedupeCandidates([
      makeCandidate({ filename: 'x.mkv', sizeBytes: 1 }),
      makeCandidate({ filename: 'x.mkv', sizeBytes: 2 }),
    ]);
    expect(out).toHaveLength(2);
  });
});
