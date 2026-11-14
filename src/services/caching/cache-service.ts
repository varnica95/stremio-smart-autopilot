import type { KeyValueStore } from '../../core/interfaces/stores.js';

/**
 * Read-through cache with request de-duplication: concurrent callers asking for the same key share
 * one in-flight load instead of hitting the upstream service several times.
 */
export class CacheService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly store: KeyValueStore) {}

  get<T>(key: string): T | undefined {
    return this.store.get<T>(key);
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, value, ttlMs);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Returns the cached value or runs `load`. `ttlFor` may return 0 to skip caching a result
   * (e.g. an empty answer caused by a partial outage).
   */
  async getOrLoad<T>(key: string, ttlFor: number | ((value: T) => number), load: () => Promise<T>): Promise<T> {
    const cached = this.store.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = (async () => {
      try {
        const value = await load();
        const ttl = typeof ttlFor === 'function' ? ttlFor(value) : ttlFor;
        this.store.set(key, value, ttl);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }
}
