import { z } from 'zod';
import {
  RANKING_PROFILES,
  SELECTABLE_RESOLUTIONS,
  type SelectableResolution,
  type UserPreferences,
} from '../core/models/preferences.js';

const languageCode = z.string().regex(/^([a-z]{2}|original)$/, 'use ISO 639-1 codes (e.g. "hr") or "original"');

export const UserPreferencesSchema = z.object({
  subtitleLanguages: z.array(languageCode).min(1).max(6).default(['hr', 'en', 'original']),
  preferredResolution: z.enum(SELECTABLE_RESOLUTIONS).default('1080p'),
  minResolution: z.enum(SELECTABLE_RESOLUTIONS).default('720p'),
  maxResolution: z.enum(SELECTABLE_RESOLUTIONS).default('2160p'),
  rankingProfile: z.enum(RANKING_PROFILES).default('best-overall'),
  preferSmallerFiles: z.boolean().default(true),
  preferCompatibleAudio: z.boolean().default(true),
  excludeLowQuality: z.boolean().default(true),
  maxResults: z.number().int().min(1).max(50).default(10),
  maxSubtitlesPerLanguage: z.number().int().min(1).max(20).default(3),
});

export const DEFAULT_PREFERENCES: UserPreferences = UserPreferencesSchema.parse({});

const BOOLEAN_KEYS = new Set(['preferSmallerFiles', 'preferCompatibleAudio', 'excludeLowQuality']);
const NUMBER_KEYS = new Set(['maxResults', 'maxSubtitlesPerLanguage']);
const KNOWN_KEYS = new Set(Object.keys(DEFAULT_PREFERENCES));

/**
 * Accepts the loosely-typed values that arrive from the addon URL or form posts
 * ("true"/"on", "10", "hr,en") and converts them to the schema's types.
 * Unknown keys are dropped.
 */
export function normalizeRawPreferences(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key) || value === undefined || value === null || value === '') continue;
    if (BOOLEAN_KEYS.has(key) && typeof value === 'string') {
      out[key] = ['true', 'on', '1', 'yes', 'checked'].includes(value.toLowerCase());
    } else if (NUMBER_KEYS.has(key) && typeof value === 'string') {
      out[key] = Number(value);
    } else if (key === 'subtitleLanguages' && typeof value === 'string') {
      out[key] = value
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (key === 'subtitleLanguages' && Array.isArray(value)) {
      out[key] = value.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const order = (r: SelectableResolution): number => SELECTABLE_RESOLUTIONS.indexOf(r);

/** Makes min ≤ preferred ≤ max and removes duplicate languages. */
function harmonize(prefs: UserPreferences): UserPreferences {
  let { minResolution, maxResolution, preferredResolution } = prefs;
  if (order(minResolution) > order(maxResolution)) [minResolution, maxResolution] = [maxResolution, minResolution];
  if (order(preferredResolution) < order(minResolution)) preferredResolution = minResolution;
  if (order(preferredResolution) > order(maxResolution)) preferredResolution = maxResolution;
  return {
    ...prefs,
    minResolution,
    maxResolution,
    preferredResolution,
    subtitleLanguages: [...new Set(prefs.subtitleLanguages)],
  };
}

export interface ParsedPreferences {
  prefs: UserPreferences;
  /** Validation problems; invalid fields fall back to defaults instead of failing the request. */
  issues: string[];
}

/** Turns untrusted user configuration into complete, valid preferences. Never throws. */
export function parsePreferences(raw: unknown, defaults: UserPreferences = DEFAULT_PREFERENCES): ParsedPreferences {
  const normalized = normalizeRawPreferences(raw);
  const issues: string[] = [];
  const merged: Record<string, unknown> = { ...defaults };

  for (const [key, value] of Object.entries(normalized)) {
    const candidate = { ...merged, [key]: value };
    const result = UserPreferencesSchema.safeParse(candidate);
    if (result.success) merged[key] = value;
    else issues.push(`${key}: ${result.error.issues[0]?.message ?? 'invalid value'}`);
  }

  const final = UserPreferencesSchema.safeParse(merged);
  return { prefs: harmonize(final.success ? final.data : defaults), issues };
}

/** Encodes preferences for the addon URL path segment that the Stremio SDK decodes with JSON.parse. */
export function encodePreferencesForUrl(prefs: Partial<UserPreferences>): string {
  return encodeURIComponent(JSON.stringify(prefs));
}
