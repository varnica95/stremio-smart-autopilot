import type { StreamProvider } from '../../core/interfaces/providers.js';
import { mediaKey, type MediaMetadata, type MediaRequest } from '../../core/models/media.js';
import type { StreamCandidate } from '../../core/models/stream.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { TimeoutError, errorMessage, withTimeout } from '../../utils/async.js';
import type { CacheService } from '../caching/cache-service.js';
import type { ReliabilityService } from '../reliability/reliability-service.js';

export type ProviderStatus = 'ok' | 'timeout' | 'error';

export interface ProviderReport {
  providerId: string;
  providerName: string;
  status: ProviderStatus;
  count: number;
  durationMs: number;
  error?: string;
}

export interface DiscoveryResult {
  candidates: StreamCandidate[];
  reports: ProviderReport[];
}

/** Empty answers are cached briefly: they are often caused by an upstream hiccup. */
const EMPTY_RESULT_TTL_MS = 5 * 60_000;

/**
 * Queries every applicable provider concurrently. Each provider has its own time budget and error
 * isolation, so a slow or broken provider never blocks the others.
 */
export class StreamDiscoveryService {
  constructor(
    private readonly providers: StreamProvider[],
    private readonly cache: CacheService,
    private readonly reliability: ReliabilityService,
    private readonly logger: Logger,
    private readonly options: { timeoutMs: number; ttlMs: number },
  ) {}

  get providerList(): readonly StreamProvider[] {
    return this.providers;
  }

  async discover(media: MediaRequest, metadata: MediaMetadata, signal?: AbortSignal): Promise<DiscoveryResult> {
    const applicable = this.providers.filter((p) => p.supports(media));
    const settled = await Promise.all(applicable.map((provider) => this.runProvider(provider, media, metadata, signal)));
    return {
      candidates: settled.flatMap((s) => s.candidates),
      reports: settled.map((s) => s.report),
    };
  }

  private async runProvider(
    provider: StreamProvider,
    media: MediaRequest,
    metadata: MediaMetadata,
    signal?: AbortSignal,
  ): Promise<{ candidates: StreamCandidate[]; report: ProviderReport }> {
    const started = Date.now();
    const key = `streams:${provider.id}:${mediaKey(media)}`;
    try {
      const candidates = await this.cache.getOrLoad<StreamCandidate[]>(
        key,
        (value) => (value.length > 0 ? this.options.ttlMs : Math.min(this.options.ttlMs, EMPTY_RESULT_TTL_MS)),
        async () => {
          const result = await withTimeout(
            `provider:${provider.id}`,
            this.options.timeoutMs,
            (s) => provider.findStreams(media, { signal: s, metadata }),
            signal,
          );
          this.reliability.recordProviderApiOutcome(provider.id, true);
          return result;
        },
      );
      return {
        candidates,
        report: this.report(provider, 'ok', candidates.length, started),
      };
    } catch (err) {
      const status: ProviderStatus = err instanceof TimeoutError ? 'timeout' : 'error';
      this.reliability.recordProviderApiOutcome(provider.id, false);
      this.logger.warn({ provider: provider.id, status, err: errorMessage(err) }, 'Stream provider failed');
      return { candidates: [], report: this.report(provider, status, 0, started, errorMessage(err)) };
    }
  }

  private report(provider: StreamProvider, status: ProviderStatus, count: number, started: number, error?: string): ProviderReport {
    return { providerId: provider.id, providerName: provider.name, status, count, durationMs: Date.now() - started, error };
  }
}
