/** Aggregated, time-decayed outcome history for a provider, host or individual stream. */
export interface ReliabilityStats {
  /** 0..1, decays toward 0.5 (neutral) as observations age. */
  reliability: number;
  observations: number;
  /** Exponentially weighted average throughput in bytes/s, if any was measured. */
  throughputBps?: number;
  updatedAt: number;
}

export interface ReliabilityStore {
  record(key: string, outcome: { ok: boolean; throughputBps?: number }): void;
  get(key: string): ReliabilityStats | undefined;
  list(prefix: string, limit: number): Array<{ key: string; stats: ReliabilityStats }>;
}

/** Minimal key-value store with per-entry expiry. Values must be JSON-serializable. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  delete(key: string): void;
}
