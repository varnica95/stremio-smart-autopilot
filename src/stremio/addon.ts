import sdk, { type AddonInterface, type Manifest } from 'stremio-addon-sdk';
import { createStreamHandler, type StreamHandlerDeps } from './handlers/stream-handler.js';
import { createSubtitlesHandler, type SubtitlesHandlerDeps } from './handlers/subtitles-handler.js';

export function createAddonInterface(
  manifest: Manifest,
  streamDeps: StreamHandlerDeps,
  subtitleDeps: SubtitlesHandlerDeps | undefined,
): AddonInterface {
  const builder = new sdk.addonBuilder(manifest);
  builder.defineStreamHandler(createStreamHandler(streamDeps));
  if (subtitleDeps) builder.defineSubtitlesHandler(createSubtitlesHandler(subtitleDeps));
  return builder.getInterface();
}
