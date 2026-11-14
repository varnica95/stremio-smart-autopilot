export type MediaType = 'movie' | 'series';

/** A single playable item: a movie, or one episode of a series. */
export interface MediaRequest {
  type: MediaType;
  imdbId: string;
  season?: number;
  episode?: number;
}

/** Descriptive metadata used to improve discovery and matching. Every field is optional. */
export interface MediaMetadata {
  title?: string;
  year?: number;
  runtimeMinutes?: number;
  /** ISO 639-1 code of the original spoken language, when a metadata source provides it. */
  originalLanguage?: string;
}

export function mediaKey(media: MediaRequest): string {
  const base = `${media.type}:${media.imdbId}`;
  return media.season !== undefined && media.episode !== undefined
    ? `${base}:${media.season}:${media.episode}`
    : base;
}
