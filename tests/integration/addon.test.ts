import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app.js';
import type { SubtitleFileSource } from '../../src/core/interfaces/providers.js';
import { createSilentLogger } from '../../src/infrastructure/logging/logger.js';
import {
  FakeStreamProvider,
  FakeSubtitleProvider,
  delay,
  makeCandidate,
  makeSubtitle,
  testConfig,
  torrentTransport,
} from '../helpers/factories.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function appWith(options: Parameters<typeof createApp>[2], env: Record<string, string> = {}): Promise<App> {
  return createApp(testConfig(env), createSilentLogger(), { metadataProviders: [], ...options });
}

describe('addon (stream resource)', () => {
  it('returns ranked, Stremio-formatted streams for a movie', async () => {
    const provider = new FakeStreamProvider('fake', async () => [
      makeCandidate({ id: 'sd', resolution: '720p', title: 'Movie 720p' }),
      makeCandidate({ id: 'hd', title: 'Movie 1080p' }),
      makeCandidate({ id: 'cam', source: 'cam', title: 'Movie CAM' }),
    ]);
    const app = await appWith({ streamProviders: [provider], subtitleProviders: [] });
    const res = (await app.addonInterface.get('stream', 'movie', 'tt0032138', {})) as {
      streams: Array<{ name: string; description: string; url?: string }>;
      cacheMaxAge: number;
    };
    expect(res.streams).toHaveLength(2);
    expect(res.streams[0]?.description).toContain('Movie 1080p');
    expect(res.streams[0]?.name).toContain('⭐');
    expect(res.cacheMaxAge).toBeLessThanOrEqual(300);
  });

  it('applies per-user configuration passed by Stremio', async () => {
    const provider = new FakeStreamProvider('fake', async () => [makeCandidate({ id: 'a' }), makeCandidate({ id: 'b' }), makeCandidate({ id: 'c' })]);
    const app = await appWith({ streamProviders: [provider], subtitleProviders: [] });
    const res = (await app.addonInterface.get('stream', 'movie', 'tt0032138', {}, { maxResults: 1 })) as {
      streams: unknown[];
    };
    expect(res.streams).toHaveLength(1);
  });

  it('still answers when one provider fails and another times out', async () => {
    const broken = new FakeStreamProvider('broken', async () => {
      throw new Error('down');
    });
    const slow = new FakeStreamProvider('slow', (_m, ctx) => delay(10_000, [makeCandidate()], ctx.signal));
    const ok = new FakeStreamProvider('ok', async () => [makeCandidate({ transport: torrentTransport(), seeders: 30 })]);
    const app = await appWith({ streamProviders: [broken, slow, ok], subtitleProviders: [] }, { PROVIDER_TIMEOUT_MS: '500' });
    const res = (await app.addonInterface.get('stream', 'series', 'tt0944947:1:5', {})) as {
      streams: Array<{ infoHash?: string }>;
    };
    expect(res.streams).toHaveLength(1);
    expect(res.streams[0]?.infoHash).toBeDefined();
  });

  it('shows a helpful entry instead of an empty list when every provider failed', async () => {
    const broken = new FakeStreamProvider('broken', async () => {
      throw new Error('down');
    }, 'Broken Source');
    const app = await appWith({ streamProviders: [broken], subtitleProviders: [] });
    const res = (await app.addonInterface.get('stream', 'movie', 'tt0032138', {})) as {
      streams: Array<{ description: string; externalUrl?: string }>;
    };
    expect(res.streams).toHaveLength(1);
    expect(res.streams[0]?.description).toContain('Broken Source');
    expect(res.streams[0]?.externalUrl).toContain('/status');
  });

  it('ignores ids it does not handle', async () => {
    const app = await appWith({ streamProviders: [], subtitleProviders: [] });
    const res = (await app.addonInterface.get('stream', 'movie', 'kitsu:123', {})) as { streams: unknown[] };
    expect(res.streams).toEqual([]);
  });

  it('publishes a manifest that matches the enabled features', async () => {
    const app = await appWith({ streamProviders: [], subtitleProviders: [] });
    const m = app.addonInterface.manifest;
    expect(m.resources).toEqual(['stream']);
    expect(m.idPrefixes).toEqual(['tt']);
    expect(m.types).toEqual(['movie', 'series']);
    expect(m.behaviorHints?.configurable).toBe(true);
    expect(m.behaviorHints?.p2p).toBe(false);
  });
});

describe('addon (subtitles resource)', () => {
  it('returns subtitles with Croatian first and ISO 639-2 codes', async () => {
    const subs = new FakeSubtitleProvider('fake-subs', [
      makeSubtitle({ language: 'en', hashMatch: true }),
      makeSubtitle({ language: 'hr' }),
      makeSubtitle({ language: 'de' }),
    ]);
    const app = await appWith({ streamProviders: [], subtitleProviders: [subs] });
    expect(app.addonInterface.manifest.resources).toEqual(['stream', 'subtitles']);
    const res = (await app.addonInterface.get('subtitles', 'movie', 'tt0032138', { videoHash: '0123456789abcdef', videoSize: '1000', filename: 'Movie.2020.1080p.WEB-DL.x264-GRP.mkv' })) as { subtitles: Array<{ id: string; url: string; lang: string }> };
    expect(res.subtitles.map((s) => s.lang)).toEqual(['hrv', 'eng']);
    for (const s of res.subtitles) {
      expect(Object.keys(s).sort()).toEqual(['id', 'lang', 'url']);
    }
  });
});

describe('HTTP server', () => {
  it('serves the configure page, manifest and a pre-filled configure page', async () => {
    const app = await appWith({ streamProviders: [], subtitleProviders: [] });
    const base = await listen((req, res) => void app.requestHandler(req, res));

    const page = await fetch(`${base}/configure`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Install in Stremio');

    const manifest = await fetch(`${base}/manifest.json`);
    expect(((await manifest.json()) as { id: string }).id).toBe('community.smart-autopilot');

    const cfg = encodeURIComponent(JSON.stringify({ maxResults: 7 }));
    const prefilled = await (await fetch(`${base}/${cfg}/configure`)).text();
    expect(prefilled).toContain('value="7"');
  });

  it('downloads subtitle files on demand and caches them', async () => {
    let downloads = 0;
    const tokens: Array<string | undefined> = [];
    const source: SubtitleFileSource & FakeSubtitleProvider = Object.assign(new FakeSubtitleProvider('fake-subs', []), {
      async fetchSubtitleFile(fileId: string, _signal: AbortSignal, userToken?: string) {
        downloads++;
        tokens.push(userToken);
        return { body: Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\nBok ${fileId}\n`), contentType: 'application/x-subrip; charset=utf-8' };
      },
    });
    const app = await appWith({ streamProviders: [], subtitleProviders: [source] });
    const base = await listen((req, res) => void app.requestHandler(req, res));

    const first = await fetch(`${base}/subtitles-file/fake-subs/42.srt`);
    expect(first.status).toBe(200);
    expect(first.headers.get('access-control-allow-origin')).toBe('*');
    expect(await first.text()).toContain('Bok 42');
    await fetch(`${base}/subtitles-file/fake-subs/42.srt`);
    expect(downloads).toBe(1);

    const token = 'a'.repeat(24);
    await fetch(`${base}/subtitles-file/fake-subs/43.srt?u=${token}`);
    await fetch(`${base}/subtitles-file/fake-subs/44.srt?u=not-a-token`);
    expect(tokens).toEqual([undefined, token, undefined]);
  });
});

describe('companion failover proxy', () => {
  it('falls back to the next-ranked source when the first one fails, before sending any bytes', async () => {
    const broken = await listen((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const payload = Buffer.alloc(64 * 1024, 7);
    const working = await listen((req, res) => {
      res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const provider = new FakeStreamProvider('fake', async () => [
      makeCandidate({ id: 'best', transport: { kind: 'http', url: `${broken}/best.mp4` }, title: 'Best' }),
      makeCandidate({ id: 'second', resolution: '720p', transport: { kind: 'http', url: `${working}/second.mp4` }, title: 'Second' }),
    ]);
    const app = await appWith({ streamProviders: [provider], subtitleProviders: [] }, { COMPANION_ENABLED: 'true' });
    const base = await listen((req, res) => void app.requestHandler(req, res));

    const res = (await app.addonInterface.get('stream', 'movie', 'tt0032138', {})) as {
      streams: Array<{ url: string; description: string }>;
    };
    const first = res.streams[0];
    expect(first?.description).toContain('Best');
    expect(first?.url).toMatch(/\/companion\/play\/[0-9a-f-]{36}\/0$/);

    const playUrl = first!.url.replace('http://127.0.0.1:7000', base);
    const played = await fetch(playUrl, { headers: { Range: 'bytes=0-' } });
    expect(played.status).toBe(206);
    expect(Buffer.from(await played.arrayBuffer()).equals(payload)).toBe(true);

    // The failure is remembered and lowers the broken source in later rankings.
    const brokenCandidate = makeCandidate({ id: 'best', providerId: 'fake', transport: { kind: 'http', url: `${broken}/best.mp4` } });
    expect(app.reliability.reliabilityFor(brokenCandidate)).toBeLessThan(0.5);
  });

  it('reports an expired link clearly', async () => {
    const app = await appWith({ streamProviders: [], subtitleProviders: [] }, { COMPANION_ENABLED: 'true' });
    const base = await listen((req, res) => void app.requestHandler(req, res));
    const res = await fetch(`${base}/companion/play/00000000-0000-0000-0000-000000000000/0`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('expired');
  });
});
