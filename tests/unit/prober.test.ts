import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '../../src/infrastructure/logging/logger.js';
import { CacheService } from '../../src/services/caching/cache-service.js';
import { MemoryStore } from '../../src/services/caching/memory-store.js';
import { MemoryReliabilityStore } from '../../src/services/reliability/reliability-store.js';
import { ReliabilityService } from '../../src/services/reliability/reliability-service.js';
import { StreamProber } from '../../src/services/stream-discovery/stream-prober.js';
import { fakeFetch, makeCandidate, torrentTransport } from '../helpers/factories.js';
import type { FetchLike } from '../../src/infrastructure/http/http-client.js';

function prober(fetchImpl: FetchLike, timeoutMs = 300) {
  const reliability = new ReliabilityService(new MemoryReliabilityStore(3_600_000));
  return {
    reliability,
    prober: new StreamProber(fetchImpl, new CacheService(new MemoryStore()), reliability, createSilentLogger(), {
      timeoutMs,
      bytes: 1024,
      ttlMs: 60_000,
      concurrency: 2,
    }),
  };
}

const video = () => new Response(new Uint8Array(4096), { status: 206, headers: { 'Content-Type': 'video/mp4' } });

describe('stream prober', () => {
  it('marks a link that serves video bytes as verified and measures it', async () => {
    const { prober: p } = prober(fakeFetch({ 'https://ok.example': video }));
    const health = await p.probe(makeCandidate({ transport: { kind: 'http', url: 'https://ok.example/a.mp4' } }));
    expect(health.status).toBe('verified');
    expect(health.ttfbMs).toBeDefined();
    expect(health.throughputBps).toBeGreaterThan(0);
  });

  it('marks HTTP errors as failed', async () => {
    const { prober: p } = prober(fakeFetch({}));
    const health = await p.probe(makeCandidate({ transport: { kind: 'http', url: 'https://missing.example/a.mp4' } }));
    expect(health).toMatchObject({ status: 'failed', detail: 'HTTP 404' });
  });

  it('does not accept an HTML page as video', async () => {
    const html = () => new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    const { prober: p } = prober(fakeFetch({ 'https://portal.example': html }));
    const health = await p.probe(makeCandidate({ transport: { kind: 'http', url: 'https://portal.example/a.mp4' } }));
    expect(health.status).toBe('failed');
  });

  it('reports a server that never answers as failed', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const { prober: p } = prober(hang, 50);
    const health = await p.probe(makeCandidate());
    expect(health).toMatchObject({ status: 'failed', detail: 'no response in time' });
  });

  it('leaves torrents unverified', async () => {
    const { prober: p } = prober(fakeFetch({}));
    expect((await p.probe(makeCandidate({ transport: torrentTransport() }))).status).toBe('unverified');
  });

  it('records outcomes into reliability history and caches results', async () => {
    let calls = 0;
    const { prober: p, reliability } = prober(
      fakeFetch({
        'https://ok.example': () => {
          calls++;
          return video();
        },
      }),
    );
    const c = makeCandidate({ transport: { kind: 'http', url: 'https://ok.example/b.mp4' } });
    await p.probeMany([c]);
    await p.probeMany([c]);
    expect(calls).toBe(1);
    expect(reliability.reliabilityFor(c)).toBeGreaterThan(0.5);
    expect(p.cachedHealth(c)?.status).toBe('verified');
  });
});
