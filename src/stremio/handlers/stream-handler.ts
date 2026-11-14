import type { HandlerArgs, Stream } from 'stremio-addon-sdk';
import type { FailoverSessionStore } from '../../companion/failover-sessions.js';
import { parsePreferences } from '../../config/preferences.js';
import { mediaKey } from '../../core/models/media.js';
import type { UserPreferences } from '../../core/models/preferences.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { StreamService } from '../../services/stream-ranking/stream-service.js';
import type { ErrorLog } from '../../services/diagnostics/error-log.js';
import { errorMessage } from '../../utils/async.js';
import { parseStremioId } from '../../utils/stremio-id.js';
import { formatStreams } from '../formatters/stream-formatter.js';

export interface StreamHandlerDeps {
  streamService: StreamService;
  defaults: UserPreferences;
  publicUrl: string;
  logger: Logger;
  companion?: FailoverSessionStore;
  errorLog?: ErrorLog;
}

export interface StreamResponse {
  streams: Stream[];
  cacheMaxAge?: number;
  staleRevalidate?: number;
}

// Availability changes quickly, so Stremio should not cache our answer for long.
const CACHE_OK = { cacheMaxAge: 120, staleRevalidate: 600 };
const CACHE_EMPTY = { cacheMaxAge: 60 };

export function createStreamHandler(deps: StreamHandlerDeps) {
  return async (args: HandlerArgs): Promise<StreamResponse> => {
    const media = parseStremioId(args.type, args.id);
    if (!media) return { streams: [], ...CACHE_EMPTY };

    const { prefs, issues } = parsePreferences(args.config ?? {}, deps.defaults);
    if (issues.length) deps.logger.warn({ issues }, 'Ignoring invalid preference values');

    try {
      const selection = await deps.streamService.select(media, prefs);
      for (const r of selection.reports) {
        if (r.status !== 'ok') deps.errorLog?.record(`${r.providerName} · ${args.type} ${args.id}`, r.error ?? r.status);
      }
      if (selection.ranked.length === 0) {
        return { streams: noResultStreams(deps.publicUrl, selection.reports), ...CACHE_EMPTY };
      }

      let rewriteHttpUrl: ((r: unknown, index: number) => string | undefined) | undefined;
      if (deps.companion) {
        const { session, entryFor } = deps.companion.create(
          mediaKey(media),
          selection.ranked.map((r) => r.candidate),
        );
        rewriteHttpUrl = (_r, index) => {
          const entry = entryFor(index);
          return entry === undefined ? undefined : `${deps.publicUrl}/companion/play/${session.id}/${entry}`;
        };
      }

      const streams = formatStreams(selection.ranked, { profile: prefs.rankingProfile, rewriteHttpUrl });
      return { streams, ...CACHE_OK };
    } catch (err) {
      deps.logger.error({ err: errorMessage(err), id: args.id }, 'Stream request failed');
      deps.errorLog?.record(`stream request · ${args.type} ${args.id}`, errorMessage(err));
      return { streams: internalErrorStream(deps.publicUrl, errorMessage(err)), ...CACHE_EMPTY };
    }
  };
}

/**
 * Nothing playable. If sources simply had nothing for this title, or none of the configured sources
 * covers this kind of title (e.g. series when only the Internet Archive is enabled), return an empty
 * list and let Stremio show its normal "no streams" state. Only when sources actually failed do we
 * show one clearly-labelled entry that opens the status page.
 */
function noResultStreams(
  publicUrl: string,
  reports: Array<{ status: string; providerName: string; error?: string }>,
): Stream[] {
  const failed = reports.filter((r) => r.status !== 'ok');
  if (failed.length === 0) return [];
  const names = failed.map((r) => `${r.providerName} (${r.status === 'timeout' ? 'timed out' : 'failed'})`).join(', ');
  return [
    {
      name: 'AutoPilot\n⚠️',
      description: `No streams: ${names}.\nTry again in a minute. Tap for details.`,
      externalUrl: `${publicUrl}/status`,
    },
  ];
}

function internalErrorStream(publicUrl: string, message: string): Stream[] {
  return [
    {
      name: 'AutoPilot\n⚠️',
      description: `No streams: internal error (${message.slice(0, 80)}).\nTap for details.`,
      externalUrl: `${publicUrl}/status`,
    },
  ];
}
