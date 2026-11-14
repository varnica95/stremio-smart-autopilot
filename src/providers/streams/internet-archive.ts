import type { ProviderContext, StreamProvider } from '../../core/interfaces/providers.js';
import type { MediaRequest } from '../../core/models/media.js';
import type { StreamCandidate, VideoCodec } from '../../core/models/stream.js';
import { resolutionFromHeight } from '../../core/parsing/release-parser.js';
import { requestJson, type FetchLike } from '../../infrastructure/http/http-client.js';
import { RateLimiter } from '../../utils/rate-limiter.js';
import { buildCandidate, normalizeTitle } from './normalize.js';

const BASE = 'https://archive.org';
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mkv|webm|ogv|avi|mov|mpe?g)$/i;
const MAX_ITEMS = 3;

interface SearchResponse {
  response?: { docs?: Array<{ identifier?: string; title?: string | string[]; year?: string | number; downloads?: number }> };
}
interface ItemFile {
  name?: string;
  format?: string;
  size?: string | number;
  height?: string | number;
  source?: string;
}
interface ItemMetadata {
  is_dark?: boolean;
  files?: ItemFile[];
  metadata?: { title?: string | string[] };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function codecFromFormat(format: string | undefined): VideoCodec | undefined {
  if (!format) return undefined;
  if (/h\.?264/i.test(format)) return 'h264';
  if (/hevc|h\.?265/i.test(format)) return 'hevc';
  return undefined;
}

/**
 * Internet Archive (archive.org): public-domain and openly licensed films served over plain HTTPS
 * through its public search and metadata APIs. Movies only; matched by title and year.
 */
export class InternetArchiveProvider implements StreamProvider {
  readonly id = 'internet-archive';
  readonly name = 'Internet Archive';
  readonly peerToPeer = false;
  private readonly limiter = new RateLimiter(5, 5);

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  supports(media: MediaRequest): boolean {
    return media.type === 'movie';
  }

  async findStreams(_media: MediaRequest, ctx: ProviderContext): Promise<StreamCandidate[]> {
    const title = ctx.metadata.title;
    // Without a title there is nothing to search for; report it so the user sees why.
    if (!title) throw new Error('title metadata unavailable (Cinemeta did not answer)');
    const identifiers = await this.searchIdentifiers(title, ctx.metadata.year, ctx.signal);
    const perItem = await Promise.all(identifiers.map((id) => this.itemStreams(id, ctx.signal).catch(() => [])));
    return perItem.flat();
  }

  private async searchIdentifiers(title: string, year: number | undefined, signal: AbortSignal): Promise<string[]> {
    const escaped = title.replace(/["\\]/g, ' ');
    let q = `title:("${escaped}") AND mediatype:(movies)`;
    if (year) q += ` AND year:[${year - 1} TO ${year + 1}]`;
    const params = new URLSearchParams({ q, rows: '10', output: 'json' });
    for (const field of ['identifier', 'title', 'year', 'downloads']) params.append('fl[]', field);
    params.append('sort[]', 'downloads desc');

    const data = await requestJson<SearchResponse>(this.fetchImpl, `${BASE}/advancedsearch.php?${params}`, {
      signal,
      rateLimiter: this.limiter,
    });
    const wanted = normalizeTitle(title);
    return (data.response?.docs ?? [])
      .filter((doc) => {
        const docTitle = first(doc.title);
        if (!doc.identifier || !docTitle || normalizeTitle(docTitle) !== wanted) return false;
        const docYear = Number(doc.year);
        return !year || !Number.isFinite(docYear) || Math.abs(docYear - year) <= 1;
      })
      .slice(0, MAX_ITEMS)
      .map((doc) => doc.identifier as string);
  }

  private async itemStreams(identifier: string, signal: AbortSignal): Promise<StreamCandidate[]> {
    const item = await requestJson<ItemMetadata>(this.fetchImpl, `${BASE}/metadata/${encodeURIComponent(identifier)}`, {
      signal,
      rateLimiter: this.limiter,
    });
    if (item.is_dark || !item.files) return [];
    const itemTitle = first(item.metadata?.title) ?? identifier;

    return item.files
      .filter((f): f is ItemFile & { name: string } => typeof f.name === 'string' && VIDEO_EXTENSIONS.test(f.name))
      .map((file) => {
        const path = file.name.split('/').map(encodeURIComponent).join('/');
        const url = `${BASE}/download/${encodeURIComponent(identifier)}/${path}`;
        return buildCandidate({
          providerId: this.id,
          providerName: this.name,
          transport: { kind: 'http', url },
          title: `${itemTitle} · ${file.format ?? file.name}`,
          filename: file.name.split('/').pop(),
          sizeBytes: Number(file.size) || undefined,
          resolution: resolutionFromHeight(Number(file.height)),
          videoCodec: codecFromFormat(file.format),
        });
      });
  }
}
