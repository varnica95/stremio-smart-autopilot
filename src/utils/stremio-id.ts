import type { MediaRequest } from '../core/models/media.js';

const IMDB_ID = /^tt\d{5,10}$/;

/**
 * Parses Stremio video ids: "tt0111161" for movies, "tt0944947:1:5" for series episodes.
 * Returns undefined for ids this addon does not handle.
 */
export function parseStremioId(type: string, id: string): MediaRequest | undefined {
  if (type === 'movie') {
    return IMDB_ID.test(id) ? { type: 'movie', imdbId: id } : undefined;
  }
  if (type === 'series') {
    const [imdbId, s, e] = id.split(':');
    const season = Number(s);
    const episode = Number(e);
    if (!imdbId || !IMDB_ID.test(imdbId) || !Number.isInteger(season) || !Number.isInteger(episode)) return undefined;
    if (season < 0 || episode < 0) return undefined;
    return { type: 'series', imdbId, season, episode };
  }
  return undefined;
}
