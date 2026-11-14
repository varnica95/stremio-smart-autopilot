import type { MetadataProvider } from '../../core/interfaces/providers.js';
import type { MediaMetadata, MediaRequest } from '../../core/models/media.js';
import { requestJson, type FetchLike } from '../../infrastructure/http/http-client.js';

interface CinemetaResponse {
  meta?: {
    name?: string;
    year?: string | number;
    releaseInfo?: string;
    runtime?: string;
  };
}

/** Parses "148 min", "1h 30min", "2 h" into minutes. */
export function parseRuntimeMinutes(runtime: string | undefined): number | undefined {
  if (!runtime) return undefined;
  const hours = /(\d+)\s*h/i.exec(runtime);
  const minutes = /(\d+)\s*m/i.exec(runtime);
  const total = (hours?.[1] ? Number(hours[1]) * 60 : 0) + (minutes?.[1] ? Number(minutes[1]) : 0);
  return total > 0 ? total : undefined;
}

/** Stremio's official metadata addon. Provides title, year and runtime for IMDb ids. */
export class CinemetaProvider implements MetadataProvider {
  readonly id = 'cinemeta';

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://v3-cinemeta.strem.io',
  ) {}

  async getMetadata(media: MediaRequest, signal: AbortSignal): Promise<MediaMetadata> {
    const url = `${this.baseUrl}/meta/${media.type}/${media.imdbId}.json`;
    const data = await requestJson<CinemetaResponse>(this.fetchImpl, url, { signal });
    const meta = data.meta ?? {};
    const yearText = String(meta.year ?? meta.releaseInfo ?? '');
    const year = Number(/\d{4}/.exec(yearText)?.[0]);
    return {
      title: meta.name,
      year: Number.isFinite(year) ? year : undefined,
      runtimeMinutes: parseRuntimeMinutes(meta.runtime),
    };
  }
}
