import { randomUUID } from 'node:crypto';
import type { StreamCandidate, StreamTransport } from '../core/models/stream.js';

export interface FailoverTarget {
  candidateId: string;
  providerId: string;
  label: string;
  url: string;
  requestHeaders?: Record<string, string>;
}

export interface PlaybackRecord {
  startIndex: number;
  /** Index into the chain that is actually being served, once one succeeded. */
  pinnedIndex?: number;
  failedIndexes: number[];
  bytesServed: number;
  startedAt: number;
  lastActivityAt: number;
  /** Lowest sustained throughput seen while serving, bytes/s. */
  slowestThroughputBps?: number;
  problem?: string;
}

export interface FailoverSession {
  id: string;
  mediaKey: string;
  createdAt: number;
  /** HTTP targets in rank order (mirrors of a stream directly follow it). */
  chain: FailoverTarget[];
  /** For each listed stream index, the chain index where its own attempt starts. */
  entryPoints: number[];
  playbacks: Map<number, PlaybackRecord>;
}

function toTarget(candidate: StreamCandidate, transport: StreamTransport): FailoverTarget | undefined {
  if (transport.kind !== 'http') return undefined;
  return {
    candidateId: candidate.id,
    providerId: candidate.providerId,
    label: `${candidate.resolution} · ${candidate.providerName} · ${candidate.title}`,
    url: transport.url,
    requestHeaders: transport.requestHeaders,
  };
}

/** In-memory registry of failover chains created for recent stream responses. */
export class FailoverSessionStore {
  private readonly sessions = new Map<string, FailoverSession>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Creates a session for the ranked candidates. Returns, for each candidate index, the chain index
   * its playback should start from (undefined for non-HTTP candidates).
   */
  create(mediaKey: string, ranked: StreamCandidate[]): { session: FailoverSession; entryFor: (index: number) => number | undefined } {
    this.prune();
    const chain: FailoverTarget[] = [];
    const entryPoints: number[] = [];
    const entryByCandidate = new Map<number, number>();

    ranked.forEach((candidate, index) => {
      const primary = toTarget(candidate, candidate.transport);
      if (!primary) return;
      entryByCandidate.set(index, chain.length);
      entryPoints.push(chain.length);
      chain.push(primary);
      for (const mirror of candidate.mirrors ?? []) {
        const target = toTarget(candidate, mirror);
        if (target) chain.push(target);
      }
    });

    const session: FailoverSession = {
      id: randomUUID(),
      mediaKey,
      createdAt: this.now(),
      chain,
      entryPoints,
      playbacks: new Map(),
    };
    this.sessions.set(session.id, session);
    return { session, entryFor: (index) => entryByCandidate.get(index) };
  }

  get(id: string): FailoverSession | undefined {
    const session = this.sessions.get(id);
    if (session && this.now() - session.createdAt > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  recent(limit: number): FailoverSession[] {
    this.prune();
    return [...this.sessions.values()]
      .filter((s) => s.playbacks.size > 0)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) if (now - s.createdAt > this.ttlMs) this.sessions.delete(id);
  }
}
