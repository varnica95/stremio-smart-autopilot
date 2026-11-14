import type { UserPreferences } from '../models/preferences.js';
import {
  RESOLUTION_ORDER,
  type AudioCodec,
  type Resolution,
  type ReleaseSource,
  type StreamCandidate,
  type StreamHealth,
  type VideoCodec,
} from '../models/stream.js';
import { formatBytes, formatRate } from '../../utils/format.js';
import type { Criterion, RankingProfile } from './profiles.js';

export interface ScoringContext {
  prefs: UserPreferences;
  profile: RankingProfile;
  health?: StreamHealth;
  /** Time-decayed success history (0..1) for this stream/host/provider, if any exists. */
  reliability?: number;
  /** Throughput observed during earlier real playback (companion) or probes. */
  historicalThroughputBps?: number;
  runtimeMinutes?: number;
  isEpisode: boolean;
}

/** score: 0..1, or null when the criterion does not apply / has no data for this stream. */
export interface CriterionResult {
  score: number | null;
  reason?: string;
  warning?: string;
}

export type Scorer = (candidate: StreamCandidate, ctx: ScoringContext) => CriterionResult;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function resolutionIndex(res: Resolution): number {
  return res === 'unknown' ? -1 : RESOLUTION_ORDER.indexOf(res);
}

/** Typical bitrate bands (Mbit/s) for reasonable encodes at each resolution. */
const BITRATE_BANDS_MBPS: Record<Resolution, { min: number; max: number }> = {
  '360p': { min: 0.4, max: 1.5 },
  '480p': { min: 0.7, max: 2.5 },
  '576p': { min: 1, max: 3.5 },
  '720p': { min: 1.5, max: 6 },
  '1080p': { min: 3, max: 15 },
  '1440p': { min: 6, max: 25 },
  '2160p': { min: 12, max: 60 },
  unknown: { min: 1.5, max: 15 },
};

/** Nominal bitrate needed for smooth playback when the file size is unknown. */
const NOMINAL_BITRATE_MBPS: Record<Resolution, number> = {
  '360p': 1,
  '480p': 1.5,
  '576p': 2,
  '720p': 3.5,
  '1080p': 7,
  '1440p': 12,
  '2160p': 22,
  unknown: 7,
};

export function effectiveRuntimeMinutes(ctx: ScoringContext): number {
  if (ctx.runtimeMinutes && ctx.runtimeMinutes > 0) return ctx.runtimeMinutes;
  return ctx.isEpisode ? 45 : 110;
}

/** Average bitrate of the file in Mbit/s, if the size is known. */
export function averageBitrateMbps(candidate: StreamCandidate, ctx: ScoringContext): number | undefined {
  if (!candidate.sizeBytes || candidate.sizeBytes <= 0) return undefined;
  return (candidate.sizeBytes * 8) / (effectiveRuntimeMinutes(ctx) * 60) / 1e6;
}

export const scoreAvailability: Scorer = (candidate, ctx) => {
  const health = ctx.health;
  let base: number;
  let reason: string | undefined;
  let warning: string | undefined;

  if (health?.status === 'verified') {
    base = 1;
    reason =
      health.ttfbMs !== undefined
        ? `link answered a test request (${Math.round(health.ttfbMs)} ms)`
        : 'link answered a test request';
  } else if (health?.status === 'failed') {
    base = 0;
    warning = `link failed a test request${health.detail ? ` (${health.detail})` : ''}`;
  } else if (candidate.transport.kind === 'torrent') {
    const seeders = candidate.seeders;
    if (seeders === 0) {
      base = 0.05;
      warning = 'provider reports 0 seeders';
    } else if (seeders === undefined) {
      base = 0.35;
      warning = 'not verified: no peer information';
    } else {
      // Seeders raise expectations a little, but never to "verified" level.
      base = 0.4 + 0.2 * clamp01(Math.log10(seeders + 1) / Math.log10(101));
      warning = 'not verified: peer counts are reported by the provider';
    }
  } else {
    base = 0.5;
    warning = 'not verified: not tested before listing';
  }

  if (ctx.reliability === undefined) return { score: base, reason, warning };

  const score = 0.65 * base + 0.35 * ctx.reliability;
  if (ctx.reliability < 0.35) warning = warning ? `${warning}; failed recently` : 'failed recently';
  else if (ctx.reliability > 0.75 && !reason) reason = 'worked reliably in recent use';
  return { score, reason, warning };
};

export const scoreResolution: Scorer = (candidate, ctx) => {
  const res = candidate.resolution;
  if (res === 'unknown') return { score: 0.4, warning: 'resolution unknown' };

  const idx = resolutionIndex(res);
  const minIdx = resolutionIndex(ctx.prefs.minResolution);
  const maxIdx = resolutionIndex(ctx.prefs.maxResolution);
  const prefIdx = resolutionIndex(ctx.prefs.preferredResolution);
  const span = Math.max(1, maxIdx - minIdx);

  let score: number;
  let reason: string | undefined;
  switch (ctx.profile.resolutionMode) {
    case 'highest':
      score = clamp01(0.4 + (0.6 * (idx - minIdx)) / span);
      if (idx === maxIdx) reason = `${res} is the highest resolution you allow`;
      break;
    case 'lowest':
      score = clamp01(0.4 + (0.6 * (maxIdx - idx)) / span);
      if (idx === minIdx) reason = `${res} keeps bandwidth low`;
      break;
    default: {
      const distance = idx - prefIdx;
      // Going above the preference costs less than going below it.
      score = clamp01(1 - (distance > 0 ? 0.2 : 0.3) * Math.abs(distance));
      if (distance === 0) reason = `${res} matches your preferred resolution`;
    }
  }

  if (idx < minIdx || idx > maxIdx) {
    return { score: score * 0.3, warning: `${res} is outside your allowed range` };
  }
  return { score, reason };
};

export const scoreSpeed: Scorer = (candidate, ctx) => {
  const throughput = ctx.health?.throughputBps ?? ctx.historicalThroughputBps;
  if (!throughput || throughput <= 0) return { score: null };

  const neededMbps = averageBitrateMbps(candidate, ctx) ?? NOMINAL_BITRATE_MBPS[candidate.resolution];
  const ratio = (throughput * 8) / (neededMbps * 1e6);
  let score = clamp01(ratio / 2);

  const ttfb = ctx.health?.ttfbMs;
  if (ttfb !== undefined && ttfb > 400) score *= ttfb >= 3000 ? 0.6 : 1 - (0.4 * (ttfb - 400)) / 2600;

  if (ratio < 1) {
    return { score, warning: `measured ${formatRate(throughput)} is below this file's bitrate; buffering likely` };
  }
  return {
    score,
    reason: ratio >= 2 ? `measured ${formatRate(throughput)}, well above the bitrate needed` : undefined,
  };
};

export const scoreSeeders: Scorer = (candidate) => {
  if (candidate.transport.kind !== 'torrent') return { score: null };
  const seeders = candidate.seeders;
  if (seeders === undefined) return { score: 0.3 };
  // Logarithmic and saturating: 200 seeders already scores 1.0, so 2,000 gives no extra advantage.
  const score = clamp01(Math.log10(seeders + 1) / Math.log10(201));
  return {
    score,
    reason: score >= 0.8 ? `${seeders} seeders reported by the provider` : undefined,
    warning: seeders < 5 ? `only ${seeders} seeders reported` : undefined,
  };
};

export const scoreSize: Scorer = (candidate, ctx) => {
  const mbps = averageBitrateMbps(candidate, ctx);
  if (mbps === undefined || !candidate.sizeBytes) return { score: null };
  const band = BITRATE_BANDS_MBPS[candidate.resolution];
  const sizeLabel = formatBytes(candidate.sizeBytes);

  if (mbps < band.min * 0.5) {
    return { score: 0.15, warning: `${sizeLabel} is unusually small for ${candidate.resolution}; may be low quality or mislabeled` };
  }

  const position = clamp01((mbps - band.min) / (band.max - band.min));
  switch (ctx.profile.sizeMode) {
    case 'smallest':
      return { score: clamp01(1 - mbps / 25) * 0.9 + 0.1, reason: mbps < band.max ? `compact file (${sizeLabel})` : undefined };
    case 'quality':
      if (mbps < band.min) return { score: 0.4 };
      return { score: mbps > band.max ? 1 : 0.7 + 0.3 * position, reason: `high bitrate for ${candidate.resolution} (${sizeLabel})` };
    default: {
      if (mbps < band.min) return { score: 0.6 };
      if (mbps > band.max) return { score: Math.max(0.3, 1 - 0.5 * (mbps / band.max - 1)) };
      const score = ctx.prefs.preferSmallerFiles ? 1 - 0.3 * position : 1;
      return { score, reason: `efficient size for ${candidate.resolution} (${sizeLabel})` };
    }
  }
};

const VIDEO_COMPAT: Record<VideoCodec, number> = {
  h264: 1,
  hevc: 0.8,
  vp9: 0.7,
  av1: 0.65,
  mpeg2: 0.5,
  xvid: 0.4,
  unknown: 0.6,
};
const VIDEO_EFFICIENCY: Record<VideoCodec, number> = {
  av1: 1,
  hevc: 0.95,
  vp9: 0.85,
  h264: 0.7,
  mpeg2: 0.3,
  xvid: 0.3,
  unknown: 0.5,
};

export const scoreVideoCodec: Scorer = (candidate, ctx) => {
  const codec = candidate.videoCodec;
  if (ctx.profile.id === 'lowest-bandwidth') return { score: VIDEO_EFFICIENCY[codec] };
  const score = VIDEO_COMPAT[codec];
  if (codec === 'h264') return { score, reason: 'H.264 plays on virtually every device' };
  if (codec === 'av1') return { score, warning: 'AV1 needs a recent device for smooth playback' };
  return { score };
};

const AUDIO_COMPAT: Record<AudioCodec, number> = {
  aac: 1,
  ac3: 1,
  eac3: 0.95,
  mp3: 1,
  opus: 0.9,
  flac: 0.8,
  dts: 0.55,
  'dts-hd': 0.5,
  truehd: 0.45,
  unknown: 0.7,
};

export const scoreAudioCodec: Scorer = (candidate, ctx) => {
  if (!ctx.prefs.preferCompatibleAudio) return { score: null };
  if (candidate.audioCodecs.length === 0) return { score: AUDIO_COMPAT.unknown };
  const best = Math.max(...candidate.audioCodecs.map((c) => AUDIO_COMPAT[c]));
  if (best < 0.6) {
    return { score: best, warning: 'DTS/TrueHD audio can be silent on some TVs, phones and browsers' };
  }
  return { score: best };
};

const RELEASE_QUALITY: Record<ReleaseSource, number> = {
  remux: 1,
  bluray: 0.95,
  'web-dl': 0.9,
  webrip: 0.8,
  hdtv: 0.6,
  dvdrip: 0.5,
  screener: 0.2,
  telesync: 0.1,
  cam: 0,
  unknown: 0.6,
};
const RELEASE_LABEL: Partial<Record<ReleaseSource, string>> = {
  remux: 'Blu-ray remux',
  bluray: 'Blu-ray source',
  'web-dl': 'WEB-DL source',
};

export const scoreReleaseQuality: Scorer = (candidate) => {
  const score = RELEASE_QUALITY[candidate.source];
  const label = RELEASE_LABEL[candidate.source];
  return {
    score,
    reason: label,
    warning: score <= 0.2 ? `low-quality ${candidate.source} release` : undefined,
  };
};

export const SCORERS: Record<Criterion, Scorer> = {
  availability: scoreAvailability,
  resolution: scoreResolution,
  speed: scoreSpeed,
  seeders: scoreSeeders,
  size: scoreSize,
  videoCodec: scoreVideoCodec,
  audioCodec: scoreAudioCodec,
  releaseQuality: scoreReleaseQuality,
};
