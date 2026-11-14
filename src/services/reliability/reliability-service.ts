import type { ReliabilityStats, ReliabilityStore } from '../../core/interfaces/stores.js';
import type { StreamCandidate, StreamTransport } from '../../core/models/stream.js';

export const reliabilityKeys = {
  stream: (id: string) => `stream:${id}`,
  /** Playback/probe outcomes of streams that came from this provider. */
  provider: (id: string) => `provider:${id}`,
  /** Whether the provider's own API answered discovery requests. Shown on /status only. */
  providerApi: (id: string) => `provider-api:${id}`,
  host: (host: string) => `host:${host.toLowerCase()}`,
};

export function transportHost(transport: StreamTransport): string | undefined {
  if (transport.kind === 'torrent') return undefined;
  try {
    return new URL(transport.url).hostname;
  } catch {
    return undefined;
  }
}

/** Combines stream-, host- and provider-level history into the signals the ranker uses. */
export class ReliabilityService {
  constructor(private readonly store: ReliabilityStore) {}

  recordProviderApiOutcome(providerId: string, ok: boolean): void {
    this.store.record(reliabilityKeys.providerApi(providerId), { ok });
  }

  recordStreamOutcome(
    candidate: Pick<StreamCandidate, 'id' | 'transport' | 'providerId'>,
    ok: boolean,
    throughputBps?: number,
  ): void {
    this.store.record(reliabilityKeys.stream(candidate.id), { ok, throughputBps });
    this.store.record(reliabilityKeys.provider(candidate.providerId), { ok });
    const host = transportHost(candidate.transport);
    if (host) this.store.record(reliabilityKeys.host(host), { ok, throughputBps });
  }

  /** Weighted blend; more specific and better-observed history counts more. */
  reliabilityFor(candidate: StreamCandidate): number | undefined {
    const host = transportHost(candidate.transport);
    const parts: Array<[ReliabilityStats | undefined, number]> = [
      [this.store.get(reliabilityKeys.stream(candidate.id)), 3],
      [host ? this.store.get(reliabilityKeys.host(host)) : undefined, 2],
      [this.store.get(reliabilityKeys.provider(candidate.providerId)), 1],
    ];
    let sum = 0;
    let weight = 0;
    for (const [stats, base] of parts) {
      if (!stats) continue;
      const w = base * Math.min(1, stats.observations / 3);
      sum += w * stats.reliability;
      weight += w;
    }
    return weight > 0 ? sum / weight : undefined;
  }

  throughputFor(candidate: StreamCandidate): number | undefined {
    return this.store.get(reliabilityKeys.stream(candidate.id))?.throughputBps;
  }

  stats(key: string): ReliabilityStats | undefined {
    return this.store.get(key);
  }

  list(prefix: string, limit = 50): Array<{ key: string; stats: ReliabilityStats }> {
    return this.store.list(prefix, limit);
  }
}
