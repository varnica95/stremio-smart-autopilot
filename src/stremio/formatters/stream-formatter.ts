import type { Stream } from 'stremio-addon-sdk';
import type { RankingProfileId } from '../../core/models/preferences.js';
import type { AudioCodec, StreamCandidate, VideoCodec } from '../../core/models/stream.js';
import { getRankingProfile } from '../../core/ranking/profiles.js';
import type { RankedStream } from '../../core/ranking/ranker.js';
import { formatAge, formatBytes, formatRate } from '../../utils/format.js';

const VIDEO_LABEL: Record<VideoCodec, string | undefined> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2: 'MPEG-2',
  xvid: 'XviD',
  unknown: undefined,
};
const AUDIO_LABEL: Record<AudioCodec, string> = {
  aac: 'AAC',
  ac3: 'DD',
  eac3: 'DD+',
  dts: 'DTS',
  'dts-hd': 'DTS-HD',
  truehd: 'TrueHD',
  opus: 'Opus',
  flac: 'FLAC',
  mp3: 'MP3',
  unknown: '',
};

export interface FormatOptions {
  profile: RankingProfileId;
  now?: number;
  /** Replaces the URL of an HTTP stream (used by the companion's failover proxy). */
  rewriteHttpUrl?: (ranked: RankedStream, index: number) => string | undefined;
}

function availabilityLine(r: RankedStream, now: number): string {
  const h = r.health;
  if (h?.status === 'verified') {
    const speed = h.throughputBps ? ` · ~${formatRate(h.throughputBps)}` : '';
    return `✅ Answered a test request ${formatAge(now - h.checkedAt)}${speed}`;
  }
  if (h?.status === 'failed') return `❌ Failed a test request${h.detail ? ` (${h.detail})` : ''}`;
  const c = r.candidate;
  if (c.transport.kind === 'torrent') {
    const peers = c.seeders !== undefined ? `👤 ${c.seeders} seeders (reported, unverified)` : '👤 seeders unknown';
    return peers;
  }
  return '⚪ Not tested';
}

function techLine(c: StreamCandidate): string {
  const parts: string[] = [];
  if (c.sizeBytes) parts.push(`💾 ${formatBytes(c.sizeBytes)}`);
  const video = [VIDEO_LABEL[c.videoCodec], ...c.hdr].filter(Boolean).join(' ');
  if (video) parts.push(`🎞 ${video}`);
  const audio = c.audioCodecs.map((a) => AUDIO_LABEL[a]).filter(Boolean).join('/');
  if (audio) parts.push(`🔊 ${audio}`);
  if (c.source !== 'unknown') parts.push(c.source.toUpperCase());
  return parts.join(' · ');
}

function bingeGroup(c: StreamCandidate): string {
  // Same provider + resolution + release group → Stremio can auto-select the next episode.
  return ['autopilot', c.providerId, c.resolution, c.releaseGroup ?? c.source].join('|');
}

/** Builds the Stremio stream object, including a short "why this rank" explanation. */
export function formatStream(r: RankedStream, index: number, options: FormatOptions): Stream {
  const c = r.candidate;
  const now = options.now ?? Date.now();
  const res = c.resolution === 'unknown' ? '?' : c.resolution;
  const badge = index === 0 && r.withinPreferences ? '⭐ ' : '';

  const why = r.reasons.slice(0, 2).join('; ');
  const lines = [
    c.title,
    techLine(c),
    availabilityLine(r, now),
    `🏷 ${c.providerName}${c.alsoFrom?.length ? ` (+${c.alsoFrom.length} more)` : ''} · score ${Math.round(r.score)}`,
    why ? `${index === 0 ? `👍 Ranked first (${profileLabel(options.profile)})` : 'ℹ️'}: ${why}` : undefined,
    r.warnings[0] ? `⚠️ ${r.warnings[0]}` : undefined,
  ].filter((l): l is string => Boolean(l));

  const stream: Stream = {
    name: `AutoPilot\n${badge}${res}`,
    description: lines.join('\n'),
    behaviorHints: {
      bingeGroup: bingeGroup(c),
      filename: c.filename,
      videoSize: c.sizeBytes,
      videoHash: c.videoHash,
    },
  };

  switch (c.transport.kind) {
    case 'http': {
      const proxied = options.rewriteHttpUrl?.(r, index);
      stream.url = proxied ?? c.transport.url;
      const container = (c.filename ?? c.transport.url).toLowerCase();
      const webFriendly = c.videoCodec === 'h264' && /\.mp4(\?|$)/.test(container);
      const needsHeaders = !proxied && c.transport.requestHeaders && Object.keys(c.transport.requestHeaders).length > 0;
      if (needsHeaders) stream.behaviorHints = { ...stream.behaviorHints, proxyHeaders: { request: c.transport.requestHeaders } };
      if (!webFriendly || needsHeaders) stream.behaviorHints = { ...stream.behaviorHints, notWebReady: true };
      break;
    }
    case 'torrent':
      stream.infoHash = c.transport.infoHash;
      if (c.transport.fileIdx !== undefined) stream.fileIdx = c.transport.fileIdx;
      stream.sources = [
        ...(c.transport.trackers ?? []).map((t) => `tracker:${t}`),
        `dht:${c.transport.infoHash}`,
      ];
      break;
    case 'external':
      stream.externalUrl = c.transport.url;
      break;
  }
  return stream;
}

export function formatStreams(ranked: RankedStream[], options: FormatOptions): Stream[] {
  return ranked.map((r, i) => formatStream(r, i, options));
}

export function profileLabel(profile: RankingProfileId): string {
  return getRankingProfile(profile).label;
}
