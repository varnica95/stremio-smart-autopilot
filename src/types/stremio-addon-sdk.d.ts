/**
 * Minimal typings for the parts of the official `stremio-addon-sdk` (v1.6.x) this project uses.
 * Kept local so the build does not depend on third-party type packages drifting from the SDK.
 */
declare module 'stremio-addon-sdk' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export type ContentType = 'movie' | 'series' | 'channel' | 'tv';

  export interface ManifestConfigField {
    key: string;
    type: 'text' | 'number' | 'password' | 'checkbox' | 'select';
    title?: string;
    options?: string[];
    default?: string;
    required?: boolean;
  }

  export interface Manifest {
    id: string;
    version: string;
    name: string;
    description: string;
    resources: Array<string | { name: string; types: ContentType[]; idPrefixes?: string[] }>;
    types: ContentType[];
    catalogs: unknown[];
    idPrefixes?: string[];
    logo?: string;
    background?: string;
    contactEmail?: string;
    behaviorHints?: {
      adult?: boolean;
      p2p?: boolean;
      configurable?: boolean;
      configurationRequired?: boolean;
    };
    config?: ManifestConfigField[];
  }

  export interface Stream {
    url?: string;
    ytId?: string;
    infoHash?: string;
    fileIdx?: number;
    externalUrl?: string;
    name?: string;
    title?: string;
    description?: string;
    subtitles?: Subtitle[];
    sources?: string[];
    behaviorHints?: {
      countryWhitelist?: string[];
      notWebReady?: boolean;
      bingeGroup?: string;
      proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
      videoHash?: string;
      videoSize?: number;
      filename?: string;
    };
  }

  export interface Subtitle {
    id: string;
    url: string;
    lang: string;
  }

  export interface CacheHints {
    cacheMaxAge?: number;
    staleRevalidate?: number;
    staleError?: number;
  }

  export interface HandlerArgs {
    type: ContentType;
    id: string;
    extra: Record<string, string | undefined>;
    /** User configuration from the addon URL, already JSON-parsed by the SDK (false when unparsable). */
    config?: unknown;
  }

  export interface AddonInterface {
    manifest: Manifest;
    /** Positional arguments, as in the SDK: get(resource, type, id, extra, config). */
    get(resource: string, type: string, id: string, extra?: Record<string, string>, config?: unknown): Promise<unknown>;
  }

  export class addonBuilder {
    constructor(manifest: Manifest);
    defineStreamHandler(handler: (args: HandlerArgs) => Promise<{ streams: Stream[] } & CacheHints>): void;
    defineSubtitlesHandler(handler: (args: HandlerArgs) => Promise<{ subtitles: Subtitle[] } & CacheHints>): void;
    getInterface(): AddonInterface;
  }

  export type RouterHandler = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

  export function getRouter(addonInterface: AddonInterface): RouterHandler;

  const sdk: {
    addonBuilder: typeof addonBuilder;
    getRouter: typeof getRouter;
  };
  export default sdk;
}
