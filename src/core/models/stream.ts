export const RESOLUTION_ORDER = ['360p', '480p', '576p', '720p', '1080p', '1440p', '2160p'] as const;
export type KnownResolution = (typeof RESOLUTION_ORDER)[number];
export type Resolution = KnownResolution | 'unknown';

export type VideoCodec = 'av1' | 'hevc' | 'h264' | 'vp9' | 'mpeg2' | 'xvid' | 'unknown';
export type AudioCodec =
  | 'aac'
  | 'ac3'
  | 'eac3'
  | 'dts'
  | 'dts-hd'
  | 'truehd'
  | 'opus'
  | 'flac'
  | 'mp3'
  | 'unknown';

export type ReleaseSource =
  | 'remux'
  | 'bluray'
  | 'web-dl'
  | 'webrip'
  | 'hdtv'
  | 'dvdrip'
  | 'screener'
  | 'telesync'
  | 'cam'
  | 'unknown';

/** How the player obtains the bytes. Mirrors the source kinds of the Stremio stream object. */
export type StreamTransport =
  | { kind: 'http'; url: string; requestHeaders?: Record<string, string> }
  | { kind: 'torrent'; infoHash: string; fileIdx?: number; trackers?: string[] }
  | { kind: 'external'; url: string };

/**
 * A stream returned by a provider after normalization.
 * Nothing here says the stream works: availability is tracked separately (see StreamHealth).
 */
export interface StreamCandidate {
  /** Stable identifier derived from the transport, used for de-duplication and health tracking. */
  id: string;
  providerId: string;
  providerName: string;
  /** Other providers that returned the same source (filled in by de-duplication). */
  alsoFrom?: string[];
  transport: StreamTransport;
  /** Other URLs serving the identical file (same name and size), usable as fallbacks. */
  mirrors?: StreamTransport[];
  /** Release / file name as reported by the provider. */
  title: string;
  filename?: string;
  sizeBytes?: number;
  resolution: Resolution;
  videoCodec: VideoCodec;
  audioCodecs: AudioCodec[];
  hdr: string[];
  source: ReleaseSource;
  releaseGroup?: string;
  /** ISO 639-1 audio languages, when known. */
  languages: string[];
  /** Peer counts exactly as reported by the provider. They are not verified. */
  seeders?: number;
  leechers?: number;
  /** OpenSubtitles hash of the file, when the provider knows it (improves subtitle matching). */
  videoHash?: string;
}

export type HealthStatus = 'verified' | 'unverified' | 'failed';

/** Result of an active check (or lack thereof) against a stream. */
export interface StreamHealth {
  status: HealthStatus;
  /** Time to first byte of the test request. */
  ttfbMs?: number;
  /** Observed throughput in bytes per second. */
  throughputBps?: number;
  checkedAt: number;
  detail?: string;
}
