import type { MetadataProvider } from '../../core/interfaces/providers.js';
import type { MediaMetadata, MediaRequest } from '../../core/models/media.js';
import { requestJson, type FetchLike } from '../../infrastructure/http/http-client.js';

interface FindResponse {
  movie_results?: Array<{ title?: string; original_language?: string; release_date?: string }>;
  tv_results?: Array<{ name?: string; original_language?: string; first_air_date?: string }>;
}

/**
 * Optional. TMDB's /find endpoint maps an IMDb id to the title's original language, which is what
 * the "original" subtitle-language preference needs. Requires your own TMDB API key (v3 key).
 */
export class TmdbProvider implements MetadataProvider {
  readonly id = 'tmdb';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async getMetadata(media: MediaRequest, signal: AbortSignal): Promise<MediaMetadata> {
    const params = new URLSearchParams({ external_source: 'imdb_id', api_key: this.apiKey });
    const url = `https://api.themoviedb.org/3/find/${media.imdbId}?${params}`;
    const data = await requestJson<FindResponse>(this.fetchImpl, url, { signal });
    const hit = media.type === 'movie' ? data.movie_results?.[0] : data.tv_results?.[0];
    if (!hit) return {};
    const lang = hit.original_language?.toLowerCase();
    return { originalLanguage: lang && /^[a-z]{2}$/.test(lang) ? lang : undefined };
  }
}
