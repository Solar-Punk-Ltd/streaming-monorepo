/**
 * The brand's archive batches, migration 054's table and its revision row, against a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with DEPLOYMENT_SETTINGS_TEST_PG_PORT set.
 *
 * What only the database can show: that an adopt and a removal land only at the revision they read and raise it,
 * that a refused write leaves the revision where it was, that a purchase, designated at whatever revision, recorded
 * twice, or a batch recorded under a second purchase, makes one row and raises the revision once, that the list comes
 * in the order the batches were designated, that a reading's depth is kept without raising the revision, and that
 * the columns refuse a batch id in another spelling, a depth no batch has, an empty or long label, a purchase without
 * its request and an adopted batch with one, even from a write that skipped the service.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ArchiveBatchDesignation } from '@streaming-infra-manager/common';
import pg, { type Pool } from 'pg';

import { ArchiveBatchRepository } from '../../src/domain/stages/ArchiveBatchRepository.js';

const port = Number(process.env.DEPLOYMENT_SETTINGS_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'deployment_settings_test',
  connectionTimeoutMillis: 10000,
};

const BATCH = 'ab'.repeat(32);
const OTHER_BATCH = 'cd'.repeat(32);
const REQUEST_ID = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const OTHER_REQUEST_ID = '8e2f3a4b-5c6d-4e7f-8a0b-c1d2e3f4a5b6';

function adopted(batchId: string, designatedAt: string): ArchiveBatchDesignation {
  return {
    batchId,
    profileName: 'catalogue',
    depth: 22,
    label: 'Spring archive',
    source: 'adopted',
    purchaseRequestId: null,
    designatedAt,
    designatedBy: 'operator',
  };
}

function bought(batchId: string, requestId: string): ArchiveBatchDesignation {
  return {
    batchId,
    profileName: 'catalogue',
    depth: 22,
    label: null,
    source: 'purchase',
    purchaseRequestId: requestId,
    designatedAt: '2026-11-13T10:00:00.000Z',
    designatedBy: null,
  };
}

describe(
  'the archive batches table, in isolated PostgreSQL',
  {
    skip: !Number.isInteger(port) || port < 1 || port > 65535,
  },
  () => {
    let admin: Pool;
    let pool: Pool;
    let schema: string;
    let store: ArchiveBatchRepository;

    async function migrate(target: Pool): Promise<void> {
      const directory = new URL('../../src/migrations/', import.meta.url);
      const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of names) {
        await target.query(await readFile(new URL(name, directory), 'utf8'));
      }
    }

    beforeEach(async () => {
      schema = `archive_${randomBytes(8).toString('hex')}`;
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
      store = new ArchiveBatchRepository(pool);
      await migrate(pool);
    });

    afterEach(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    it('starts empty at revision 0, and its revision row takes no second row', async () => {
      assert.deepEqual(await store.list(), []);
      assert.equal(await store.revision(), 0);
      await assert.rejects(pool.query('INSERT INTO archive_batches_revision DEFAULT VALUES'), /duplicate key/);
    });

    it('designates at the revision it read and raises it, and not at one another write moved past', async () => {
      assert.deepEqual(await store.designate(adopted(BATCH, '2026-11-13T09:00:00.000Z'), 0), {
        outcome: 'saved',
        revision: 1,
      });
      assert.deepEqual(await store.list(), [adopted(BATCH, '2026-11-13T09:00:00.000Z')]);
      assert.deepEqual(await store.designate(adopted(OTHER_BATCH, '2026-11-13T09:05:00.000Z'), 0), {
        outcome: 'changed',
      });
      assert.equal((await store.list()).length, 1);
      assert.equal(await store.revision(), 1);
    });

    it('refuses a batch that is an archive batch already, leaving the revision where it was', async () => {
      await store.designate(adopted(BATCH, '2026-11-13T09:00:00.000Z'), 0);
      assert.deepEqual(await store.designate(adopted(BATCH, '2026-11-13T09:05:00.000Z'), 1), { outcome: 'conflict' });
      assert.equal(await store.revision(), 1);
    });

    it('removes under the same rule, and a removal of no archive batch changes nothing', async () => {
      await store.designate(adopted(BATCH, '2026-11-13T09:00:00.000Z'), 0);
      assert.deepEqual(await store.remove(BATCH, 0), { outcome: 'changed' });
      assert.deepEqual(await store.remove(OTHER_BATCH, 1), { outcome: 'conflict' });
      assert.equal(await store.revision(), 1);
      assert.deepEqual(await store.remove(BATCH, 1), { outcome: 'saved', revision: 2 });
      assert.deepEqual(await store.list(), []);
    });

    it('designates a purchase once, at whatever revision, however often it is settled', async () => {
      await store.designate(adopted(OTHER_BATCH, '2026-11-13T09:00:00.000Z'), 0);
      assert.deepEqual(await store.designate(bought(BATCH, REQUEST_ID), null), { outcome: 'saved', revision: 2 });
      assert.deepEqual(await store.designate(bought(BATCH, REQUEST_ID), null), { outcome: 'conflict' });
      // The same request naming another batch, and the same batch under another request, are the same purchase.
      assert.deepEqual(await store.designate(bought('ef'.repeat(32), REQUEST_ID), null), { outcome: 'conflict' });
      assert.deepEqual(await store.designate(bought(BATCH, OTHER_REQUEST_ID), null), { outcome: 'conflict' });
      assert.deepEqual(
        await store.designate(bought(OTHER_BATCH, OTHER_REQUEST_ID), null),
        { outcome: 'conflict' },
        'adopted already',
      );
      assert.equal(await store.revision(), 2);
      assert.deepEqual(await store.list(), [
        adopted(OTHER_BATCH, '2026-11-13T09:00:00.000Z'),
        bought(BATCH, REQUEST_ID),
      ]);
    });

    it('lists in the order the batches were designated', async () => {
      await store.designate(adopted(OTHER_BATCH, '2026-11-13T11:00:00.000Z'), 0);
      await store.designate(adopted(BATCH, '2026-11-13T09:00:00.000Z'), 1);
      assert.deepEqual(
        (await store.list()).map((row) => row.batchId),
        [BATCH, OTHER_BATCH],
      );
    });

    it('keeps the depth a reading reports, without raising the revision', async () => {
      await store.designate(adopted(BATCH, '2026-11-13T09:00:00.000Z'), 0);
      await store.recordDepth(BATCH, 24);
      await store.recordDepth(OTHER_BATCH, 25);
      assert.deepEqual(
        (await store.list()).map((row) => [row.batchId, row.depth]),
        [[BATCH, 24]],
      );
      assert.equal(await store.revision(), 1);
      await assert.rejects(store.recordDepth(BATCH, 16), /check/i);
    });

    it('refuses rows the service would never write', async () => {
      const insert = (values: unknown[]) =>
        pool.query(
          `INSERT INTO archive_batches (batch_id, profile_name, label, source, purchase_request_id, batch_depth, designated_at, designated_by)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL)`,
          values.length === 5 ? [...values, 22] : values,
        );
      await assert.rejects(insert([`0x${BATCH.slice(2)}`, 'catalogue', null, 'adopted', null]), /check/i);
      await assert.rejects(insert([BATCH.toUpperCase(), 'catalogue', null, 'adopted', null]), /check/i);
      await assert.rejects(insert([BATCH, 'catalogue', '', 'adopted', null]), /check/i);
      await assert.rejects(insert([BATCH, 'catalogue', 'x'.repeat(65), 'adopted', null]), /check/i);
      await assert.rejects(insert([BATCH, 'catalogue', null, 'purchase', null]), /check/i);
      await assert.rejects(insert([BATCH, 'catalogue', null, 'adopted', REQUEST_ID]), /check/i);
      await assert.rejects(insert([BATCH, '', null, 'adopted', null]), /check/i);
      await assert.rejects(insert([BATCH, 'catalogue', null, 'bought', null]), /check/i);
      await assert.rejects(insert([BATCH, 'catalogue', null, 'adopted', null, 16]), /check/i);
      await assert.rejects(insert([BATCH, 'catalogue', null, 'adopted', null, 65]), /check/i);
      await assert.rejects(insert([BATCH, 'catalogue', null, 'adopted', null, null]), /null value/i);
      assert.deepEqual(await store.list(), []);
    });
  },
);
