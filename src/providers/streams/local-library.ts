import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { StreamProvider } from '../../core/interfaces/providers.js';
import type { MediaRequest } from '../../core/models/media.js';
import type { StreamCandidate } from '../../core/models/stream.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { buildCandidate } from './normalize.js';

const LibraryItemSchema = z.object({
  imdbId: z.string().regex(/^tt\d+$/),
  season: z.number().int().min(0).optional(),
  episode: z.number().int().min(0).optional(),
  url: z.string().url(),
  title: z.string().optional(),
  sizeBytes: z.number().int().positive().optional(),
});
const LibrarySchema = z.object({ items: z.array(LibraryItemSchema) });
type LibraryItem = z.infer<typeof LibraryItemSchema>;

/**
 * Your own media: a JSON file mapping IMDb ids to URLs you host (NAS, Jellyfin direct links,
 * a local web server). The file is re-read automatically when it changes.
 */
export class LocalLibraryProvider implements StreamProvider {
  readonly id = 'local-library';
  readonly name = 'My Library';
  readonly peerToPeer = false;
  private items: LibraryItem[] = [];
  private loadedMtime = -1;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  supports(): boolean {
    return true;
  }

  async findStreams(media: MediaRequest): Promise<StreamCandidate[]> {
    await this.reloadIfChanged();
    return this.items
      .filter(
        (item) =>
          item.imdbId === media.imdbId &&
          (media.type === 'movie' || (item.season === media.season && item.episode === media.episode)),
      )
      .map((item) => {
        const filename = decodeURIComponent(new URL(item.url).pathname.split('/').pop() ?? '');
        return buildCandidate({
          providerId: this.id,
          providerName: this.name,
          transport: { kind: 'http', url: item.url },
          title: item.title ?? filename,
          filename: filename || undefined,
          sizeBytes: item.sizeBytes,
        });
      });
  }

  private async reloadIfChanged(): Promise<void> {
    const info = await stat(this.filePath);
    if (info.mtimeMs === this.loadedMtime) return;
    const parsed = LibrarySchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')));
    if (!parsed.success) {
      throw new Error(`Library file is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
    }
    this.items = parsed.data.items;
    this.loadedMtime = info.mtimeMs;
    this.logger.info({ count: this.items.length }, 'Loaded local library');
  }
}

