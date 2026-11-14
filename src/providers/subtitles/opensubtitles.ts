import { createHash } from 'node:crypto';
import type { SubtitleFileSource, SubtitleProvider, SubtitleQuery } from '../../core/interfaces/providers.js';
import type { SubtitleCandidate } from '../../core/models/subtitle.js';
import { HttpError, requestJson, type FetchLike } from '../../infrastructure/http/http-client.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { MemoryStore } from '../../services/caching/memory-store.js';
import { RateLimiter } from '../../utils/rate-limiter.js';

const API = 'https://api.opensubtitles.com/api/v1';

interface SearchResponse {
  data?: Array<{
    id?: string;
    attributes?: {
      language?: string;
      release?: string;
      fps?: number;
      download_count?: number;
      hearing_impaired?: boolean;
      machine_translated?: boolean;
      ai_translated?: boolean;
      from_trusted?: boolean;
      moviehash_match?: boolean;
      files?: Array<{ file_id?: number; file_name?: string }>;
    };
  }>;
}

/** Where user keys are remembered, so subtitle URLs only need to carry an opaque token. */
export interface KeyRegistry {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
}

const USER_KEY_TTL_MS = 30 * 24 * 3_600_000;

export function userKeyToken(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 24);
}

export interface OpenSubtitlesOptions {
  /** Server-wide key. Optional: users can supply their own on the configure page. */
  apiKey?: string;
  userAgent: string;
  username?: string;
  password?: string;
  /** Public base URL of this addon; subtitle URLs point back here so downloads happen only on demand. */
  publicUrl: string;
}

/**
 * OpenSubtitles.com REST API (v1). Uses the user's own API key when they configured one,
 * otherwise the server's key. With neither, it returns no subtitles.
 *
 * A user's key never appears in subtitle URLs: they carry a hash-derived token instead, and the
 * server looks the key up in its registry when the player downloads the file.
 *
 * Search results are free; each actual download counts against your quota. To avoid spending the
 * quota on subtitles nobody opens, the addon returns links to its own /subtitles-file route and
 * only calls /download when the player requests the file.
 */
export class OpenSubtitlesProvider implements SubtitleProvider, SubtitleFileSource {
  readonly id = 'opensubtitles';
  readonly name = 'OpenSubtitles';
  // OpenSubtitles documents a limit of a few requests per second per client.
  private readonly limiter = new RateLimiter(5, 4);
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly options: OpenSubtitlesOptions,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly keys: KeyRegistry = new MemoryStore(),
  ) {}

  get hasServerKey(): boolean {
    return Boolean(this.options.apiKey);
  }

  /** The server's login token is only valid together with the server's own API key. */
  private headers(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = { 'Api-Key': apiKey, 'User-Agent': this.options.userAgent };
    const isServerKey = apiKey === this.options.apiKey;
    if (isServerKey && this.token && this.token.expiresAt > Date.now()) headers.Authorization = `Bearer ${this.token.value}`;
    return headers;
  }

  async findSubtitles(query: SubtitleQuery, signal: AbortSignal): Promise<SubtitleCandidate[]> {
    const userKey = query.userCredentials?.[this.id];
    const apiKey = userKey ?? this.options.apiKey;
    if (!apiKey) return [];
    let userToken: string | undefined;
    if (userKey) {
      userToken = userKeyToken(userKey);
      this.keys.set(`oskey:${userToken}`, userKey, USER_KEY_TTL_MS);
    }

    const { media, file } = query;
    const numericImdb = String(Number(media.imdbId.replace(/^tt/, '')));
    const params: Record<string, string> = {
      languages: [...query.languages].sort().join(','),
    };
    if (media.type === 'series') {
      params.parent_imdb_id = numericImdb;
      if (media.season !== undefined) params.season_number = String(media.season);
      if (media.episode !== undefined) params.episode_number = String(media.episode);
    } else {
      params.imdb_id = numericImdb;
    }
    if (file.videoHash && /^[a-f0-9]{16}$/i.test(file.videoHash)) params.moviehash = file.videoHash.toLowerCase();

    // The API asks for alphabetically sorted parameters to improve its cache hit rate.
    const search = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
    const data = await requestJson<SearchResponse>(this.fetchImpl, `${API}/subtitles?${search}`, {
      signal,
      headers: this.headers(apiKey),
      rateLimiter: this.limiter,
    });
    return this.normalize(data, userToken);
  }

  normalize(data: SearchResponse, userToken?: string): SubtitleCandidate[] {
    const suffix = userToken ? `?u=${userToken}` : '';
    const out: SubtitleCandidate[] = [];
    for (const item of data.data ?? []) {
      const a = item.attributes;
      const file = a?.files?.[0];
      const language = a?.language?.toLowerCase().slice(0, 2);
      if (!a || !file?.file_id || !language) continue;
      out.push({
        id: String(file.file_id),
        providerId: this.id,
        language,
        release: a.release,
        fileName: file.file_name,
        fps: a.fps && a.fps > 0 ? a.fps : undefined,
        hashMatch: a.moviehash_match === true,
        downloadCount: a.download_count ?? 0,
        hearingImpaired: a.hearing_impaired === true,
        machineTranslated: a.machine_translated === true || a.ai_translated === true,
        fromTrustedUploader: a.from_trusted === true,
        url: `${this.options.publicUrl}/subtitles-file/${this.id}/${file.file_id}.srt${suffix}`,
      });
    }
    return out;
  }

  async fetchSubtitleFile(
    fileId: string,
    signal: AbortSignal,
    userToken?: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    if (!/^\d+$/.test(fileId)) throw new HttpError(400, `${API}/download`, 'invalid subtitle id');
    const userKey = userToken ? this.keys.get<string>(`oskey:${userToken}`) : undefined;
    const apiKey = userKey ?? this.options.apiKey;
    if (!apiKey) throw new Error('no OpenSubtitles API key for this download; reopen the title so the addon sees your key again');
    if (!userKey) await this.ensureLogin(signal);
    const download = await requestJson<{ link?: string; remaining?: number }>(this.fetchImpl, `${API}/download`, {
      signal,
      method: 'POST',
      headers: this.headers(apiKey),
      body: { file_id: Number(fileId) },
      rateLimiter: this.limiter,
    });
    if (!download.link) throw new Error('OpenSubtitles returned no download link');
    if (download.remaining !== undefined && download.remaining < 5) {
      this.logger.warn({ remaining: download.remaining }, 'OpenSubtitles download quota almost used up');
    }
    const response = await this.fetchImpl(download.link, { signal });
    if (!response.ok) throw new HttpError(response.status, download.link);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: 'application/x-subrip; charset=utf-8',
    };
  }

  /** Logging in is optional; it raises the daily download quota for the account. */
  private async ensureLogin(signal: AbortSignal): Promise<void> {
    const { username, password, apiKey } = this.options;
    if (!username || !password || !apiKey) return;
    if (this.token && this.token.expiresAt > Date.now()) return;
    try {
      const res = await requestJson<{ token?: string }>(this.fetchImpl, `${API}/login`, {
        signal,
        method: 'POST',
        headers: this.headers(apiKey),
        body: { username, password },
        rateLimiter: this.limiter,
      });
      if (res.token) this.token = { value: res.token, expiresAt: Date.now() + 12 * 3_600_000 };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'OpenSubtitles login failed; continuing anonymously');
    }
  }
}
