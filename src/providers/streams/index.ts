import type { StreamProvider } from '../../core/interfaces/providers.js';
import type { ServerConfig } from '../../config/env.js';
import type { FetchLike } from '../../infrastructure/http/http-client.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { InternetArchiveProvider } from './internet-archive.js';
import { LocalLibraryProvider } from './local-library.js';
import { StremioAddonUpstreamProvider } from './stremio-addon-upstream.js';

/**
 * Provider registry. To add a provider: implement StreamProvider, then construct it here.
 * Ranking, caching, timeouts and de-duplication apply automatically.
 */
export function createStreamProviders(config: ServerConfig, logger: Logger, fetchImpl: FetchLike = fetch): StreamProvider[] {
  const enabled = new Set(config.enabledStreamProviders);
  const providers: StreamProvider[] = [];

  if (enabled.has('internet-archive')) providers.push(new InternetArchiveProvider(fetchImpl));

  if (enabled.has('local-library') && config.libraryFile) {
    providers.push(new LocalLibraryProvider(config.libraryFile, logger.child({ provider: 'local-library' })));
  }

  if (enabled.has('upstream')) {
    for (const addon of config.upstreamAddons) {
      providers.push(new StremioAddonUpstreamProvider(`upstream-${addon.id}`, addon.name, addon.url, fetchImpl));
    }
  }

  logger.info({ providers: providers.map((p) => p.id) }, 'Stream providers ready');
  return providers;
}
