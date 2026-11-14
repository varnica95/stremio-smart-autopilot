import type { AddonInterface } from 'stremio-addon-sdk';
import { FailoverProxy } from './companion/failover-proxy.js';
import { FailoverSessionStore } from './companion/failover-sessions.js';
import type { ServerConfig } from './config/env.js';
import type {
  MetadataProvider,
  StreamProvider,
  SubtitleFileSource,
  SubtitleProvider,
} from './core/interfaces/providers.js';
import { openDatabase } from './infrastructure/database/sqlite.js';
import type { FetchLike } from './infrastructure/http/http-client.js';
import type { Logger } from './infrastructure/logging/logger.js';
import { CinemetaProvider } from './providers/metadata/cinemeta.js';
import { TmdbProvider } from './providers/metadata/tmdb.js';
import { createStreamProviders } from './providers/streams/index.js';
import { OpenSubtitlesProvider } from './providers/subtitles/opensubtitles.js';
import { createRequestHandler, type ServerDeps } from './server.js';
import { CacheService } from './services/caching/cache-service.js';
import { MemoryStore } from './services/caching/memory-store.js';
import { SqliteStore, TieredStore } from './services/caching/sqlite-store.js';
import { MemoryReliabilityStore, SqliteReliabilityStore } from './services/reliability/reliability-store.js';
import { ReliabilityService, reliabilityKeys } from './services/reliability/reliability-service.js';
import { StreamDiscoveryService } from './services/stream-discovery/discovery-service.js';
import { MetadataService } from './services/stream-discovery/metadata-service.js';
import { StreamProber } from './services/stream-discovery/stream-prober.js';
import { StreamService } from './services/stream-ranking/stream-service.js';
import { ErrorLog } from './services/diagnostics/error-log.js';
import { SubtitleService } from './services/subtitle-matching/subtitle-service.js';
import { createAddonInterface } from './stremio/addon.js';
import { buildManifest } from './stremio/manifest/manifest.js';

export interface AppOverrides {
  fetchImpl?: FetchLike;
  streamProviders?: StreamProvider[];
  subtitleProviders?: Array<SubtitleProvider & Partial<SubtitleFileSource>>;
  metadataProviders?: MetadataProvider[];
  sdkRouter?: ServerDeps['sdkRouter'];
}

export interface App {
  addonInterface: AddonInterface;
  requestHandler: ReturnType<typeof createRequestHandler>;
  streamService: StreamService;
  subtitleService: SubtitleService;
  reliability: ReliabilityService;
  close(): void;
}

/** Composition root: wires configuration, infrastructure, providers and services together. */
export async function createApp(config: ServerConfig, logger: Logger, overrides: AppOverrides = {}): Promise<App> {
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const db = await openDatabase(config.databasePath, logger);

  const memory = new MemoryStore();
  const cache = new CacheService(db ? new TieredStore(memory, new SqliteStore(db)) : memory);
  const reliability = new ReliabilityService(
    db
      ? new SqliteReliabilityStore(db, config.reliabilityHalfLifeMs)
      : new MemoryReliabilityStore(config.reliabilityHalfLifeMs),
  );

  const metadataProviders = overrides.metadataProviders ?? [
    ...(config.tmdbApiKey ? [new TmdbProvider(config.tmdbApiKey, fetchImpl)] : []),
    new CinemetaProvider(fetchImpl),
  ];
  const metadata = new MetadataService(metadataProviders, cache, logger.child({ svc: 'metadata' }), {
    timeoutMs: Math.min(config.providerTimeoutMs, 4000),
    ttlMs: config.cacheTtl.metadataMs,
  });

  const streamProviders = overrides.streamProviders ?? createStreamProviders(config, logger, fetchImpl);
  const discovery = new StreamDiscoveryService(streamProviders, cache, reliability, logger.child({ svc: 'discovery' }), {
    timeoutMs: config.providerTimeoutMs,
    ttlMs: config.cacheTtl.discoveryMs,
  });
  const prober = config.probe.enabled
    ? new StreamProber(fetchImpl, cache, reliability, logger.child({ svc: 'prober' }), {
        timeoutMs: config.probe.timeoutMs,
        bytes: config.probe.bytes,
        ttlMs: config.cacheTtl.healthMs,
        concurrency: 4,
      })
    : undefined;
  const streamService = new StreamService(metadata, discovery, prober, reliability, logger.child({ svc: 'streams' }), {
    maxProbes: config.probe.maxStreams,
  });

  // Always available: users can bring their own OpenSubtitles key even if the server has none.
  const openSubtitles = new OpenSubtitlesProvider(
    {
      apiKey: config.openSubtitles.apiKey,
      userAgent: config.openSubtitles.userAgent,
      username: config.openSubtitles.username,
      password: config.openSubtitles.password,
      publicUrl: config.publicUrl,
    },
    logger.child({ provider: 'opensubtitles' }),
    fetchImpl,
    cache,
  );
  const subtitleProviders: Array<SubtitleProvider & Partial<SubtitleFileSource>> = overrides.subtitleProviders ?? [openSubtitles];
  const subtitleService = new SubtitleService(subtitleProviders, metadata, cache, logger.child({ svc: 'subtitles' }), {
    timeoutMs: config.providerTimeoutMs,
    ttlMs: config.cacheTtl.subtitlesMs,
  });

  const sessions = config.companion.enabled ? new FailoverSessionStore(config.companion.sessionTtlMs) : undefined;
  const companion = sessions
    ? new FailoverProxy(sessions, reliability, fetchImpl, logger.child({ svc: 'companion' }), { connectTimeoutMs: 8000 })
    : undefined;

  const errorLog = new ErrorLog();
  const manifest = buildManifest({
    peerToPeer: streamProviders.some((p) => p.peerToPeer),
    subtitlesEnabled: subtitleService.enabled,
    defaults: config.defaultPreferences,
  });
  const addonInterface = createAddonInterface(
    manifest,
    { streamService, defaults: config.defaultPreferences, publicUrl: config.publicUrl, logger, companion: sessions, errorLog },
    subtitleService.enabled ? { subtitleService, defaults: config.defaultPreferences, logger } : undefined,
  );

  const requestHandler = createRequestHandler({
    addonInterface,
    logger,
    cache,
    defaults: config.defaultPreferences,
    subtitleSources: subtitleProviders.filter((p): p is SubtitleProvider & SubtitleFileSource => typeof p.fetchSubtitleFile === 'function'),
    companion,
    sdkRouter: overrides.sdkRouter,
    page: {
      publicUrl: config.publicUrl,
      streamProviders: streamProviders.map((p) => p.name),
      subtitlesEnabled: subtitleService.enabled,
      serverSubtitleKey: overrides.subtitleProviders ? subtitleService.enabled : openSubtitles.hasServerKey,
      originalLanguageAvailable: metadataProviders.some((p) => p.id === 'tmdb'),
      companionEnabled: Boolean(companion),
    },
    status: () => ({
      providers: streamProviders.map((p) => ({
        id: p.id,
        name: p.name,
        api: reliability.stats(reliabilityKeys.providerApi(p.id)),
        streams: reliability.stats(reliabilityKeys.provider(p.id)),
      })),
      hosts: reliability.list('host:', 30),
      sessions: sessions?.recent(20) ?? [],
      problems: errorLog.recent(),
      now: Date.now(),
    }),
  });

  return {
    addonInterface,
    requestHandler,
    streamService,
    subtitleService,
    reliability,
    close: () => db?.close(),
  };
}
