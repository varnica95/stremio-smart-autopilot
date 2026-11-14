import type { HandlerArgs, Subtitle } from 'stremio-addon-sdk';
import { parsePreferences } from '../../config/preferences.js';
import type { UserPreferences } from '../../core/models/preferences.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { toIso6392 } from '../../services/subtitle-matching/languages.js';
import type { SubtitleService } from '../../services/subtitle-matching/subtitle-service.js';
import { errorMessage } from '../../utils/async.js';
import { parseStremioId } from '../../utils/stremio-id.js';

export interface SubtitlesHandlerDeps {
  subtitleService: SubtitleService;
  defaults: UserPreferences;
  logger: Logger;
}

/**
 * Stremio calls this with the video id plus, when it knows them, the OpenSubtitles hash, size and
 * file name of the file being played. Results are returned in priority order; which one is
 * switched on automatically is decided by the player's "default subtitle language" setting.
 */
export function createSubtitlesHandler(deps: SubtitlesHandlerDeps) {
  return async (args: HandlerArgs): Promise<{ subtitles: Subtitle[]; cacheMaxAge?: number }> => {
    const media = parseStremioId(args.type, args.id);
    if (!media) return { subtitles: [] };
    const { prefs } = parsePreferences(args.config ?? {}, deps.defaults);

    const videoSize = Number(args.extra.videoSize);
    const file = {
      videoHash: args.extra.videoHash || undefined,
      videoSize: Number.isFinite(videoSize) && videoSize > 0 ? videoSize : undefined,
      filename: args.extra.filename || undefined,
    };

    try {
      const ranked = await deps.subtitleService.find(media, file, prefs);
      return {
        subtitles: ranked.map(({ subtitle }) => ({
          id: `autopilot-${subtitle.providerId}-${subtitle.id}`,
          url: subtitle.url,
          lang: toIso6392(subtitle.language),
        })),
        cacheMaxAge: 3600,
      };
    } catch (err) {
      deps.logger.error({ err: errorMessage(err), id: args.id }, 'Subtitle request failed');
      return { subtitles: [] };
    }
  };
}
