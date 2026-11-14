import { transportKey } from '../../core/dedupe.js';
import type { Resolution, StreamCandidate, StreamTransport, VideoCodec } from '../../core/models/stream.js';
import { parseReleaseName } from '../../core/parsing/release-parser.js';

export interface RawStreamInput {
  providerId: string;
  providerName: string;
  transport: StreamTransport;
  title: string;
  filename?: string;
  /** Extra free text (e.g. an addon's description) used only for parsing. */
  extraText?: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  videoHash?: string;
  /** Authoritative values from structured metadata; override what is parsed from text. */
  resolution?: Resolution;
  videoCodec?: VideoCodec;
  languages?: string[];
}

/** Turns provider output into a StreamCandidate, parsing quality hints from names. */
export function buildCandidate(input: RawStreamInput): StreamCandidate {
  const text = [input.extraText, input.title, input.filename].filter(Boolean).join(' ');
  const parsed = parseReleaseName(text);
  const resolution = input.resolution && input.resolution !== 'unknown' ? input.resolution : parsed.resolution;
  const videoCodec = input.videoCodec && input.videoCodec !== 'unknown' ? input.videoCodec : parsed.videoCodec;
  const validCount = (n: number | undefined): number | undefined =>
    n !== undefined && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;

  return {
    id: transportKey(input.transport),
    providerId: input.providerId,
    providerName: input.providerName,
    transport: input.transport,
    title: input.title,
    filename: input.filename,
    sizeBytes: input.sizeBytes && input.sizeBytes > 0 ? input.sizeBytes : undefined,
    resolution,
    videoCodec,
    audioCodecs: parsed.audioCodecs,
    hdr: parsed.hdr,
    source: parsed.source,
    releaseGroup: input.filename ? parseReleaseName(input.filename).releaseGroup : parsed.releaseGroup,
    languages: input.languages?.length ? input.languages : parsed.languages,
    seeders: validCount(input.seeders),
    leechers: validCount(input.leechers),
    videoHash: input.videoHash,
  };
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}
