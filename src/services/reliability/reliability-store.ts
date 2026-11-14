import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ReliabilityStats, ReliabilityStore } from '../../core/interfaces/stores.js';

const ALPHA = 0.3;

interface Row {
  okEwma: number;
  observations: number;
  throughputEwma: number | null;
  updatedAt: number;
}

function applyOutcome(row: Row | undefined, ok: boolean, throughputBps: number | undefined, now: number): Row {
  const prev = row ?? { okEwma: 0.5, observations: 0, throughputEwma: null, updatedAt: now };
  const okEwma = prev.okEwma * (1 - ALPHA) + ALPHA * (ok ? 1 : 0);
  let throughputEwma = prev.throughputEwma;
  if (throughputBps !== undefined && throughputBps > 0) {
    throughputEwma = throughputEwma === null ? throughputBps : throughputEwma * (1 - ALPHA) + ALPHA * throughputBps;
  }
  return { okEwma, observations: prev.observations + 1, throughputEwma, updatedAt: now };
}

/** Old observations fade toward neutral (0.5) so a temporary outage does not punish a source for long. */
function toStats(row: Row, now: number, halfLifeMs: number): ReliabilityStats {
  const age = Math.max(0, now - row.updatedAt);
  const decay = Math.pow(0.5, age / halfLifeMs);
  return {
    reliability: 0.5 + (row.okEwma - 0.5) * decay,
    observations: row.observations,
    // Speed measurements go stale faster than success/failure history.
    throughputBps: row.throughputEwma !== null && decay > 0.25 ? row.throughputEwma : undefined,
    updatedAt: row.updatedAt,
  };
}

export class MemoryReliabilityStore implements ReliabilityStore {
  private readonly rows = new Map<string, Row>();

  constructor(
    private readonly halfLifeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  record(key: string, outcome: { ok: boolean; throughputBps?: number }): void {
    this.rows.set(key, applyOutcome(this.rows.get(key), outcome.ok, outcome.throughputBps, this.now()));
    if (this.rows.size > 20_000) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) this.rows.delete(oldest);
    }
  }

  get(key: string): ReliabilityStats | undefined {
    const row = this.rows.get(key);
    return row ? toStats(row, this.now(), this.halfLifeMs) : undefined;
  }

  list(prefix: string, limit: number): Array<{ key: string; stats: ReliabilityStats }> {
    const now = this.now();
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, limit)
      .map(([key, row]) => ({ key, stats: toStats(row, now, this.halfLifeMs) }));
  }
}

export class SqliteReliabilityStore implements ReliabilityStore {
  private readonly selectStmt: StatementSync;
  private readonly upsertStmt: StatementSync;
  private readonly listStmt: StatementSync;

  constructor(
    db: DatabaseSync,
    private readonly halfLifeMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.selectStmt = db.prepare(
      'SELECT ok_ewma AS okEwma, observations, throughput_ewma AS throughputEwma, updated_at AS updatedAt FROM reliability WHERE key = ?',
    );
    this.upsertStmt = db.prepare(
      `INSERT INTO reliability (key, ok_ewma, observations, throughput_ewma, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET ok_ewma = excluded.ok_ewma, observations = excluded.observations,
         throughput_ewma = excluded.throughput_ewma, updated_at = excluded.updated_at`,
    );
    this.listStmt = db.prepare(
      `SELECT key, ok_ewma AS okEwma, observations, throughput_ewma AS throughputEwma, updated_at AS updatedAt
       FROM reliability WHERE key LIKE ? ORDER BY updated_at DESC LIMIT ?`,
    );
  }

  private read(key: string): Row | undefined {
    return this.selectStmt.get(key) as unknown as Row | undefined;
  }

  record(key: string, outcome: { ok: boolean; throughputBps?: number }): void {
    const row = applyOutcome(this.read(key), outcome.ok, outcome.throughputBps, this.now());
    this.upsertStmt.run(key, row.okEwma, row.observations, row.throughputEwma, row.updatedAt);
  }

  get(key: string): ReliabilityStats | undefined {
    const row = this.read(key);
    return row ? toStats(row, this.now(), this.halfLifeMs) : undefined;
  }

  list(prefix: string, limit: number): Array<{ key: string; stats: ReliabilityStats }> {
    const escaped = prefix.replace(/[%_]/g, '');
    const rows = this.listStmt.all(`${escaped}%`, limit) as unknown as Array<Row & { key: string }>;
    const now = this.now();
    return rows.map((row) => ({ key: row.key, stats: toStats(row, now, this.halfLifeMs) }));
  }
}
