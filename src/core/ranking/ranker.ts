import type { UserPreferences } from '../models/preferences.js';
import type { StreamCandidate, StreamHealth } from '../models/stream.js';
import { CRITERIA, getRankingProfile, type Criterion } from './profiles.js';
import { SCORERS, resolutionIndex, type ScoringContext } from './scorers.js';

const LOW_QUALITY_SOURCES = new Set(['cam', 'telesync', 'screener']);

export interface RankedStream {
  candidate: StreamCandidate;
  /** 0..100 */
  score: number;
  breakdown: Partial<Record<Criterion, number>>;
  /** Human-readable reasons, most important first. */
  reasons: string[];
  warnings: string[];
  /** False when the stream was kept only because nothing matched the user's resolution range. */
  withinPreferences: boolean;
  health?: StreamHealth;
}

export interface RankingSignals {
  health(candidate: StreamCandidate): StreamHealth | undefined;
  reliability(candidate: StreamCandidate): number | undefined;
  historicalThroughputBps(candidate: StreamCandidate): number | undefined;
}

export interface RankingInput {
  prefs: UserPreferences;
  signals: RankingSignals;
  runtimeMinutes?: number;
  isEpisode: boolean;
}

export const NO_SIGNALS: RankingSignals = {
  health: () => undefined,
  reliability: () => undefined,
  historicalThroughputBps: () => undefined,
};

/**
 * Applies the user's hard limits. If the resolution range would remove every stream, the closest
 * streams are kept (and flagged) so the user still gets something to watch.
 */
export function applyPreferenceFilters(
  candidates: StreamCandidate[],
  prefs: UserPreferences,
): { kept: StreamCandidate[]; outOfRange: Set<string> } {
  const quality = prefs.excludeLowQuality
    ? candidates.filter((c) => !LOW_QUALITY_SOURCES.has(c.source))
    : candidates;

  const minIdx = resolutionIndex(prefs.minResolution);
  const maxIdx = resolutionIndex(prefs.maxResolution);
  const inRange = (c: StreamCandidate): boolean => {
    const idx = resolutionIndex(c.resolution);
    return idx === -1 || (idx >= minIdx && idx <= maxIdx);
  };

  const kept = quality.filter(inRange);
  if (kept.length > 0 || quality.length === 0) return { kept, outOfRange: new Set() };

  // Nothing in range: keep the streams whose resolution is closest to the allowed range.
  const distance = (c: StreamCandidate): number => {
    const idx = resolutionIndex(c.resolution);
    return idx < minIdx ? minIdx - idx : idx - maxIdx;
  };
  const best = Math.min(...quality.map(distance));
  const fallback = quality.filter((c) => distance(c) === best);
  return { kept: fallback, outOfRange: new Set(fallback.map((c) => c.id)) };
}

export function scoreCandidate(candidate: StreamCandidate, input: RankingInput): RankedStream {
  const profile = getRankingProfile(input.prefs.rankingProfile);
  const health = input.signals.health(candidate);
  const ctx: ScoringContext = {
    prefs: input.prefs,
    profile,
    health,
    reliability: input.signals.reliability(candidate),
    historicalThroughputBps: input.signals.historicalThroughputBps(candidate),
    runtimeMinutes: input.runtimeMinutes,
    isEpisode: input.isEpisode,
  };

  let weighted = 0;
  let totalWeight = 0;
  const breakdown: Partial<Record<Criterion, number>> = {};
  const contributions: Array<{ reason: string; value: number }> = [];
  const warnings: string[] = [];

  for (const criterion of CRITERIA) {
    const weight = profile.weights[criterion];
    const result = SCORERS[criterion](candidate, ctx);
    if (result.warning) warnings.push(result.warning);
    if (result.score === null || weight <= 0) continue;
    breakdown[criterion] = Math.round(result.score * 100) / 100;
    weighted += weight * result.score;
    totalWeight += weight;
    if (result.reason) contributions.push({ reason: result.reason, value: weight * result.score });
  }

  let score = totalWeight > 0 ? (weighted / totalWeight) * 100 : 0;
  // A link that failed its test sinks below everything that did not, but stays as a last resort.
  if (health?.status === 'failed') score *= 0.25;

  return {
    candidate,
    score: Math.round(score * 10) / 10,
    breakdown,
    reasons: contributions.sort((a, b) => b.value - a.value).map((c) => c.reason),
    warnings,
    withinPreferences: true,
    health,
  };
}

/** Ranks candidates best-first. Pure function: no I/O, deterministic for the same input. */
export function rankStreams(candidates: StreamCandidate[], input: RankingInput): RankedStream[] {
  const { kept, outOfRange } = applyPreferenceFilters(candidates, input.prefs);
  const ranked = kept.map((c) => {
    const r = scoreCandidate(c, input);
    if (outOfRange.has(c.id)) {
      r.withinPreferences = false;
      r.warnings.unshift('shown because nothing matched your resolution range');
    }
    return r;
  });

  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const seedDiff = (b.candidate.seeders ?? -1) - (a.candidate.seeders ?? -1);
    if (seedDiff !== 0) return seedDiff;
    const sizeA = a.candidate.sizeBytes ?? Number.MAX_SAFE_INTEGER;
    const sizeB = b.candidate.sizeBytes ?? Number.MAX_SAFE_INTEGER;
    if (sizeA !== sizeB) return input.prefs.preferSmallerFiles ? sizeA - sizeB : sizeB - sizeA;
    return a.candidate.id.localeCompare(b.candidate.id);
  });
}
