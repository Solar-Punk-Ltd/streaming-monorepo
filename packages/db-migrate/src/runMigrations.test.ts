/**
 * The runner's order of work and its lines, against a connection that answers from a script. The same rules
 * against a real PostgreSQL are in database/runMigrations.test.ts.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type pg from 'pg';

import { MIGRATION_LOCK_KEY, runMigrations } from './runMigrations.js';

type Answer = (sql: string, values?: unknown[]) => Promise<unknown>;

/** One connection whose every query is written down and answered by `answer`. */
function scriptedPool(answer: Answer) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const released: Array<boolean | undefined> = [];
  const client = Object.assign(new EventEmitter(), {
    query: (sql: string, values?: unknown[]) => {
      queries.push({ sql: sql.trim(), values });
      return answer(sql.trim(), values);
    },
    release: (discard?: boolean) => {
      released.push(discard);
    },
  });
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, client, queries, released };
}

/** Answers as an empty database does: nothing seen, every unlock confirmed. */
const empty: Answer = async (sql) => {
  if (sql.startsWith('SELECT 1 FROM _migrations')) return { rowCount: 0, rows: [] };
  if (sql.startsWith('SELECT pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
  return { rowCount: 0, rows: [] };
};

function recordingLogger() {
  const lines: Array<[string, string]> = [];
  return {
    lines,
    logger: {
      info: (message: string) => lines.push(['info', message]),
      error: (message: string) => lines.push(['error', message]),
    },
  };
}

describe('runMigrations against a scripted connection', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'db-migrate-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('takes the lock first, applies each unseen file in name order in its own transaction, and unlocks', async () => {
    await writeFile(join(directory, '002_second.sql'), 'SELECT 2;');
    await writeFile(join(directory, '001_first.sql'), 'SELECT 1;');
    await writeFile(join(directory, 'notes.txt'), 'not a migration');
    const { pool, queries, released } = scriptedPool(empty);
    const { lines, logger } = recordingLogger();

    await runMigrations({ pool, migrationsDir: directory, logger });

    assert.deepEqual(queries[0], { sql: 'SELECT pg_advisory_lock($1)', values: [MIGRATION_LOCK_KEY] });
    assert.match(queries[1].sql, /^CREATE TABLE IF NOT EXISTS _migrations/);
    assert.deepEqual(
      queries.slice(2).map(({ sql }) => sql),
      [
        'SELECT 1 FROM _migrations WHERE name = $1',
        'BEGIN',
        'SELECT 1;',
        'INSERT INTO _migrations (name) VALUES ($1)',
        'COMMIT',
        'SELECT 1 FROM _migrations WHERE name = $1',
        'BEGIN',
        'SELECT 2;',
        'INSERT INTO _migrations (name) VALUES ($1)',
        'COMMIT',
        'SELECT pg_advisory_unlock($1) AS unlocked',
      ],
    );
    assert.deepEqual(lines, [
      ['info', '[Database] Applied migration: 001_first.sql'],
      ['info', '[Database] Applied migration: 002_second.sql'],
    ]);
    assert.deepEqual(released, [false]);
  });

  it('locks and unlocks with the key it is given', async () => {
    const { pool, queries } = scriptedPool(empty);
    await runMigrations({ pool, migrationsDir: directory, lockKey: 7, logger: recordingLogger().logger });
    assert.deepEqual(queries[0].values, [7]);
    assert.deepEqual(queries.at(-1)?.values, [7]);
  });

  it('skips a file the ledger already names', async () => {
    await writeFile(join(directory, '001_first.sql'), 'SELECT 1;');
    const { pool, queries } = scriptedPool(async (sql, values) =>
      sql.startsWith('SELECT 1 FROM _migrations') ? { rowCount: 1, rows: [{}] } : empty(sql, values),
    );
    await runMigrations({ pool, migrationsDir: directory, logger: recordingLogger().logger });
    assert.equal(
      queries.some(({ sql }) => sql === 'BEGIN'),
      false,
    );
  });

  it('refuses a folder that is not there, and still unlocks and keeps the connection', async () => {
    const { pool, queries, released } = scriptedPool(empty);
    await assert.rejects(
      runMigrations({ pool, migrationsDir: join(directory, 'missing'), logger: recordingLogger().logger }),
      { code: 'ENOENT' },
    );
    assert.equal(queries.at(-1)?.sql, 'SELECT pg_advisory_unlock($1) AS unlocked');
    assert.deepEqual(released, [false]);
  });

  it("keeps the migration's own error when the rollback fails too, and discards the connection", async () => {
    await writeFile(join(directory, '001_first.sql'), 'SELECT broken;');
    const { pool, queries, released } = scriptedPool(async (sql, values) => {
      if (sql === 'SELECT broken;') throw new Error('the migration failed');
      if (sql === 'ROLLBACK') throw new Error('the rollback failed');
      return empty(sql, values);
    });
    const { lines, logger } = recordingLogger();

    await assert.rejects(runMigrations({ pool, migrationsDir: directory, logger }), /the migration failed/);

    assert.deepEqual(lines, [
      ['error', '[Database] Migration rollback could not be confirmed. Discarding the connection.'],
    ]);
    assert.equal(
      queries.some(({ sql }) => sql.startsWith('SELECT pg_advisory_unlock')),
      false,
    );
    assert.deepEqual(released, [true]);
  });

  it('refuses a run whose unlock is not confirmed, and discards the connection', async () => {
    const { pool, released } = scriptedPool(async (sql, values) =>
      sql.startsWith('SELECT pg_advisory_unlock') ? { rows: [{ unlocked: false }] } : empty(sql, values),
    );
    const { lines, logger } = recordingLogger();

    await assert.rejects(
      runMigrations({ pool, migrationsDir: directory, logger }),
      /^Error: Migration lock release could not be confirmed\. Connection discarded\.$/,
    );

    assert.deepEqual(lines, [
      ['error', '[Database] Migration lock release could not be confirmed. Discarding the connection.'],
    ]);
    assert.deepEqual(released, [true]);
  });

  it('refuses a run whose connection failed, and says so through the logger', async () => {
    const { pool, client, released } = scriptedPool(async (sql, values) => {
      if (sql.startsWith('CREATE TABLE')) client.emit('error', new Error('Connection terminated unexpectedly'));
      return empty(sql, values);
    });
    const { lines, logger } = recordingLogger();

    await assert.rejects(runMigrations({ pool, migrationsDir: directory, logger }), /Connection terminated/);

    assert.deepEqual(lines, [['error', '[Database] Migration connection failed. Discarding the connection.']]);
    assert.deepEqual(released, [true]);
  });
});
