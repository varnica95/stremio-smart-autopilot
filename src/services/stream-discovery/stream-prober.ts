import type { StreamCandidate, StreamHealth } from '../../core/models/stream.js';
import type { FetchLike } from '../../infrastructure/http/http-client.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { TimeoutError, errorMessage, mapWithConcurrency, withTimeout } from '../../utils/async.js';
import type { CacheService } from '../caching/cache-service.js';
import type { ReliabilityService } from '../reliability/reliability-service.js';

export interface ProbeOptions {
  timeoutMs: number;
  /** How many bytes to download for the speed sample. */
  bytes: number;
  ttlMs: number;
  concurrency: number;
}

/**
 * Actively tests HTTP streams with a small ranged GET and measures time-to-first-byte and
 * throughput. Torrent streams cannot be tested without joining the swarm, so they stay "unverified".
 *
 * Results describe the network path from this server, which matches the viewer's only when the
 * addon runs on the same machine or network as Stremio.
 */
export class StreamProber {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly cache: CacheService,
    private readonly reliability: ReliabilityService,
    private readonly logger: Logger,
    private readonly options: ProbeOptions,
  ) {}

  cachedHealth(candidate: StreamCandidate): StreamHealth | undefined {
    return this.cache.get<StreamHealth>(this.key(candidate));
  }

  async probeMany(candidates: StreamCandidate[], signal?: AbortSignal): Promise<Map<string, StreamHealth>> {
    const results = new Map<string, StreamHealth>();
    const testable = candidates.filter((c) => c.transport.kind === 'http');
    await mapWithConcurrency(testable, this.options.concurrency, async (candidate) => {
      const health = await this.cache.getOrLoad(this.key(candidate), this.options.ttlMs, async () => {
        const result = await this.probe(candidate, signal);
        if (result.status !== 'unverified') {
          this.reliability.recordStreamOutcome(candidate, result.status === 'verified', result.throughputBps);
        }
        return result;
      });
      results.set(candidate.id, health);
    });
    return results;
  }

  async probe(candidate: StreamCandidate, signal?: AbortSignal): Promise<StreamHealth> {
    const transport = candidate.transport;
    if (transport.kind !== 'http') return { status: 'unverified', checkedAt: Date.now() };

    const started = performance.now();
    let firstByteAt: number | undefined;
    let received = 0;

    try {
      return await withTimeout(
        'probe',
        this.options.timeoutMs,
        async (s) => {
          const response = await this.fetchImpl(transport.url, {
            headers: { ...transport.requestHeaders, Range: `bytes=0-${this.options.bytes - 1}` },
            redirect: 'follow',
            signal: s,
          });
          firstByteAt = performance.now();
          if (response.status !== 200 && response.status !== 206) {
            await response.body?.cancel().catch(() => undefined);
            return this.failed(`HTTP ${response.status}`);
          }
          const type = response.headers.get('content-type') ?? '';
          if (/text\/html/i.test(type)) {
            await response.body?.cancel().catch(() => undefined);
            return this.failed('returned a web page instead of video');
          }
          received = await this.readUpTo(response, this.options.bytes);
          if (received === 0) return this.failed('empty response');
          return this.verified(started, firstByteAt, received);
        },
        signal,
      );
    } catch (err) {
      // A slow server that delivered some bytes is reachable, just slow: report what was measured.
      if (err instanceof TimeoutError && firstByteAt !== undefined && received > 0) {
        return this.verified(started, firstByteAt, received);
      }
      const detail = err instanceof TimeoutError ? 'no response in time' : 'connection failed';
      this.logger.debug({ stream: candidate.id, err: errorMessage(err) }, 'Probe failed');
      return this.failed(detail);
    }
  }

  private async readUpTo(response: Response, limit: number): Promise<number> {
    if (!response.body) return 0;
    const reader = response.body.getReader();
    let total = 0;
    try {
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return total;
  }

  private verified(started: number, firstByteAt: number, bytes: number): StreamHealth {
    const transferSeconds = Math.max(0.02, (performance.now() - firstByteAt) / 1000);
    return {
      status: 'verified',
      ttfbMs: Math.round(firstByteAt - started),
      throughputBps: Math.round(bytes / transferSeconds),
      checkedAt: Date.now(),
    };
  }

  private failed(detail: string): StreamHealth {
    return { status: 'failed', detail, checkedAt: Date.now() };
  }

  private key(candidate: StreamCandidate): string {
    return `health:${candidate.id}`;
  }
}
