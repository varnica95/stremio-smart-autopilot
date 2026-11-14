import { z } from 'zod';
import type { UserPreferences } from '../core/models/preferences.js';
import { DEFAULT_PREFERENCES, parsePreferences } from './preferences.js';

const UpstreamAddonSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(60),
  /** Base URL of a Stremio addon you are authorized to use (without /manifest.json). */
  url: z.string().url(),
});
export type UpstreamAddonConfig = z.infer<typeof UpstreamAddonSchema>;

const ServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
  publicUrl: z.string().url(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  databasePath: z.string(),
  providerTimeoutMs: z.number().int().min(500).max(30_000),
  enabledStreamProviders: z.array(z.string()),
  probe: z.object({
    enabled: z.boolean(),
    timeoutMs: z.number().int().min(300).max(15_000),
    maxStreams: z.number().int().min(0).max(20),
    bytes: z.number().int().min(16_384).max(8_388_608),
  }),
  cacheTtl: z.object({
    discoveryMs: z.number().int().min(0),
    healthMs: z.number().int().min(0),
    metadataMs: z.number().int().min(0),
    subtitlesMs: z.number().int().min(0),
  }),
  reliabilityHalfLifeMs: z.number().int().min(60_000),
  libraryFile: z.string().optional(),
  upstreamAddons: z.array(UpstreamAddonSchema),
  openSubtitles: z.object({
    apiKey: z.string().optional(),
    userAgent: z.string().min(1),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
  tmdbApiKey: z.string().optional(),
  companion: z.object({
    enabled: z.boolean(),
    sessionTtlMs: z.number().int().min(60_000),
  }),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema> & { defaultPreferences: UserPreferences };

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}
function num(env: Env, key: string, fallback: number): number {
  const v = str(env, key);
  return v === undefined ? fallback : Number(v);
}
function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = str(env, key);
  return v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function list(env: Env, key: string, fallback: string[]): string[] {
  const v = str(env, key);
  return v === undefined ? fallback : v.split(',').map((s) => s.trim()).filter(Boolean);
}
function json(env: Env, key: string): unknown {
  const v = str(env, key);
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    throw new Error(`${key} must be valid JSON`);
  }
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads and validates server configuration from environment variables. Throws ConfigError on problems. */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const port = num(env, 'PORT', 7000);
  const raw = {
    port,
    host: str(env, 'HOST') ?? '0.0.0.0',
    // RENDER_EXTERNAL_URL is set automatically on Render.
    publicUrl: (str(env, 'PUBLIC_URL') ?? str(env, 'RENDER_EXTERNAL_URL') ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    logLevel: str(env, 'LOG_LEVEL') ?? 'info',
    databasePath: env.DATABASE_PATH !== undefined ? env.DATABASE_PATH.trim() : './data/autopilot.db',
    providerTimeoutMs: num(env, 'PROVIDER_TIMEOUT_MS', 6000),
    enabledStreamProviders: list(env, 'STREAM_PROVIDERS', ['internet-archive', 'local-library', 'upstream']),
    probe: {
      enabled: bool(env, 'PROBE_ENABLED', true),
      timeoutMs: num(env, 'PROBE_TIMEOUT_MS', 2500),
      maxStreams: num(env, 'PROBE_MAX_STREAMS', 6),
      bytes: num(env, 'PROBE_BYTES', 262_144),
    },
    cacheTtl: {
      discoveryMs: num(env, 'DISCOVERY_CACHE_TTL_S', 1800) * 1000,
      healthMs: num(env, 'HEALTH_CACHE_TTL_S', 600) * 1000,
      metadataMs: num(env, 'METADATA_CACHE_TTL_S', 86_400) * 1000,
      subtitlesMs: num(env, 'SUBTITLE_CACHE_TTL_S', 21_600) * 1000,
    },
    reliabilityHalfLifeMs: num(env, 'RELIABILITY_HALF_LIFE_H', 6) * 3_600_000,
    libraryFile: str(env, 'LIBRARY_FILE'),
    upstreamAddons: json(env, 'UPSTREAM_ADDONS') ?? [],
    openSubtitles: {
      apiKey: str(env, 'OPENSUBTITLES_API_KEY'),
      userAgent: str(env, 'OPENSUBTITLES_USER_AGENT') ?? 'SmartAutoPilot v1.0.0',
      username: str(env, 'OPENSUBTITLES_USERNAME'),
      password: str(env, 'OPENSUBTITLES_PASSWORD'),
    },
    tmdbApiKey: str(env, 'TMDB_API_KEY'),
    companion: {
      enabled: bool(env, 'COMPANION_ENABLED', false),
      sessionTtlMs: num(env, 'COMPANION_SESSION_TTL_H', 6) * 3_600_000,
    },
  };

  const parsed = ServerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }

  const defaults = parsePreferences(json(env, 'DEFAULT_PREFERENCES') ?? {}, DEFAULT_PREFERENCES);
  if (defaults.issues.length) {
    throw new ConfigError(`Invalid DEFAULT_PREFERENCES: ${defaults.issues.join('; ')}`);
  }
  return { ...parsed.data, defaultPreferences: defaults.prefs };
}
