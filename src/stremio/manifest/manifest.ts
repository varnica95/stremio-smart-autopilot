import type { Manifest } from 'stremio-addon-sdk';
import { RANKING_PROFILES, SELECTABLE_RESOLUTIONS, type UserPreferences } from '../../core/models/preferences.js';

export const ADDON_ID = 'community.smart-autopilot';
export const ADDON_VERSION = '1.0.0';

export interface ManifestOptions {
  /** True when any enabled provider can return BitTorrent streams. */
  peerToPeer: boolean;
  subtitlesEnabled: boolean;
  defaults: UserPreferences;
}

export function buildManifest(options: ManifestOptions): Manifest {
  const d = options.defaults;
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: 'Smart AutoPilot',
    description:
      'Ranks streams from your authorized sources by tested availability, speed and quality, puts the best one first, and picks subtitles in your languages (Croatian, English, original by default).',
    resources: options.subtitlesEnabled ? ['stream', 'subtitles'] : ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      p2p: options.peerToPeer,
    },
    // Declaring config enables the SDK's "/{config}/..." routes. The addon serves its own
    // /configure page, which writes the same keys.
    config: [
      { key: 'rankingProfile', type: 'select', title: 'Ranking profile', options: [...RANKING_PROFILES], default: d.rankingProfile },
      { key: 'preferredResolution', type: 'select', title: 'Preferred resolution', options: [...SELECTABLE_RESOLUTIONS], default: d.preferredResolution },
      { key: 'minResolution', type: 'select', title: 'Minimum resolution', options: [...SELECTABLE_RESOLUTIONS], default: d.minResolution },
      { key: 'maxResolution', type: 'select', title: 'Maximum resolution', options: [...SELECTABLE_RESOLUTIONS], default: d.maxResolution },
      { key: 'subtitleLanguages', type: 'text', title: 'Subtitle languages (ISO 639-1, comma separated; "original" allowed)', default: d.subtitleLanguages.join(',') },
      { key: 'openSubtitlesApiKey', type: 'password', title: 'Your OpenSubtitles API key (optional if the server has one)' },
      { key: 'maxResults', type: 'number', title: 'Maximum results', default: String(d.maxResults) },
      { key: 'preferSmallerFiles', type: 'checkbox', title: 'Prefer smaller files when quality is comparable', default: d.preferSmallerFiles ? 'checked' : undefined },
      { key: 'preferCompatibleAudio', type: 'checkbox', title: 'Prefer widely compatible audio', default: d.preferCompatibleAudio ? 'checked' : undefined },
      { key: 'excludeLowQuality', type: 'checkbox', title: 'Hide CAM/TS/screener releases', default: d.excludeLowQuality ? 'checked' : undefined },
    ],
  };
}
