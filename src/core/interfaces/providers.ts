import type { MediaMetadata, MediaRequest } from '../models/media.js';
import type { StreamCandidate } from '../models/stream.js';
import type { SubtitleCandidate, VideoFileHints } from '../models/subtitle.js';

export interface ProviderContext {
  /** Aborted when the provider's time budget runs out or the request is cancelled. */
  signal: AbortSignal;
  metadata: MediaMetadata;
}

/**
 * A source of streams. Implementations only fetch and normalize; they never rank.
 * Add a provider by implementing this interface and registering it in providers/streams/index.ts.
 */
export interface StreamProvider {
  readonly id: string;
  readonly name: string;
  /** True when the provider can return BitTorrent sources (sets the manifest p2p hint). */
  readonly peerToPeer: boolean;
  supports(media: MediaRequest): boolean;
  findStreams(media: MediaRequest, ctx: ProviderContext): Promise<StreamCandidate[]>;
}

export interface SubtitleQuery {
  media: MediaRequest;
  /** ISO 639-1 codes, in order of preference. */
  languages: string[];
  file: VideoFileHints;
  /** Per-user credentials keyed by provider id (e.g. the user's own OpenSubtitles API key). */
  userCredentials?: Record<string, string>;
}

export interface SubtitleProvider {
  readonly id: string;
  readonly name: string;
  findSubtitles(query: SubtitleQuery, signal: AbortSignal): Promise<SubtitleCandidate[]>;
}

/** Returns the raw subtitle file for an id issued by the same provider. */
export interface SubtitleFileSource {
  readonly id: string;
  /** `userToken` is the opaque reference that was put in the subtitle URL, if any. */
  fetchSubtitleFile(
    fileId: string,
    signal: AbortSignal,
    userToken?: string,
  ): Promise<{ body: Buffer; contentType: string }>;
}

export interface MetadataProvider {
  readonly id: string;
  getMetadata(media: MediaRequest, signal: AbortSignal): Promise<MediaMetadata>;
}
