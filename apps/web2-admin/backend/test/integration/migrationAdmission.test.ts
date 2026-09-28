/**
 * Two backends starting at once against one empty database, which is what a
 * rollout that runs a new container beside the old one does.
 *
 * Each runs the migrations on its way up. Nothing in a migration file guards
 * against a second run of itself, and nothing has to, as long as only one
 * runner applies files at a time: the second must wait, then find every file
 * already in the ledger. The first migration here sleeps before it creates a
 * table, so both runners are inside it together unless something makes the
 * second one wait.
 *
 * It uses a throwaway database beside the one in DATABASE_URL (see
 * instance.ts), and a folder of its own migrations, so the schema the
 * backend ships plays no part.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';

import { Database } from '../../src/domain/Database.js';

import { ADMIN_DATABASE_URL, databaseNameFor } from './instance.js';

const SLOW_CREATE = 'SELECT pg_sleep(0.5); CREATE TABLE only_once (id int);';
const HARMLESS = 'SELECT 1;';
const FILES = ['001_slow_create.sql', '002_harmless.sql'];

describe('two backends migrating one empty database at once', () => {
  const { admin, name, target } = databaseNameFor(ADMIN_DATABASE_URL);
  let adminPool: pg.Pool;
  let directory: string;

  before(async () => {
    adminPool = new pg.Pool({ connectionString: admin, max: 1 });
    await adminPool.query(`CREATE DATABASE "${name}"`);
    directory = await mkdtemp(join(tmpdir(), 'web2-admin-migrations-'));
    await writeFile(join(directory, FILES[0]), SLOW_CREATE);
    await writeFile(join(directory, FILES[1]), HARMLESS);
  });

  after(async () => {
    try {
      await adminPool?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await adminPool?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets both come up and applies each migration once', async () => {
    const first = new Database(target, directory);
    const second = new Database(target, directory);
    try {
      const outcomes = await Promise.allSettled([first.migrate(), second.migrate()]);
      assert.deepEqual(
        outcomes.map((outcome) => (outcome.status === 'rejected' ? String(outcome.reason) : outcome.status)),
        ['fulfilled', 'fulfilled'],
      );

      const table = await first.pool.query<{ found: string | null }>("SELECT to_regclass('only_once') AS found");
      assert.equal(table.rows[0].found, 'only_once');

      const ledger = await first.pool.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
      assert.deepEqual(
        ledger.rows.map((row) => row.name),
        FILES,
      );
    } finally {
      await first.close();
      await second.close();
    }
  });
});
