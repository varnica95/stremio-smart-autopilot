import type { MetadataProvider } from '../../core/interfaces/providers.js';
import { mediaKey, type MediaMetadata, type MediaRequest } from '../../core/models/media.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { errorMessage, withTimeout } from '../../utils/async.js';
import type { CacheService } from '../caching/cache-service.js';

/**
 * Merges metadata from all providers (earlier providers win per field). Failures only remove
 * information; they never fail the request.
 */
export class MetadataService {
  constructor(
    private readonly providers: MetadataProvider[],
    private readonly cache: CacheService,
    private readonly logger: Logger,
    private readonly options: { timeoutMs: number; ttlMs: number },
  ) {}

  async get(media: MediaRequest, signal?: AbortSignal): Promise<MediaMetadata> {
    // Metadata is per title, not per episode.
    const key = `meta:${mediaKey({ type: media.type, imdbId: media.imdbId })}`;
    return this.cache.getOrLoad<MediaMetadata>(
      key,
      (value) => (Object.keys(value).length > 0 ? this.options.ttlMs : 60_000),
      async () => {
        const results = await Promise.allSettled(
          this.providers.map((p) => withTimeout(`metadata:${p.id}`, this.options.timeoutMs, (s) => p.getMetadata(media, s), signal)),
        );
        const merged: MediaMetadata = {};
        results.forEach((result, i) => {
          if (result.status === 'rejected') {
            this.logger.warn({ provider: this.providers[i]?.id, err: errorMessage(result.reason) }, 'Metadata provider failed');
            return;
          }
          for (const [k, v] of Object.entries(result.value) as Array<[keyof MediaMetadata, unknown]>) {
            if (v !== undefined && merged[k] === undefined) (merged as Record<string, unknown>)[k] = v;
          }
        });
        return merged;
      },
    );
  }
}
