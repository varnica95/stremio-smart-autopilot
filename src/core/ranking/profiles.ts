import type { RankingProfileId } from '../models/preferences.js';

export const CRITERIA = [
  'availability',
  'resolution',
  'speed',
  'seeders',
  'size',
  'videoCodec',
  'audioCodec',
  'releaseQuality',
] as const;
export type Criterion = (typeof CRITERIA)[number];

export type ResolutionMode = 'prefer' | 'highest' | 'lowest';
export type SizeMode = 'efficient' | 'quality' | 'smallest';

export interface RankingProfile {
  id: RankingProfileId;
  label: string;
  weights: Record<Criterion, number>;
  /** How to treat resolution inside the user's allowed range. */
  resolutionMode: ResolutionMode;
  /** How to treat file size for a given resolution. */
  sizeMode: SizeMode;
}

/**
 * Weights are relative, not percentages. "Very high" ≈ 9-10, "High" ≈ 6-7, "Medium" ≈ 3-5.
 * Criteria without data for a stream (e.g. seeders for an HTTP link) are left out of that stream's
 * weighted average instead of counting as zero.
 */
export const RANKING_PROFILE_DEFINITIONS: Record<RankingProfileId, RankingProfile> = {
  'best-overall': {
    id: 'best-overall',
    label: 'Best Overall',
    weights: {
      availability: 10,
      resolution: 9,
      speed: 9,
      seeders: 6,
      size: 4,
      videoCodec: 4,
      audioCodec: 4,
      releaseQuality: 4,
    },
    resolutionMode: 'prefer',
    sizeMode: 'efficient',
  },
  'best-quality': {
    id: 'best-quality',
    label: 'Best Quality',
    weights: {
      availability: 8,
      resolution: 10,
      speed: 5,
      seeders: 4,
      size: 3,
      videoCodec: 3,
      audioCodec: 4,
      releaseQuality: 9,
    },
    resolutionMode: 'highest',
    sizeMode: 'quality',
  },
  'fastest-start': {
    id: 'fastest-start',
    label: 'Fastest Start',
    weights: {
      availability: 10,
      resolution: 4,
      speed: 10,
      seeders: 8,
      size: 6,
      videoCodec: 6,
      audioCodec: 5,
      releaseQuality: 2,
    },
    resolutionMode: 'prefer',
    sizeMode: 'smallest',
  },
  'lowest-bandwidth': {
    id: 'lowest-bandwidth',
    label: 'Lowest Bandwidth',
    weights: {
      availability: 9,
      resolution: 6,
      speed: 5,
      seeders: 5,
      size: 10,
      videoCodec: 5,
      audioCodec: 3,
      releaseQuality: 2,
    },
    resolutionMode: 'lowest',
    sizeMode: 'smallest',
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    weights: {
      availability: 8,
      resolution: 6,
      speed: 6,
      seeders: 5,
      size: 5,
      videoCodec: 5,
      audioCodec: 5,
      releaseQuality: 5,
    },
    resolutionMode: 'prefer',
    sizeMode: 'efficient',
  },
};

export function getRankingProfile(id: RankingProfileId): RankingProfile {
  return RANKING_PROFILE_DEFINITIONS[id];
}
