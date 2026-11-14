import type { KnownResolution } from './stream.js';

export const RANKING_PROFILES = [
  'best-overall',
  'best-quality',
  'fastest-start',
  'lowest-bandwidth',
  'balanced',
] as const;
export type RankingProfileId = (typeof RANKING_PROFILES)[number];

export const SELECTABLE_RESOLUTIONS = ['480p', '720p', '1080p', '2160p'] as const;
export type SelectableResolution = (typeof SELECTABLE_RESOLUTIONS)[number] & KnownResolution;

/** Per-user settings. Validated by config/preferences.ts; plain data here so core stays framework-free. */
export interface UserPreferences {
  /** ISO 639-1 codes in priority order; the special value "original" means the title's original language. */
  subtitleLanguages: string[];
  preferredResolution: SelectableResolution;
  minResolution: SelectableResolution;
  maxResolution: SelectableResolution;
  rankingProfile: RankingProfileId;
  preferSmallerFiles: boolean;
  preferCompatibleAudio: boolean;
  excludeLowQuality: boolean;
  maxResults: number;
  maxSubtitlesPerLanguage: number;
}
