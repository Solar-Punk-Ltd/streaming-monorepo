/**
 * The manager's own migrations through its Database with no folder named. How the runner admits, applies, rolls
 * back and unlocks is pinned where the runner lives, in packages/db-migrate.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { Database } from '../../src/domain/Database.js';

const port = Number(process.env.STACK_VERSIONS_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'stack_versions_test',
  connectionTimeoutMillis: 10000,
};
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('migration admission did not finish')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

describe(
  'migration admission in isolated PostgreSQL',
  { skip: !Number.isInteger(port) || port < 1 || port > 65535 },
  () => {
    let admin: Pool;
    let schema: string;
    let instances: { database: Database; name: string }[];
    beforeEach(async () => {
      schema = `migrate_${randomBytes(8).toString('hex')}`;
      instances = [];
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
    });
    afterEach(async () => {
      for (const { database } of instances) await database.close();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });
    function database() {
      const name = `${schema}_${instances.length}`;
      const url = new URL(`postgresql://postgres@127.0.0.1:${port}/stack_versions_test`);
      url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`);
      url.searchParams.set('application_name', name);
      const database = new Database(url.toString());
      instances.push({ database, name });
      return { database, name };
    }
    async function ledger() {
      return (await admin.query<{ name: string }>(`SELECT name FROM ${schema}._migrations ORDER BY name`)).rows.map(
        (row) => row.name,
      );
    }
    async function assertReleased() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const checkedOut = instances.some(
          ({ database }) => database.pool.totalCount !== database.pool.idleCount || database.pool.waitingCount !== 0,
        );
        const names = instances.map((instance) => instance.name);
        const locks = await admin.query(
          "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = ANY($1::text[]) AND l.locktype = 'advisory'",
          [names],
        );
        if (!checkedOut && locks.rowCount === 0) return;
        await delay(10);
      }
      throw new Error('a checked-out client or migration advisory lock remained after completion');
    }

    it('migrates the repository schema through the unchanged default directory', async () => {
      const first = database();
      await first.database.migrate();
      assert.ok((await ledger()).includes('024_bundled_shipments.sql'));
      assert.equal(
        (await admin.query(`SELECT publication_revision FROM ${schema}.stack_versions WHERE name = 'bundled'`)).rows[0]
          .publication_revision,
        '0',
      );
      await bounded(database().database.migrate());
      await assertReleased();
    });
  },
);
