import type { RankedSubtitle, SubtitleCandidate, VideoFileHints } from '../../core/models/subtitle.js';
import { parseReleaseName, parseSource } from '../../core/parsing/release-parser.js';
import type { ReleaseSource } from '../../core/models/stream.js';

const STOP_TOKENS = new Set(['mkv', 'mp4', 'avi', 'srt', 'sub', 'the', 'and', 'of', 'a']);

export function releaseTokens(text: string | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/\.(mkv|mp4|avi|m4v|srt|sub|ass)$/i, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t)),
  );
}

/** Jaccard similarity of release-name tokens, 0..1. */
export function releaseSimilarity(a: string | undefined, b: string | undefined): number {
  const ta = releaseTokens(a);
  const tb = releaseTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Sources that are normally encoded at 23.976 fps (film) vs. 25 fps (PAL broadcast/DVD). */
const FILM_RATE_SOURCES = new Set<ReleaseSource>(['remux', 'bluray', 'web-dl', 'webrip']);

function sourceFamily(source: ReleaseSource): string {
  if (source === 'remux' || source === 'bluray') return 'bluray';
  if (source === 'web-dl' || source === 'webrip') return 'web';
  return source;
}

/**
 * Scores how likely a subtitle is to be in sync with the user's file. Exact hash matches dominate;
 * then release-name similarity, release group, source family and frame rate.
 */
export function scoreSubtitle(sub: SubtitleCandidate, file: VideoFileHints): number {
  let score = 0;
  if (sub.hashMatch) score += 60;

  const subName = sub.release ?? sub.fileName;
  if (file.filename && subName) {
    score += 30 * releaseSimilarity(file.filename, subName);
    const fileRelease = parseReleaseName(file.filename);
    const subRelease = parseReleaseName(subName);
    if (fileRelease.releaseGroup && subRelease.releaseGroup) {
      score += fileRelease.releaseGroup.toLowerCase() === subRelease.releaseGroup.toLowerCase() ? 12 : -4;
    }
    if (fileRelease.source !== 'unknown' && subRelease.source !== 'unknown') {
      score += sourceFamily(fileRelease.source) === sourceFamily(subRelease.source) ? 6 : -8;
    }
    if (fileRelease.resolution !== 'unknown' && fileRelease.resolution === subRelease.resolution) score += 3;

    // A 25 fps subtitle on a 23.976 fps film source drifts out of sync within minutes.
    const fileSource = parseSource(file.filename);
    if (sub.fps && FILM_RATE_SOURCES.has(fileSource)) {
      score += Math.abs(sub.fps - 23.976) < 0.1 || Math.abs(sub.fps - 24) < 0.1 ? 4 : -10;
    }
  }

  if (sub.machineTranslated) score -= 25;
  if (sub.fromTrustedUploader) score += 5;
  if (sub.hearingImpaired) score -= 2;
  score += Math.min(10, Math.log10(sub.downloadCount + 1) * 3);
  return Math.round(score * 10) / 10;
}

function dedupeKey(sub: SubtitleCandidate): string {
  const name = (sub.release ?? sub.fileName ?? sub.id).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${sub.language}|${name}|${sub.hearingImpaired ? 'hi' : ''}`;
}

/**
 * Ranks subtitles: language priority first, then sync likelihood. Removes duplicates (same file id,
 * or same language + release name) and keeps at most `perLanguage` entries per language.
 */
export function rankSubtitles(
  subtitles: SubtitleCandidate[],
  languages: string[],
  file: VideoFileHints,
  perLanguage: number,
): RankedSubtitle[] {
  const scored = subtitles
    .filter((s) => languages.includes(s.language))
    .map((subtitle) => ({ subtitle, score: scoreSubtitle(subtitle, file), languageRank: languages.indexOf(subtitle.language) }))
    .sort((a, b) => a.languageRank - b.languageRank || b.score - a.score || a.subtitle.id.localeCompare(b.subtitle.id));

  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const perLangCount = new Map<string, number>();
  const out: RankedSubtitle[] = [];
  for (const entry of scored) {
    const idKey = `${entry.subtitle.providerId}:${entry.subtitle.id}`;
    const key = dedupeKey(entry.subtitle);
    if (seenIds.has(idKey) || seenKeys.has(key)) continue;
    const count = perLangCount.get(entry.subtitle.language) ?? 0;
    if (count >= perLanguage) continue;
    seenIds.add(idKey);
    seenKeys.add(key);
    perLangCount.set(entry.subtitle.language, count + 1);
    out.push(entry);
  }
  return out;
}
