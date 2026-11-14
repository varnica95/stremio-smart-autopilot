import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FetchLike } from '../infrastructure/http/http-client.js';
import type { Logger } from '../infrastructure/logging/logger.js';
import { errorMessage, withTimeout } from '../utils/async.js';
import { formatRate } from '../utils/format.js';
import type { ReliabilityService } from '../services/reliability/reliability-service.js';
import type { FailoverSession, FailoverSessionStore, FailoverTarget, PlaybackRecord } from './failover-sessions.js';

const PASS_THROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
/** Below this upstream speed for a sustained window the playback is flagged as struggling. */
const SLOW_BPS = 400_000;
const WINDOW_MS = 10_000;

export interface FailoverProxyOptions {
  connectTimeoutMs: number;
}

/**
 * Optional local companion: a failover HTTP proxy for HTTP streams.
 *
 * Stremio gives addons no playback events and no way to switch the active stream. What an addon
 * *can* do is hand Stremio a URL it controls. When the player opens that URL, the proxy tries the
 * chosen source and, if it does not answer properly, transparently moves on to the next-ranked
 * source before any video byte is sent. After the first byte the source is pinned, because
 * switching to a different file mid-playback would corrupt the stream; only identical mirrors
 * (same file name and size) are used as replacements after that point.
 */
export class FailoverProxy {
  constructor(
    private readonly sessions: FailoverSessionStore,
    private readonly reliability: ReliabilityService,
    private readonly fetchImpl: FetchLike,
    private readonly logger: Logger,
    private readonly options: FailoverProxyOptions,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, startIndex: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !Number.isInteger(startIndex) || startIndex < 0 || startIndex >= session.chain.length) {
      sendText(res, 404, 'This stream link has expired. Close the player and open the title again in Stremio.');
      return;
    }

    let record = session.playbacks.get(startIndex);
    if (!record) {
      record = { startIndex, failedIndexes: [], bytesServed: 0, startedAt: Date.now(), lastActivityAt: Date.now() };
      session.playbacks.set(startIndex, record);
    }

    for (const index of this.attemptOrder(session, record)) {
      const target = session.chain[index];
      if (!target) continue;
      const served = await this.tryTarget(req, res, session, record, index, target);
      if (served) return;
      if (res.headersSent || req.destroyed) return;
    }

    record.problem = 'no source answered';
    sendText(res, 502, 'None of the ranked sources answered. Pick another stream in Stremio or try again later.');
  }

  /** Before pinning: this entry and everything ranked below it. After pinning: the pinned file and its mirrors. */
  private attemptOrder(session: FailoverSession, record: PlaybackRecord): number[] {
    const all = session.chain.map((_, i) => i);
    if (record.pinnedIndex === undefined) {
      return all.filter((i) => i >= record.startIndex && !record.failedIndexes.includes(i));
    }
    const pinned = session.chain[record.pinnedIndex];
    const mirrors = all.filter((i) => i !== record.pinnedIndex && session.chain[i]?.candidateId === pinned?.candidateId);
    return [record.pinnedIndex, ...mirrors.filter((i) => !record.failedIndexes.includes(i))];
  }

  private async tryTarget(
    req: IncomingMessage,
    res: ServerResponse,
    session: FailoverSession,
    record: PlaybackRecord,
    index: number,
    target: FailoverTarget,
  ): Promise<boolean> {
    const headers: Record<string, string> = { ...target.requestHeaders };
    const range = req.headers.range;
    if (typeof range === 'string') headers.Range = range;

    let upstream: Response;
    try {
      upstream = await withTimeout('companion-connect', this.options.connectTimeoutMs, (signal) =>
        this.fetchImpl(target.url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'follow', signal }),
      );
    } catch (err) {
      this.markFailed(record, index, target, `connection failed: ${errorMessage(err)}`);
      return false;
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if ((upstream.status !== 200 && upstream.status !== 206) || /text\/html/i.test(contentType)) {
      await upstream.body?.cancel().catch(() => undefined);
      // 416 means the requested range is invalid for this file; that is a client issue, not a failure.
      if (upstream.status === 416) {
        res.writeHead(416);
        res.end();
        return true;
      }
      this.markFailed(record, index, target, `HTTP ${upstream.status}`);
      return false;
    }

    if (record.pinnedIndex === undefined && index !== record.startIndex) {
      this.logger.info({ session: session.id, from: record.startIndex, to: index }, 'Companion fell back to next-ranked source');
    }
    record.pinnedIndex = index;
    const outHeaders: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
    for (const name of PASS_THROUGH_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) outHeaders[name] = value;
    }
    res.writeHead(upstream.status, outHeaders);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return true;
    }
    await this.pump(req, res, upstream.body, record, target);
    return true;
  }

  /** Copies the body, honouring back-pressure, and measures how fast the *source* delivers. */
  private async pump(
    req: IncomingMessage,
    res: ServerResponse,
    body: ReadableStream<Uint8Array>,
    record: PlaybackRecord,
    target: FailoverTarget,
  ): Promise<void> {
    const reader = body.getReader();
    let clientGone = false;
    const onClose = (): void => {
      clientGone = true;
      void reader.cancel().catch(() => undefined);
    };
    req.on('close', onClose);

    let bytes = 0;
    let readMs = 0;
    let windowBytes = 0;
    let windowReadMs = 0;
    let upstreamError: unknown;

    try {
      while (!clientGone) {
        const t0 = performance.now();
        const { done, value } = await reader.read();
        const dt = performance.now() - t0;
        if (done) break;
        bytes += value.byteLength;
        readMs += dt;
        windowBytes += value.byteLength;
        windowReadMs += dt;
        record.bytesServed += value.byteLength;
        record.lastActivityAt = Date.now();

        if (windowReadMs >= WINDOW_MS) {
          const bps = (windowBytes / windowReadMs) * 1000;
          record.slowestThroughputBps = Math.min(record.slowestThroughputBps ?? Infinity, bps);
          if (bps < SLOW_BPS) record.problem = `source is slow (${formatRate(bps)}); consider the next stream`;
          windowBytes = 0;
          windowReadMs = 0;
        }

        if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    } catch (err) {
      if (!clientGone) upstreamError = err;
    } finally {
      req.off('close', onClose);
    }

    const throughput = bytes > 1_000_000 && readMs > 0 ? (bytes / readMs) * 1000 : undefined;
    const candidate = { id: target.candidateId, providerId: target.providerId, transport: { kind: 'http' as const, url: target.url } };
    if (upstreamError) {
      record.problem = 'source stopped during playback';
      this.reliability.recordStreamOutcome(candidate, false, throughput);
      this.logger.warn({ target: target.label, err: errorMessage(upstreamError) }, 'Upstream failed mid-playback');
      res.destroy();
      return;
    }
    this.reliability.recordStreamOutcome(candidate, true, throughput);
    res.end();
  }

  private markFailed(record: PlaybackRecord, index: number, target: FailoverTarget, detail: string): void {
    record.failedIndexes.push(index);
    record.problem = `${target.label}: ${detail}`;
    this.reliability.recordStreamOutcome(
      { id: target.candidateId, providerId: target.providerId, transport: { kind: 'http', url: target.url } },
      false,
    );
    this.logger.info({ target: target.label, detail }, 'Companion source attempt failed');
  }
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}
