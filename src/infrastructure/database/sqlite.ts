import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../logging/logger.js';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS cache (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at)`,
  `CREATE TABLE IF NOT EXISTS reliability (
     key TEXT PRIMARY KEY,
     ok_ewma REAL NOT NULL,
     observations INTEGER NOT NULL,
     throughput_ewma REAL,
     updated_at INTEGER NOT NULL
   )`,
];

/**
 * Opens (or creates) the SQLite database using Node's built-in driver, so no native addon is needed.
 * Returns undefined when persistence is disabled or unavailable; callers fall back to memory.
 */
export async function openDatabase(path: string, logger: Logger): Promise<DatabaseSync | undefined> {
  if (!path) return undefined;
  try {
    // getBuiltinModule avoids bundler/test-runner resolution issues with the `node:`-only module.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    for (const sql of MIGRATIONS) db.exec(sql);
    db.prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now());
    logger.info({ path }, 'SQLite persistence enabled');
    return db;
  } catch (err) {
    logger.warn({ err, path }, 'SQLite unavailable; using in-memory storage only');
    return undefined;
  }
}
