import { describe, expect, it } from 'vitest';
import type { StreamCandidate, StreamHealth } from '../../src/core/models/stream.js';
import { NO_SIGNALS, applyPreferenceFilters, rankStreams, type RankingSignals } from '../../src/core/ranking/ranker.js';
import { scoreSeeders } from '../../src/core/ranking/scorers.js';
import { RANKING_PROFILE_DEFINITIONS } from '../../src/core/ranking/profiles.js';
import { makeCandidate, prefs, torrentTransport } from '../helpers/factories.js';

function rank(candidates: StreamCandidate[], overrides = {}, signals: Partial<RankingSignals> = {}) {
  return rankStreams(candidates, {
    prefs: prefs(overrides),
    signals: { ...NO_SIGNALS, ...signals },
    isEpisode: false,
    runtimeMinutes: 120,
  });
}

const ctx = { prefs: prefs(), profile: RANKING_PROFILE_DEFINITIONS['best-overall'], isEpisode: false };

describe('seeder scoring', () => {
  it('is logarithmic and saturates at 200 seeders', () => {
    const score = (seeders: number) => scoreSeeders(makeCandidate({ transport: torrentTransport(), seeders }), ctx).score;
    expect(score(0)).toBe(0);
    expect(score(20)).toBeLessThan(score(200) as number);
    expect(score(200)).toBe(1);
    expect(score(2000)).toBe(1);
  });

  it('does not apply to HTTP streams', () => {
    expect(scoreSeeders(makeCandidate(), ctx).score).toBeNull();
  });
});

describe('stream ranking', () => {
  it('returns streams ordered best to worst', () => {
    const ranked = rank([
      makeCandidate({ id: 'a', resolution: '480p' }),
      makeCandidate({ id: 'b', resolution: '1080p' }),
      makeCandidate({ id: 'c', resolution: '720p' }),
    ], { minResolution: '480p' });
    expect(ranked.map((r) => r.candidate.id)).toEqual(['b', 'c', 'a']);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  it('ranks 200 seeders with good measured speed above 2,000 seeders with poor speed', () => {
    const crowded = makeCandidate({ id: 'crowded', transport: torrentTransport(1), seeders: 2000 });
    const fast = makeCandidate({ id: 'fast', transport: torrentTransport(2), seeders: 200 });
    const throughput: Record<string, number> = { crowded: 60_000, fast: 6_000_000 };
    const reliability: Record<string, number> = { crowded: 0.3, fast: 0.9 };

    const ranked = rank([crowded, fast], {}, {
      historicalThroughputBps: (c) => throughput[c.id],
      reliability: (c) => reliability[c.id],
    });
    expect(ranked[0]?.candidate.id).toBe('fast');
  });

  it('never treats an untested source as verified, however many seeders it reports', () => {
    const torrent = makeCandidate({ id: 't', transport: torrentTransport(), seeders: 5000 });
    const [ranked] = rank([torrent]);
    expect(ranked?.breakdown.availability).toBeLessThanOrEqual(0.6);
    expect(ranked?.warnings.join(' ')).toContain('not verified');
  });

  it('puts a verified link above an unverified one with otherwise equal data', () => {
    const verified = makeCandidate({ id: 'v' });
    const unknown = makeCandidate({ id: 'u' });
    const health: StreamHealth = { status: 'verified', ttfbMs: 150, throughputBps: 5e6, checkedAt: Date.now() };
    const ranked = rank([unknown, verified], {}, { health: (c) => (c.id === 'v' ? health : undefined) });
    expect(ranked[0]?.candidate.id).toBe('v');
    expect(ranked[0]?.reasons.join(' ')).toContain('test request');
  });

  it('sinks links that failed their test to the bottom but keeps them as a last resort', () => {
    const failed = makeCandidate({ id: 'f', resolution: '1080p' });
    const fine = makeCandidate({ id: 'ok', resolution: '720p' });
    const ranked = rank([failed, fine], {}, {
      health: (c) => (c.id === 'f' ? { status: 'failed', detail: 'HTTP 404', checkedAt: Date.now() } : undefined),
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual(['ok', 'f']);
    expect(ranked[1]?.warnings[0]).toContain('HTTP 404');
  });

  it('explains why the first stream is ranked first', () => {
    const [top] = rank([makeCandidate()]);
    expect(top?.reasons).toContain('1080p matches your preferred resolution');
  });
});

describe('resolution preferences', () => {
  it('prefers the configured resolution over higher ones in Best Overall', () => {
    const ranked = rank([makeCandidate({ id: '4k', resolution: '2160p', sizeBytes: 20e9 }), makeCandidate({ id: 'fhd' })]);
    expect(ranked[0]?.candidate.id).toBe('fhd');
  });

  it('prefers the highest allowed resolution in Best Quality', () => {
    const ranked = rank(
      [makeCandidate({ id: '4k', resolution: '2160p', sizeBytes: 20e9, source: 'bluray' }), makeCandidate({ id: 'fhd' })],
      { rankingProfile: 'best-quality' },
    );
    expect(ranked[0]?.candidate.id).toBe('4k');
  });

  it('removes streams outside the min/max range', () => {
    const ranked = rank([makeCandidate({ id: 'sd', resolution: '480p' }), makeCandidate({ id: 'hd' })], { minResolution: '720p' });
    expect(ranked.map((r) => r.candidate.id)).toEqual(['hd']);
  });

  it('falls back to the closest resolution when nothing is in range, and says so', () => {
    const ranked = rank([makeCandidate({ id: 'sd', resolution: '480p' }), makeCandidate({ id: 'low', resolution: '360p' })], {
      minResolution: '720p',
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual(['sd']);
    expect(ranked[0]?.withinPreferences).toBe(false);
    expect(ranked[0]?.warnings[0]).toContain('nothing matched');
  });

  it('keeps streams with unknown resolution', () => {
    const { kept } = applyPreferenceFilters([makeCandidate({ resolution: 'unknown' })], prefs());
    expect(kept).toHaveLength(1);
  });
});

describe('file size preferences', () => {
  it('prefers the smaller of two reasonable 1080p files when preferSmallerFiles is on', () => {
    const ranked = rank([makeCandidate({ id: 'big', sizeBytes: 12e9 }), makeCandidate({ id: 'small', sizeBytes: 4e9 })]);
    expect(ranked[0]?.candidate.id).toBe('small');
  });

  it('penalises files that are implausibly small for their resolution', () => {
    const ranked = rank([makeCandidate({ id: 'tiny', sizeBytes: 300e6 }), makeCandidate({ id: 'normal', sizeBytes: 4e9 })]);
    expect(ranked[0]?.candidate.id).toBe('normal');
    expect(ranked[1]?.warnings.join(' ')).toContain('unusually small');
  });

  it('chooses the most compact file with Lowest Bandwidth', () => {
    const ranked = rank(
      [makeCandidate({ id: 'fhd', sizeBytes: 6e9 }), makeCandidate({ id: 'hd', resolution: '720p', sizeBytes: 1.5e9 })],
      { rankingProfile: 'lowest-bandwidth' },
    );
    expect(ranked[0]?.candidate.id).toBe('hd');
  });
});

describe('quality filters and codecs', () => {
  it('excludes CAM and telesync releases by default', () => {
    const ranked = rank([makeCandidate({ id: 'cam', source: 'cam' }), makeCandidate({ id: 'web' })]);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['web']);
  });

  it('keeps them when the user disables the filter', () => {
    const ranked = rank([makeCandidate({ id: 'cam', source: 'cam' })], { excludeLowQuality: false });
    expect(ranked).toHaveLength(1);
  });

  it('prefers compatible audio when asked', () => {
    const ranked = rank([
      makeCandidate({ id: 'dts', audioCodecs: ['dts'] }),
      makeCandidate({ id: 'aac', audioCodecs: ['aac'] }),
    ]);
    expect(ranked[0]?.candidate.id).toBe('aac');
    expect(ranked[1]?.warnings.join(' ')).toContain('DTS');
  });
});
