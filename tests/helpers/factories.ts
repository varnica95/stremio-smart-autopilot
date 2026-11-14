import { loadServerConfig, type ServerConfig } from '../../src/config/env.js';
import { DEFAULT_PREFERENCES } from '../../src/config/preferences.js';
import { transportKey } from '../../src/core/dedupe.js';
import type { ProviderContext, StreamProvider, SubtitleProvider } from '../../src/core/interfaces/providers.js';
import type { MediaRequest } from '../../src/core/models/media.js';
import type { UserPreferences } from '../../src/core/models/preferences.js';
import type { StreamCandidate, StreamTransport } from '../../src/core/models/stream.js';
import type { SubtitleCandidate } from '../../src/core/models/subtitle.js';

let counter = 0;

export function httpTransport(url = `https://cdn.example.org/file-${++counter}.mp4`): StreamTransport {
  return { kind: 'http', url };
}

export function torrentTransport(hashSeed = ++counter): StreamTransport {
  return { kind: 'torrent', infoHash: hashSeed.toString(16).padStart(40, 'a'), fileIdx: 0 };
}

export function makeCandidate(overrides: Partial<StreamCandidate> = {}): StreamCandidate {
  const transport = overrides.transport ?? httpTransport();
  return {
    id: transportKey(transport),
    providerId: 'test',
    providerName: 'Test Provider',
    transport,
    title: 'Movie.2020.1080p.WEB-DL.x264-GRP',
    resolution: '1080p',
    videoCodec: 'h264',
    audioCodecs: ['aac'],
    hdr: [],
    source: 'web-dl',
    languages: [],
    sizeBytes: 4e9,
    ...overrides,
  };
}

export function prefs(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return { ...DEFAULT_PREFERENCES, ...overrides };
}

export function testConfig(env: Record<string, string> = {}): ServerConfig {
  return loadServerConfig({
    DATABASE_PATH: '',
    LOG_LEVEL: 'silent',
    PUBLIC_URL: 'http://127.0.0.1:7000',
    PROBE_ENABLED: 'false',
    STREAM_PROVIDERS: '',
    ...env,
  });
}

export const MOVIE: MediaRequest = { type: 'movie', imdbId: 'tt0032138' };
export const EPISODE: MediaRequest = { type: 'series', imdbId: 'tt0944947', season: 1, episode: 5 };

/** Stream provider whose behaviour is fully controlled by the test. */
export class FakeStreamProvider implements StreamProvider {
  calls = 0;
  readonly peerToPeer = false;

  constructor(
    readonly id: string,
    private readonly behaviour: (media: MediaRequest, ctx: ProviderContext) => Promise<StreamCandidate[]>,
    readonly name = id,
  ) {}

  supports(_media?: MediaRequest): boolean {
    return true;
  }

  async findStreams(media: MediaRequest, ctx: ProviderContext): Promise<StreamCandidate[]> {
    this.calls++;
    return this.behaviour(media, ctx);
  }
}

/** Resolves after `ms`, or rejects when the signal aborts (like a well-behaved provider). */
export function delay<T>(ms: number, value: T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

export function makeSubtitle(overrides: Partial<SubtitleCandidate> = {}): SubtitleCandidate {
  const id = overrides.id ?? String(++counter);
  return {
    id,
    providerId: 'fake-subs',
    language: 'en',
    release: 'Movie.2020.1080p.WEB-DL.x264-GRP',
    hashMatch: false,
    downloadCount: 100,
    hearingImpaired: false,
    machineTranslated: false,
    fromTrustedUploader: false,
    url: `https://subs.example.org/${id}.srt`,
    ...overrides,
  };
}

export class FakeSubtitleProvider implements SubtitleProvider {
  readonly name = 'Fake subtitles';
  calls = 0;
  constructor(
    readonly id: string,
    private readonly subtitles: SubtitleCandidate[],
  ) {}
  async findSubtitles(): Promise<SubtitleCandidate[]> {
    this.calls++;
    return this.subtitles;
  }
}

/** Builds a fetch stand-in that answers from a URL → handler map. */
export function fakeFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response('not found', { status: 404 });
    return (routes[key] as (init?: RequestInit) => Response | Promise<Response>)(init);
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
