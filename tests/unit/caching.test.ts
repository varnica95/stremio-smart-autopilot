import { describe, expect, it } from 'vitest';
import { CacheService } from '../../src/services/caching/cache-service.js';
import { MemoryStore } from '../../src/services/caching/memory-store.js';
import { SqliteStore, TieredStore } from '../../src/services/caching/sqlite-store.js';
import { MemoryReliabilityStore, SqliteReliabilityStore } from '../../src/services/reliability/reliability-store.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

// Loaded via getBuiltinModule so test bundlers never try to resolve the `node:`-only module.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type Db = InstanceType<typeof DatabaseSync>;

function freshDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  db.exec(
    'CREATE TABLE reliability (key TEXT PRIMARY KEY, ok_ewma REAL NOT NULL, observations INTEGER NOT NULL, throughput_ewma REAL, updated_at INTEGER NOT NULL)',
  );
  return db;
}

describe('memory store', () => {
  it('expires entries after their TTL', () => {
    const c = clock();
    const store = new MemoryStore(10, c.now);
    store.set('k', 1, 1000);
    expect(store.get('k')).toBe(1);
    c.advance(1001);
    expect(store.get('k')).toBeUndefined();
  });

  it('evicts the oldest entries beyond its capacity', () => {
    const store = new MemoryStore(2);
    store.set('a', 1, 10_000);
    store.set('b', 2, 10_000);
    store.set('c', 3, 10_000);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('c')).toBe(3);
  });
});

describe('cache service', () => {
  it('shares one in-flight load between concurrent callers (request de-duplication)', async () => {
    const cache = new CacheService(new MemoryStore());
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return 'value';
    };
    const results = await Promise.all([cache.getOrLoad('k', 1000, load), cache.getOrLoad('k', 1000, load), cache.getOrLoad('k', 1000, load)]);
    expect(results).toEqual(['value', 'value', 'value']);
    expect(loads).toBe(1);
    await cache.getOrLoad('k', 1000, load);
    expect(loads).toBe(1);
  });

  it('does not cache failures', async () => {
    const cache = new CacheService(new MemoryStore());
    await expect(cache.getOrLoad('k', 1000, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(cache.getOrLoad('k', 1000, async () => 'ok')).resolves.toBe('ok');
  });

  it('lets the TTL depend on the value (0 = do not cache)', async () => {
    const cache = new CacheService(new MemoryStore());
    let loads = 0;
    const load = async () => {
      loads++;
      return [] as string[];
    };
    await cache.getOrLoad('k', (v: string[]) => (v.length ? 1000 : 0), load);
    await cache.getOrLoad('k', (v: string[]) => (v.length ? 1000 : 0), load);
    expect(loads).toBe(2);
  });
});

describe('sqlite store', () => {
  it('persists JSON values and honours expiry', () => {
    const c = clock();
    const store = new SqliteStore(freshDb(), c.now);
    store.set('k', { a: [1, 2] }, 500);
    expect(store.get('k')).toEqual({ a: [1, 2] });
    c.advance(501);
    expect(store.get('k')).toBeUndefined();
  });

  it('tiered store falls back to the persistent layer', () => {
    const slow = new SqliteStore(freshDb());
    const first = new TieredStore(new MemoryStore(), slow);
    first.set('k', 'v', 60_000);
    const afterRestart = new TieredStore(new MemoryStore(), slow);
    expect(afterRestart.get('k')).toBe('v');
  });
});

describe('reliability history', () => {
  for (const [name, make] of [
    ['memory', (now: () => number) => new MemoryReliabilityStore(3_600_000, now)],
    ['sqlite', (now: () => number) => new SqliteReliabilityStore(freshDb(), 3_600_000, now)],
  ] as const) {
    it(`${name}: failures lower reliability, and the penalty fades over time`, () => {
      const c = clock();
      const store = make(c.now);
      for (let i = 0; i < 5; i++) store.record('host:x', { ok: false });
      const fresh = store.get('host:x')!.reliability;
      expect(fresh).toBeLessThan(0.2);
      c.advance(6 * 3_600_000);
      expect(store.get('host:x')!.reliability).toBeGreaterThan(0.45);
    });

    it(`${name}: tracks an average throughput`, () => {
      const store = make(Date.now);
      store.record('stream:a', { ok: true, throughputBps: 1_000_000 });
      store.record('stream:a', { ok: true, throughputBps: 2_000_000 });
      const stats = store.get('stream:a')!;
      expect(stats.throughputBps).toBeGreaterThan(1_000_000);
      expect(stats.throughputBps).toBeLessThan(2_000_000);
      expect(stats.observations).toBe(2);
    });
  }
});
