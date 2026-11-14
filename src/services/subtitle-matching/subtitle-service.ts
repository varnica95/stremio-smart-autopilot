import type { SubtitleProvider } from '../../core/interfaces/providers.js';
import { mediaKey, type MediaRequest } from '../../core/models/media.js';
import type { UserPreferences } from '../../core/models/preferences.js';
import type { RankedSubtitle, SubtitleCandidate, VideoFileHints } from '../../core/models/subtitle.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { errorMessage, withTimeout } from '../../utils/async.js';
import type { CacheService } from '../caching/cache-service.js';
import type { MetadataService } from '../stream-discovery/metadata-service.js';
import { resolveLanguagePriority } from './languages.js';
import { rankSubtitles } from './subtitle-matcher.js';

export class SubtitleService {
  constructor(
    private readonly providers: SubtitleProvider[],
    private readonly metadata: MetadataService,
    private readonly cache: CacheService,
    private readonly logger: Logger,
    private readonly options: { timeoutMs: number; ttlMs: number },
  ) {}

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  async find(
    media: MediaRequest,
    file: VideoFileHints,
    prefs: UserPreferences,
    signal?: AbortSignal,
  ): Promise<RankedSubtitle[]> {
    if (!this.enabled) return [];
    const needsOriginal = prefs.subtitleLanguages.includes('original');
    const metadata = needsOriginal ? await this.metadata.get(media, signal) : {};
    const languages = resolveLanguagePriority(prefs.subtitleLanguages, metadata.originalLanguage);
    if (languages.length === 0) return [];

    const results = await Promise.all(
      this.providers.map((provider) => this.fromProvider(provider, media, languages, file, signal)),
    );
    return rankSubtitles(results.flat(), languages, file, prefs.maxSubtitlesPerLanguage);
  }

  private async fromProvider(
    provider: SubtitleProvider,
    media: MediaRequest,
    languages: string[],
    file: VideoFileHints,
    signal?: AbortSignal,
  ): Promise<SubtitleCandidate[]> {
    const key = `subs:${provider.id}:${mediaKey(media)}:${[...languages].sort().join(',')}:${file.videoHash ?? '-'}`;
    try {
      return await this.cache.getOrLoad<SubtitleCandidate[]>(
        key,
        (value) => (value.length ? this.options.ttlMs : 10 * 60_000),
        () =>
          withTimeout(
            `subtitles:${provider.id}`,
            this.options.timeoutMs,
            (s) => provider.findSubtitles({ media, languages, file }, s),
            signal,
          ),
      );
    } catch (err) {
      this.logger.warn({ provider: provider.id, err: errorMessage(err) }, 'Subtitle provider failed');
      return [];
    }
  }
}
