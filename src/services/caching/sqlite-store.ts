import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { KeyValueStore } from '../../core/interfaces/stores.js';

/** Persistent store backed by the `cache` table. Survives restarts; used under a memory layer. */
export class SqliteStore implements KeyValueStore {
  private readonly selectStmt: StatementSync;
  private readonly upsertStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private writes = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.selectStmt = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?');
    this.upsertStmt = db.prepare(
      'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
    );
    this.deleteStmt = db.prepare('DELETE FROM cache WHERE key = ?');
  }

  get<T>(key: string): T | undefined {
    const row = this.selectStmt.get(key) as { value: string; expires_at: number } | undefined;
    if (!row) return undefined;
    if (row.expires_at <= this.now()) {
      this.deleteStmt.run(key);
      return undefined;
    }
    try {
      return JSON.parse(row.value) as T;
    } catch {
      this.deleteStmt.run(key);
      return undefined;
    }
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.upsertStmt.run(key, JSON.stringify(value), this.now() + ttlMs);
    if (++this.writes % 500 === 0) this.db.prepare('DELETE FROM cache WHERE expires_at < ?').run(this.now());
  }

  delete(key: string): void {
    this.deleteStmt.run(key);
  }
}

/** Reads from memory first, then the persistent layer; writes go to both. */
export class TieredStore implements KeyValueStore {
  constructor(
    private readonly fast: KeyValueStore,
    private readonly slow: KeyValueStore,
    /** Entries promoted from the slow layer stay in memory at most this long. */
    private readonly promoteTtlMs = 5 * 60_000,
  ) {}

  get<T>(key: string): T | undefined {
    const hit = this.fast.get<T>(key);
    if (hit !== undefined) return hit;
    const slow = this.slow.get<T>(key);
    if (slow !== undefined) this.fast.set(key, slow, this.promoteTtlMs);
    return slow;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.fast.set(key, value, Math.min(ttlMs, this.promoteTtlMs));
    this.slow.set(key, value, ttlMs);
  }

  delete(key: string): void {
    this.fast.delete(key);
    this.slow.delete(key);
  }
}
