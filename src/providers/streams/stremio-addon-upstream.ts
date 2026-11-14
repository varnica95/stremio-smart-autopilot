import type { ProviderContext, StreamProvider } from '../../core/interfaces/providers.js';
import type { MediaRequest } from '../../core/models/media.js';
import type { StreamCandidate, StreamTransport } from '../../core/models/stream.js';
import { parseSeeders, parseSize } from '../../core/parsing/release-parser.js';
import { requestJson, type FetchLike } from '../../infrastructure/http/http-client.js';
import { buildCandidate } from './normalize.js';

interface UpstreamStream {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  externalUrl?: string;
  behaviorHints?: {
    filename?: string;
    videoSize?: number;
    videoHash?: string;
    proxyHeaders?: { request?: Record<string, string> };
  };
}

export function toStremioVideoId(media: MediaRequest): string {
  return media.type === 'series' ? `${media.imdbId}:${media.season}:${media.episode}` : media.imdbId;
}

function transportOf(stream: UpstreamStream): StreamTransport | undefined {
  if (stream.url) {
    return { kind: 'http', url: stream.url, requestHeaders: stream.behaviorHints?.proxyHeaders?.request };
  }
  if (stream.infoHash && /^[a-f0-9]{40}$/i.test(stream.infoHash)) {
    const trackers = (stream.sources ?? []).filter((s) => s.startsWith('tracker:')).map((s) => s.slice(8));
    return { kind: 'torrent', infoHash: stream.infoHash.toLowerCase(), fileIdx: stream.fileIdx, trackers };
  }
  if (stream.externalUrl) return { kind: 'external', url: stream.externalUrl };
  return undefined;
}

/**
 * Reads streams from another Stremio addon over the public addon protocol.
 *
 * Stremio itself never lets one addon see the results of other installed addons, so this is the
 * only supported way to rank several sources together: list the addon here instead of (or as well
 * as) installing it in Stremio. Only configure addons and sources you are authorized to use.
 */
export class StremioAddonUpstreamProvider implements StreamProvider {
  readonly peerToPeer = true;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/manifest\.json$/, '').replace(/\/+$/, '');
  }

  supports(): boolean {
    return true;
  }

  async findStreams(media: MediaRequest, ctx: ProviderContext): Promise<StreamCandidate[]> {
    const url = `${this.baseUrl}/stream/${media.type}/${toStremioVideoId(media)}.json`;
    const data = await requestJson<{ streams?: UpstreamStream[] }>(this.fetchImpl, url, { signal: ctx.signal });
    const out: StreamCandidate[] = [];
    for (const stream of data.streams ?? []) {
      const transport = transportOf(stream);
      if (!transport) continue;
      const text = [stream.name, stream.title, stream.description].filter(Boolean).join('\n');
      const firstLine = (stream.description ?? stream.title ?? stream.name ?? '').split('\n')[0]?.trim();
      out.push(
        buildCandidate({
          providerId: this.id,
          providerName: this.name,
          transport,
          title: firstLine || this.name,
          filename: stream.behaviorHints?.filename,
          extraText: text,
          sizeBytes: stream.behaviorHints?.videoSize ?? parseSize(text),
          seeders: transport.kind === 'torrent' ? parseSeeders(text) : undefined,
          videoHash: stream.behaviorHints?.videoHash,
        }),
      );
    }
    return out;
  }
}
