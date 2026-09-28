/**
 * The brand's catalogue node, migration 047's single-row table, against a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with DEPLOYMENT_SETTINGS_TEST_PG_PORT set.
 *
 * What only the database can show: that the table holds one row and never a second, that a designation and a clear
 * land only at the revision they read, that a clear keeps the manager's moment it names and the node and batch it
 * cleared, and that the rules the
 * columns carry refuse a half designation, a batch id in another spelling and a depth no batch has, even from a write
 * that skipped the service.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { CatalogueDesignationRepository } from '../../src/domain/stages/CatalogueDesignationRepository.js';

const port = Number(process.env.DEPLOYMENT_SETTINGS_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'deployment_settings_test',
  connectionTimeoutMillis: 10000,
};

const BATCH = 'ab'.repeat(32);
const DESIGNATED_AT = new Date('2026-09-28T09:00:00.000Z');
const CLEARED_AT = new Date('2026-09-28T09:30:00.000Z');

describe(
  'the catalogue designation table, in isolated PostgreSQL',
  {
    skip: !Number.isInteger(port) || port < 1 || port > 65535,
  },
  () => {
    let admin: Pool;
    let pool: Pool;
    let schema: string;
    let store: CatalogueDesignationRepository;

    async function migrate(target: Pool): Promise<void> {
      const directory = new URL('../../src/migrations/', import.meta.url);
      const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of names) {
        await target.query(await readFile(new URL(name, directory), 'utf8'));
      }
    }

    beforeEach(async () => {
      schema = `catalogue_${randomBytes(8).toString('hex')}`;
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
      store = new CatalogueDesignationRepository(pool);
      await migrate(pool);
    });

    afterEach(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    it('starts with its one row and no designation, and takes no second row', async () => {
      assert.deepEqual(await store.read(), {
        profileName: null,
        batchId: null,
        batchDepth: null,
        designatedAt: null,
        designatedBy: null,
        clearedAt: null,
        revision: 0,
      });
      await assert.rejects(pool.query('INSERT INTO catalogue_designation DEFAULT VALUES'), /duplicate key/);
      await assert.rejects(pool.query('INSERT INTO catalogue_designation (singleton) VALUES (FALSE)'), /check/i);
    });

    it('designates at the revision it read, and not at one another write moved past', async () => {
      const saved = await store.designate(
        { profileName: 'catalogue', batchId: BATCH, batchDepth: 20, at: DESIGNATED_AT },
        0,
        'operator',
      );
      assert.deepEqual(saved, {
        profileName: 'catalogue',
        batchId: BATCH,
        batchDepth: 20,
        designatedAt: DESIGNATED_AT,
        designatedBy: 'operator',
        clearedAt: null,
        revision: 1,
      });
      const stale = await store.designate(
        { profileName: 'other', batchId: 'cd'.repeat(32), batchDepth: 22, at: DESIGNATED_AT },
        0,
        'operator',
      );
      assert.equal(stale, null);
      assert.equal((await store.read()).profileName, 'catalogue');
    });

    it('clears as of the moment it names, keeping the node and the batch, under the same revision rule', async () => {
      assert.equal(await store.clear(CLEARED_AT, 0, 'b'), null, 'nothing designated, nothing to clear');
      await store.designate({ profileName: 'catalogue', batchId: BATCH, batchDepth: 20, at: DESIGNATED_AT }, 0, 'a');
      assert.equal(await store.clear(CLEARED_AT, 0, 'b'), null);
      const cleared = await store.clear(CLEARED_AT, 1, 'b');
      assert.deepEqual(cleared, {
        profileName: 'catalogue',
        batchId: BATCH,
        batchDepth: 20,
        designatedAt: DESIGNATED_AT,
        designatedBy: 'b',
        clearedAt: CLEARED_AT,
        revision: 2,
      });
      const again = await store.designate(
        { profileName: 'catalogue', batchId: BATCH, batchDepth: 21, at: CLEARED_AT },
        2,
        'a',
      );
      assert.equal(again?.clearedAt, null, 'a designation is in force again');
      assert.deepEqual(again?.designatedAt, CLEARED_AT);
      assert.equal(again?.batchDepth, 21);
    });

    it('refuses a half designation, a batch id in another spelling and a depth no batch has', async () => {
      await assert.rejects(
        pool.query("UPDATE catalogue_designation SET profile_name = 'catalogue'"),
        /check/i,
        'a deployment with no batch',
      );
      await assert.rejects(
        pool.query('UPDATE catalogue_designation SET batch_id = $1', [BATCH]),
        /check/i,
        'a batch with no deployment',
      );
      for (const batchId of [`0x${BATCH}`, BATCH.toUpperCase(), 'ab']) {
        await assert.rejects(
          pool.query(
            "UPDATE catalogue_designation SET profile_name = 'catalogue', batch_id = $1, batch_depth = 20, designated_at = NOW()",
            [batchId],
          ),
          /check/i,
          batchId,
        );
      }
      await assert.rejects(
        pool.query(
          "UPDATE catalogue_designation SET profile_name = 'catalogue', batch_id = $1, batch_depth = 16, designated_at = NOW()",
          [BATCH],
        ),
        /check/i,
      );
      await assert.rejects(
        pool.query(
          "UPDATE catalogue_designation SET profile_name = 'catalogue', batch_id = $1, designated_at = NOW()",
          [BATCH],
        ),
        /check/i,
        'a designation with no depth',
      );
      await assert.rejects(
        pool.query('UPDATE catalogue_designation SET cleared_at = NOW()'),
        /check/i,
        'a clear of nothing designated',
      );
    });
  },
);
