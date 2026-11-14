import { dedupeCandidates } from '../../core/dedupe.js';
import type { MediaMetadata, MediaRequest } from '../../core/models/media.js';
import type { UserPreferences } from '../../core/models/preferences.js';
import type { StreamHealth } from '../../core/models/stream.js';
import { NO_SIGNALS, rankStreams, type RankedStream, type RankingSignals } from '../../core/ranking/ranker.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { ProviderReport, StreamDiscoveryService } from '../stream-discovery/discovery-service.js';
import type { MetadataService } from '../stream-discovery/metadata-service.js';
import type { StreamProber } from '../stream-discovery/stream-prober.js';
import type { ReliabilityService } from '../reliability/reliability-service.js';

export interface StreamSelection {
  ranked: RankedStream[];
  reports: ProviderReport[];
  metadata: MediaMetadata;
  /** Number of distinct sources found before filtering and truncation. */
  totalFound: number;
}

/**
 * The application use case: discover → de-duplicate → pre-rank → test the most promising HTTP
 * links → final rank. Independent of Stremio; the Stremio handler only formats the result.
 */
export class StreamService {
  constructor(
    private readonly metadata: MetadataService,
    private readonly discovery: StreamDiscoveryService,
    private readonly prober: StreamProber | undefined,
    private readonly reliability: ReliabilityService,
    private readonly logger: Logger,
    private readonly options: { maxProbes: number },
  ) {}

  async select(media: MediaRequest, prefs: UserPreferences, signal?: AbortSignal): Promise<StreamSelection> {
    const metadata = await this.metadata.get(media, signal);
    const { candidates, reports } = await this.discovery.discover(media, metadata, signal);
    const unique = dedupeCandidates(candidates);

    const baseInput = {
      prefs,
      runtimeMinutes: metadata.runtimeMinutes,
      isEpisode: media.type === 'series',
    };
    const historySignals: RankingSignals = {
      ...NO_SIGNALS,
      health: (c) => this.prober?.cachedHealth(c),
      reliability: (c) => this.reliability.reliabilityFor(c),
      historicalThroughputBps: (c) => this.reliability.throughputFor(c),
    };

    let health = new Map<string, StreamHealth>();
    if (this.prober && this.options.maxProbes > 0) {
      // Test only the links that could plausibly end up near the top of the list.
      const preRanked = rankStreams(unique, { ...baseInput, signals: historySignals });
      const toProbe = preRanked
        .filter((r) => r.candidate.transport.kind === 'http')
        .slice(0, this.options.maxProbes)
        .map((r) => r.candidate);
      health = await this.prober.probeMany(toProbe, signal);
    }

    const ranked = rankStreams(unique, {
      ...baseInput,
      signals: { ...historySignals, health: (c) => health.get(c.id) ?? this.prober?.cachedHealth(c) },
    }).slice(0, prefs.maxResults);

    this.logger.debug(
      { media, found: unique.length, returned: ranked.length, top: ranked[0]?.candidate.id },
      'Streams ranked',
    );
    return { ranked, reports, metadata, totalFound: unique.length };
  }
}
