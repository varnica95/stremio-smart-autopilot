import type { StreamCandidate, StreamTransport } from './models/stream.js';

/** Canonical identity of a transport. Two candidates with the same key are the same source. */
export function transportKey(transport: StreamTransport): string {
  switch (transport.kind) {
    case 'torrent':
      return `bt:${transport.infoHash.toLowerCase()}:${transport.fileIdx ?? '*'}`;
    case 'http':
    case 'external':
      return `${transport.kind}:${normalizeUrl(transport.url)}`;
  }
}

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    url.searchParams.sort();
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch {
    return raw.trim();
  }
}

/** Secondary identity: same file name and exact size from different sources. */
function fileKey(c: StreamCandidate): string | undefined {
  if (!c.filename || !c.sizeBytes) return undefined;
  return `file:${c.filename.toLowerCase()}:${c.sizeBytes}`;
}

function richness(c: StreamCandidate): number {
  let n = 0;
  if (c.sizeBytes) n++;
  if (c.resolution !== 'unknown') n++;
  if (c.videoCodec !== 'unknown') n++;
  if (c.audioCodecs.length) n++;
  if (c.source !== 'unknown') n++;
  if (c.seeders !== undefined) n++;
  if (c.filename) n++;
  return n;
}

function merge(primary: StreamCandidate, other: StreamCandidate): StreamCandidate {
  const [keep, drop] = richness(other) > richness(primary) ? [other, primary] : [primary, other];
  const alsoFrom = new Set([...(keep.alsoFrom ?? []), ...(drop.alsoFrom ?? [])]);
  if (drop.providerId !== keep.providerId) alsoFrom.add(drop.providerName);
  const mirrors = [...(keep.mirrors ?? []), ...(drop.mirrors ?? [])];
  if (transportKey(drop.transport) !== transportKey(keep.transport)) mirrors.push(drop.transport);
  return {
    ...keep,
    mirrors: mirrors.length ? mirrors : undefined,
    seeders: maxDefined(keep.seeders, drop.seeders),
    leechers: maxDefined(keep.leechers, drop.leechers),
    sizeBytes: keep.sizeBytes ?? drop.sizeBytes,
    filename: keep.filename ?? drop.filename,
    videoHash: keep.videoHash ?? drop.videoHash,
    alsoFrom: alsoFrom.size ? [...alsoFrom] : undefined,
  };
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Collapses duplicates (same transport, or same file name + size within the same transport kind).
 * Keeps the richest metadata and remembers which other providers listed the source.
 */
export function dedupeCandidates(candidates: StreamCandidate[]): StreamCandidate[] {
  const byKey = new Map<string, StreamCandidate>();
  const alias = new Map<string, string>();

  for (const candidate of candidates) {
    const primaryKey = transportKey(candidate.transport);
    const secondary = fileKey(candidate);
    const secondaryKey = secondary ? `${candidate.transport.kind}|${secondary}` : undefined;
    const existingKey = byKey.has(primaryKey)
      ? primaryKey
      : secondaryKey
        ? alias.get(secondaryKey)
        : undefined;

    if (existingKey) {
      const existing = byKey.get(existingKey);
      if (existing) byKey.set(existingKey, merge(existing, candidate));
      continue;
    }
    byKey.set(primaryKey, candidate);
    if (secondaryKey) alias.set(secondaryKey, primaryKey);
  }
  return [...byKey.values()];
}
