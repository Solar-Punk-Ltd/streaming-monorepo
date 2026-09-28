import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type pg from 'pg';

import { boundedCleanup } from './boundedCleanup.js';

/** The advisory lock every runner of these migrations takes, and any reader that must not see them half applied. */
export const MIGRATION_LOCK_KEY = 0x6d696772;

/** Where the runner's lines go. Each app hands in its own logger, so the lines keep that app's format. */
export interface MigrationLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface RunMigrationsOptions {
  pool: pg.Pool;
  /** A folder of `*.sql` files, applied in name order, each once. */
  migrationsDir: string;
  lockKey?: number;
  logger: MigrationLogger;
}

/**
 * Applies every migration in the folder the `_migrations` ledger does not name yet, each in a transaction of its
 * own, under one session advisory lock held on one connection for the whole run.
 */
export async function runMigrations({
  pool,
  migrationsDir,
  lockKey = MIGRATION_LOCK_KEY,
  logger,
}: RunMigrationsOptions): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  let discardClient = true;
  let primaryFailed = false;
  let connectionFailure: Error | null = null;
  const onConnectionError = (error: Error) => {
    connectionFailure = error;
    discardClient = true;
    logger.error('[Database] Migration connection failed. Discarding the connection.');
  };
  client.on('error', onConnectionError);
  try {
    // A session lock spans ledger creation and all per-file transactions, including fresh concurrent startup.
    await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
    locked = true;
    discardClient = false;
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const seen = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (seen.rowCount && seen.rowCount > 0) continue;

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`[Database] Applied migration: ${file}`);
      } catch (err) {
        try {
          await boundedCleanup(client.query('ROLLBACK'));
        } catch {
          discardClient = true;
          logger.error('[Database] Migration rollback could not be confirmed. Discarding the connection.');
        }
        throw err;
      }
    }
  } catch (err) {
    primaryFailed = true;
    throw err;
  } finally {
    let unlockFailed = false;
    if (locked && !discardClient) {
      try {
        const result = await boundedCleanup(
          client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1) AS unlocked', [lockKey]),
        );
        // oxlint-disable-next-line eslint/no-unsafe-finally -- the catch just below takes it, it never leaves the finally
        if (result.rows[0]?.unlocked !== true) throw new Error('Migration lock ownership was lost.');
      } catch {
        discardClient = true;
        unlockFailed = true;
        logger.error('[Database] Migration lock release could not be confirmed. Discarding the connection.');
      }
    }
    client.release(discardClient);
    client.removeListener('error', onConnectionError);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- only when the migration itself succeeded, so it hides no error
    if (connectionFailure && !primaryFailed) throw connectionFailure;
    if (unlockFailed && !primaryFailed) {
      // oxlint-disable-next-line eslint/no-unsafe-finally -- only when the migration itself succeeded, so it hides no error
      throw new Error('Migration lock release could not be confirmed. Connection discarded.');
    }
  }
}
