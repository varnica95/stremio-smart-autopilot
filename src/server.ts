import type { IncomingMessage, ServerResponse } from 'node:http';
import sdk, { type AddonInterface } from 'stremio-addon-sdk';
import type { FailoverProxy } from './companion/failover-proxy.js';
import { sendText } from './companion/failover-proxy.js';
import { parsePreferences } from './config/preferences.js';
import type { SubtitleFileSource } from './core/interfaces/providers.js';
import type { UserPreferences } from './core/models/preferences.js';
import type { Logger } from './infrastructure/logging/logger.js';
import type { CacheService } from './services/caching/cache-service.js';
import { errorMessage } from './utils/async.js';
import { KeyedRateLimiter } from './utils/rate-limiter.js';
import { renderConfigurePage, type PageContext } from './stremio/pages/configure-page.js';
import { renderStatusPage, type StatusContext } from './stremio/pages/status-page.js';

export interface ServerDeps {
  addonInterface: AddonInterface;
  logger: Logger;
  cache: CacheService;
  defaults: UserPreferences;
  page: Omit<PageContext, 'prefs'>;
  status: () => StatusContext;
  subtitleSources: SubtitleFileSource[];
  companion?: FailoverProxy;
  /** For tests: replace the SDK router. */
  sdkRouter?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
}

const SUBTITLE_FILE_TTL_MS = 24 * 3_600_000;

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** Builds the HTTP handler: the addon's own pages and routes first, then the official SDK router. */
export function createRequestHandler(deps: ServerDeps) {
  const sdkRouter = deps.sdkRouter ?? sdk.getRouter(deps.addonInterface);
  const subtitleLimiter = new KeyedRateLimiter(60, 60_000);
  const subtitleSources = new Map(deps.subtitleSources.map((s) => [s.id, s]));

  async function serveSubtitleFile(req: IncomingMessage, res: ServerResponse, providerId: string, fileId: string): Promise<void> {
    const source = subtitleSources.get(providerId);
    if (!source) return sendText(res, 404, 'Unknown subtitle provider');
    if (!subtitleLimiter.allow(clientIp(req))) return sendText(res, 429, 'Too many subtitle downloads; slow down.');

    try {
      const file = await deps.cache.getOrLoad<{ base64: string; contentType: string }>(
        `subfile:${providerId}:${fileId}`,
        SUBTITLE_FILE_TTL_MS,
        async () => {
          const result = await source.fetchSubtitleFile(fileId, AbortSignal.timeout(15_000));
          return { base64: result.body.toString('base64'), contentType: result.contentType };
        },
      );
      res.writeHead(200, {
        'Content-Type': file.contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(Buffer.from(file.base64, 'base64'));
    } catch (err) {
      deps.logger.warn({ providerId, fileId, err: errorMessage(err) }, 'Subtitle download failed');
      sendText(res, 502, 'Subtitle could not be downloaded (provider quota reached or file unavailable).');
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const segments = path.split('/').filter(Boolean);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        });
        res.end();
        return;
      }

      if (path === '/' || path === '/configure') {
        return sendHtml(res, renderConfigurePage({ ...deps.page, prefs: deps.defaults }));
      }
      if (segments.length === 2 && segments[1] === 'configure') {
        // "/{config}/configure": Stremio's Configure button for an installed, configured addon.
        let raw: unknown = {};
        try {
          raw = JSON.parse(decodeURIComponent(segments[0] as string));
        } catch {
          raw = {};
        }
        return sendHtml(res, renderConfigurePage({ ...deps.page, prefs: parsePreferences(raw, deps.defaults).prefs }));
      }
      if (path === '/health') return sendJson(res, 200, { ok: true });
      if (path === '/status') return sendHtml(res, renderStatusPage(deps.status()));

      const subMatch = /^\/subtitles-file\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)\.srt$/.exec(path);
      if (subMatch?.[1] && subMatch[2]) return await serveSubtitleFile(req, res, subMatch[1], subMatch[2]);

      const playMatch = /^\/companion\/play\/([0-9a-f-]{36})\/(\d+)$/.exec(path);
      if (playMatch?.[1] && playMatch[2]) {
        if (!deps.companion) return sendText(res, 404, 'Companion is disabled');
        return await deps.companion.handle(req, res, playMatch[1], Number(playMatch[2]));
      }

      sdkRouter(req, res, () => sendJson(res, 404, { err: 'not found' }));
    } catch (err) {
      deps.logger.error({ err: errorMessage(err), path }, 'Unhandled request error');
      sendText(res, 500, 'Internal error');
    }
  };
}
