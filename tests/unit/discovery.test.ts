import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '../../src/infrastructure/logging/logger.js';
import { CacheService } from '../../src/services/caching/cache-service.js';
import { MemoryStore } from '../../src/services/caching/memory-store.js';
import { MemoryReliabilityStore } from '../../src/services/reliability/reliability-store.js';
import { ReliabilityService } from '../../src/services/reliability/reliability-service.js';
import { StreamDiscoveryService } from '../../src/services/stream-discovery/discovery-service.js';
import { FakeStreamProvider, MOVIE, delay, makeCandidate } from '../helpers/factories.js';

function service(providers: FakeStreamProvider[], timeoutMs = 100) {
  return new StreamDiscoveryService(
    providers,
    new CacheService(new MemoryStore()),
    new ReliabilityService(new MemoryReliabilityStore(3_600_000)),
    createSilentLogger(),
    { timeoutMs, ttlMs: 60_000 },
  );
}

describe('stream discovery', () => {
  it('queries providers concurrently and merges their results', async () => {
    const a = new FakeStreamProvider('a', (_m, ctx) => delay(60, [makeCandidate({ providerId: 'a' })], ctx.signal));
    const b = new FakeStreamProvider('b', (_m, ctx) => delay(60, [makeCandidate({ providerId: 'b' })], ctx.signal));
    const started = Date.now();
    const result = await service([a, b], 500).discover(MOVIE, {});
    expect(Date.now() - started).toBeLessThan(110);
    expect(result.candidates.map((c) => c.providerId).sort()).toEqual(['a', 'b']);
  });

  it('a timed-out provider does not block the others', async () => {
    const slow = new FakeStreamProvider('slow', (_m, ctx) => delay(5_000, [makeCandidate()], ctx.signal));
    const fast = new FakeStreamProvider('fast', async () => [makeCandidate({ providerId: 'fast' })]);
    const result = await service([slow, fast], 80).discover(MOVIE, {});
    expect(result.candidates).toHaveLength(1);
    expect(result.reports.find((r) => r.providerId === 'slow')?.status).toBe('timeout');
    expect(result.reports.find((r) => r.providerId === 'fast')?.status).toBe('ok');
  });

  it('times out even when a provider ignores its abort signal', async () => {
    const stubborn = new FakeStreamProvider('stubborn', () => new Promise(() => undefined));
    const result = await service([stubborn], 50).discover(MOVIE, {});
    expect(result.reports[0]?.status).toBe('timeout');
  });

  it('isolates provider errors', async () => {
    const broken = new FakeStreamProvider('broken', async () => {
      throw new Error('upstream exploded');
    });
    const ok = new FakeStreamProvider('ok', async () => [makeCandidate()]);
    const result = await service([broken, ok]).discover(MOVIE, {});
    expect(result.candidates).toHaveLength(1);
    expect(result.reports.find((r) => r.providerId === 'broken')).toMatchObject({ status: 'error', error: 'upstream exploded' });
  });

  it('caches successful results but retries after failures', async () => {
    let fail = true;
    const flaky = new FakeStreamProvider('flaky', async () => {
      if (fail) throw new Error('temporary');
      return [makeCandidate()];
    });
    const svc = service([flaky]);
    expect((await svc.discover(MOVIE, {})).candidates).toHaveLength(0);
    fail = false;
    expect((await svc.discover(MOVIE, {})).candidates).toHaveLength(1);
    await svc.discover(MOVIE, {});
    expect(flaky.calls).toBe(2);
  });

  it('de-duplicates concurrent identical requests', async () => {
    const p = new FakeStreamProvider('p', (_m, ctx) => delay(30, [makeCandidate()], ctx.signal));
    const svc = service([p], 500);
    await Promise.all([svc.discover(MOVIE, {}), svc.discover(MOVIE, {}), svc.discover(MOVIE, {})]);
    expect(p.calls).toBe(1);
  });
});
