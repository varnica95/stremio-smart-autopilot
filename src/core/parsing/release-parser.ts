import type { AudioCodec, ReleaseSource, Resolution, VideoCodec } from '../models/stream.js';

/** Builds a case-insensitive regex that only matches whole tokens (not inside other words). */
function tok(pattern: string): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, 'i');
}

const RESOLUTION_PATTERNS: Array<[Resolution, RegExp]> = [
  ['2160p', tok('2160p|4k|uhd')],
  ['1440p', tok('1440p')],
  ['1080p', tok('1080[pi]|fhd')],
  ['720p', tok('720p')],
  ['576p', tok('576p')],
  ['480p', tok('480p|sd|dvdrip')],
  ['360p', tok('360p')],
];

const VIDEO_CODEC_PATTERNS: Array<[VideoCodec, RegExp]> = [
  ['av1', tok('av1')],
  ['hevc', tok('x265|h\\.?265|hevc')],
  ['h264', tok('x264|h\\.?264|avc')],
  ['vp9', tok('vp9')],
  ['xvid', tok('xvid|divx')],
  ['mpeg2', tok('mpeg-?2')],
];

const AUDIO_CODEC_PATTERNS: Array<[AudioCodec, RegExp]> = [
  ['truehd', tok('true-?hd')],
  ['dts-hd', tok('dts-?hd(?:[ .-]?ma)?|dts-?x|dts[ .-]?ma')],
  ['dts', tok('dts')],
  ['eac3', tok('ddp(?:\\s?\\d\\.\\d)?|dd\\+|e-?ac-?3')],
  ['ac3', tok('dd(?:\\s?\\d\\.\\d)|ac-?3|dolby[ .]digital')],
  ['aac', tok('aac(?:\\s?\\d\\.\\d)?')],
  ['opus', tok('opus')],
  ['flac', tok('flac')],
  ['mp3', tok('mp3')],
];

const SOURCE_PATTERNS: Array<[ReleaseSource, RegExp]> = [
  ['cam', tok('cam|camrip|hdcam')],
  ['telesync', tok('telesync|hdts|ts|telecine|tc')],
  ['screener', tok('scr|screener|dvdscr|bdscr')],
  ['remux', tok('remux')],
  ['bluray', tok('blu-?ray|bdrip|brrip|bdmux')],
  ['web-dl', tok('web-?dl|webdl')],
  ['webrip', tok('web-?rip')],
  ['hdtv', tok('hdtv|pdtv')],
  ['dvdrip', tok('dvd-?rip|dvd')],
  ['web-dl', tok('web')],
];

const HDR_PATTERNS: Array<[string, RegExp]> = [
  ['DV', tok('dv|dovi|dolby[ .]?vision')],
  ['HDR10+', /(?<![a-z0-9])hdr10\+/i],
  ['HDR10', tok('hdr10')],
  ['HDR', tok('hdr')],
];

const LANGUAGE_PATTERNS: Array<[string, RegExp]> = [
  ['hr', tok('croatian|hrv|cro')],
  ['en', tok('english|eng')],
  ['sr', tok('serbian|srp')],
  ['bs', tok('bosnian|bos')],
  ['de', tok('german|ger|deu')],
  ['fr', tok('french|fre|fra|vff|truefrench')],
  ['es', tok('spanish|spa|castellano|latino')],
  ['it', tok('italian|ita')],
];

const SIZE_UNITS: Record<string, number> = {
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

export function parseResolution(text: string): Resolution {
  for (const [res, re] of RESOLUTION_PATTERNS) if (re.test(text)) return res;
  return 'unknown';
}

/** Maps a pixel height (e.g. from file metadata) to the nearest standard resolution. */
export function resolutionFromHeight(height: number | undefined): Resolution {
  if (!height || !Number.isFinite(height) || height <= 0) return 'unknown';
  if (height >= 1800) return '2160p';
  if (height >= 1300) return '1440p';
  if (height >= 900) return '1080p';
  if (height >= 650) return '720p';
  if (height >= 540) return '576p';
  if (height >= 420) return '480p';
  return '360p';
}

export function parseVideoCodec(text: string): VideoCodec {
  for (const [codec, re] of VIDEO_CODEC_PATTERNS) if (re.test(text)) return codec;
  return 'unknown';
}

export function parseAudioCodecs(text: string): AudioCodec[] {
  const found: AudioCodec[] = [];
  for (const [codec, re] of AUDIO_CODEC_PATTERNS) {
    if (!re.test(text)) continue;
    // "DTS-HD" also matches plain "DTS"; keep only the more specific one.
    if (codec === 'dts' && found.includes('dts-hd')) continue;
    found.push(codec);
  }
  return found;
}

export function parseSource(text: string): ReleaseSource {
  for (const [source, re] of SOURCE_PATTERNS) if (re.test(text)) return source;
  return 'unknown';
}

export function parseHdr(text: string): string[] {
  const found: string[] = [];
  for (const [label, re] of HDR_PATTERNS) {
    if (!re.test(text)) continue;
    if (label === 'HDR' && found.some((f) => f.startsWith('HDR'))) continue;
    if (label === 'HDR10' && found.includes('HDR10+')) continue;
    found.push(label);
  }
  return found;
}

export function parseLanguages(text: string): string[] {
  return LANGUAGE_PATTERNS.filter(([, re]) => re.test(text)).map(([code]) => code);
}

export function parseReleaseGroup(text: string): string | undefined {
  const withoutExt = text.trim().replace(/\.(mkv|mp4|avi|m4v|webm|ts)$/i, '');
  const match = /-([A-Za-z0-9]{2,20})$/.exec(withoutExt);
  return match?.[1];
}

/** Parses the first human-readable size ("4.2 GB", "700MB", "1,5 GiB") into bytes. */
export function parseSize(text: string): number | undefined {
  const match = /(\d+(?:[.,]\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)(?![a-z])/i.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  const value = Number.parseFloat(match[1].replace(',', '.'));
  const unit = SIZE_UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(value) || unit === undefined) return undefined;
  return Math.round(value * unit);
}

/** Extracts a seeder count from common addon label formats ("👤 123", "Seeders: 45", "S: 12"). */
export function parseSeeders(text: string): number | undefined {
  const match = /(?:👤|🌱|seeders?|seeds?)\s*:?\s*(\d{1,7})|(?<![a-z0-9])S:\s*(\d{1,7})/iu.exec(text);
  const digits = match?.[1] ?? match?.[2];
  if (!digits) return undefined;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) ? n : undefined;
}

export interface ParsedRelease {
  resolution: Resolution;
  videoCodec: VideoCodec;
  audioCodecs: AudioCodec[];
  hdr: string[];
  source: ReleaseSource;
  releaseGroup?: string;
  languages: string[];
}

const FILE_EXTENSION = /\.(mkv|mp4|avi|m4v|webm|ts|m2ts|mov|wmv|ogv|mpg|mpeg)$/i;

export function parseReleaseName(rawName: string): ParsedRelease {
  // Drop the extension first: ".ts" (MPEG transport stream) must not be read as "telesync".
  const name = rawName.trim().replace(FILE_EXTENSION, '');
  return {
    resolution: parseResolution(name),
    videoCodec: parseVideoCodec(name),
    audioCodecs: parseAudioCodecs(name),
    hdr: parseHdr(name),
    source: parseSource(name),
    releaseGroup: parseReleaseGroup(name),
    languages: parseLanguages(name),
  };
}
