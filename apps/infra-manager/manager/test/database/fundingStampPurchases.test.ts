/**
 * The funding API's stamp purchase journal, migration 055's `funding_stamp_purchases`, against a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with CHEQUEBOOK_TEST_PG_PORT set.
 *
 * What only the database can show: that a row comes back as it was written, amounts of 78 digits included; that a
 * request id is journalled once and a second insert under it writes nothing; that a node label belongs to one
 * purchase; that a node holds one purchase still being settled at a time, two inserts racing for it included, and is
 * free again once it settled; that an update lands only on a row still in the state it names; that a confirmed row is
 * marked recorded once, and no other row ever; and that the rules the columns carry refuse a row the service would
 * never write, even from a write that skipped it.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { archivePurchaseNodeLabel } from '@streaming-infra-manager/common';

import {
  type FundingStampPurchaseRow,
  PostgresFundingStampPurchaseJournal,
} from '../../src/domain/funding/FundingStampPurchaseJournal.js';

const port = Number(process.env.CHEQUEBOOK_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'chequebook_test',
  connectionTimeoutMillis: 10000,
};

const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const OTHER_REQUEST = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const THIRD_REQUEST = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
/** Another request id that begins with the same twelve hex digits as REQUEST, so its node label is REQUEST's. */
const LOOKALIKE_REQUEST = '7d1e2f3a-4b5c-4fff-8aaa-bbbbbbbbbbbb';
const RECORDED_AT = new Date('2026-11-13T10:03:00.000Z');
const NODE = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf:bee-uploader';
const OTHER_NODE = '5adebf83-7192-43a4-bf40-6b7c8d9eafb0:bee-uploader';
const BATCH = `0x${'c5'.repeat(32)}`;
const TX = `0x${'9a'.repeat(32)}`;
const JOURNALLED_AT = new Date('2026-11-13T10:00:00.000Z');
const ANSWERED_AT = new Date('2026-11-13T10:02:30.000Z');
/** 2^256 - 1, the most an amount in the contract can be, 78 digits. */
const MAX_UINT256 = (2n ** 256n - 1n).toString();

function purchase(over: Partial<FundingStampPurchaseRow> = {}): FundingStampPurchaseRow {
  const requestId = over.requestId ?? REQUEST;
  return {
    requestId,
    nodeId: NODE,
    depth: 20,
    amountPerChunkPlur: '12441600000',
    costPlur: '13045963161600000',
    label: 'Autumn event',
    nodeLabel: archivePurchaseNodeLabel(requestId),
    batchId: null,
    txHash: null,
    state: 'unknown',
    error: null,
    createdAt: JOURNALLED_AT,
    updatedAt: JOURNALLED_AT,
    recordedAt: null,
    ...over,
  };
}

const settledAs = (state: 'confirmed' | 'failed') => ({
  state,
  batchId: state === 'confirmed' ? BATCH : null,
  txHash: state === 'confirmed' ? TX : null,
  error: state === 'failed' ? 'The node refused it (402).' : null,
  updatedAt: ANSWERED_AT,
});

describe(
  'the funding stamp purchase journal, in isolated PostgreSQL',
  {
    skip: !Number.isInteger(port) || port < 1 || port > 65535,
  },
  () => {
    let admin: Pool;
    let pool: Pool;
    let schema: string;
    let journal: PostgresFundingStampPurchaseJournal;

    async function migrate(target: Pool): Promise<void> {
      const directory = new URL('../../src/migrations/', import.meta.url);
      const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of names) {
        await target.query(await readFile(new URL(name, directory), 'utf8'));
      }
    }

    /** A row written straight into the table, past the journal, for the column rules to judge. */
    async function rawInsert(columns: Record<string, unknown>): Promise<void> {
      const row: Record<string, unknown> = {
        request_id: OTHER_REQUEST,
        node_id: OTHER_NODE,
        depth: 20,
        amount_per_chunk: '12441600000',
        cost: '13045963161600000',
        label: null,
        node_label: archivePurchaseNodeLabel(OTHER_REQUEST),
        batch_id: null,
        tx_hash: null,
        state: 'unknown',
        error: null,
        created_at: JOURNALLED_AT,
        updated_at: JOURNALLED_AT,
        ...columns,
      };
      const names = Object.keys(row);
      await pool.query(
        `INSERT INTO funding_stamp_purchases (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    }

    beforeEach(async () => {
      schema = `funding_purchases_${randomBytes(8).toString('hex')}`;
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
      journal = new PostgresFundingStampPurchaseJournal(pool);
      await migrate(pool);
    });

    afterEach(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    it('gives a purchase back as it was written, and nothing for an id never written', async () => {
      const written = purchase({ amountPerChunkPlur: MAX_UINT256, costPlur: MAX_UINT256, label: null });
      assert.equal(await journal.insert(written), 'inserted');
      assert.deepEqual(await journal.find(REQUEST), written);
      assert.equal(await journal.find(OTHER_REQUEST), null);
    });

    it('journals a request id once: a second insert under it writes nothing and answers request_taken', async () => {
      assert.equal(await journal.insert(purchase()), 'inserted');
      assert.equal(await journal.insert(purchase({ depth: 30, label: 'Another' })), 'request_taken');
      assert.equal((await journal.find(REQUEST))?.depth, 20);
    });

    it('holds one purchase being settled per node, another node free, and frees the node once it settled', async () => {
      assert.equal(await journal.insert(purchase()), 'inserted');
      assert.equal(await journal.insert(purchase({ requestId: OTHER_REQUEST })), 'node_busy');
      assert.equal(await journal.insert(purchase({ requestId: THIRD_REQUEST, nodeId: OTHER_NODE })), 'inserted');
      assert.equal((await journal.openOn(NODE))?.requestId, REQUEST);

      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('failed')), true);
      assert.equal(await journal.openOn(NODE), null);
      assert.equal(await journal.insert(purchase({ requestId: OTHER_REQUEST })), 'inserted');
    });

    it('keeps a node label to one purchase: another whose request id begins alike is label_taken', async () => {
      assert.equal(await journal.insert(purchase()), 'inserted');
      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('failed')), true);
      const lookalike = purchase({ requestId: LOOKALIKE_REQUEST, nodeId: OTHER_NODE });
      assert.equal(lookalike.nodeLabel, purchase().nodeLabel);
      assert.equal(await journal.insert(lookalike), 'label_taken');
      assert.equal(await journal.find(LOOKALIKE_REQUEST), null);
    });

    it('marks a confirmed purchase recorded once, and no purchase that is not confirmed', async () => {
      await journal.insert(purchase());
      assert.equal(await journal.markRecorded(REQUEST, RECORDED_AT), false, 'an unknown purchase');
      await journal.update(REQUEST, 'unknown', settledAs('confirmed'));
      assert.equal(await journal.markRecorded(REQUEST, RECORDED_AT), true);
      assert.equal(await journal.markRecorded(REQUEST, ANSWERED_AT), false, 'a second time');
      assert.deepEqual((await journal.find(REQUEST))?.recordedAt, RECORDED_AT);
    });

    it('lists the purchases neither recorded nor failed, oldest first', async () => {
      await journal.insert(purchase({ requestId: THIRD_REQUEST, nodeId: OTHER_NODE }));
      await journal.update(THIRD_REQUEST, 'unknown', settledAs('failed'));
      await journal.insert(purchase({ createdAt: ANSWERED_AT }));
      await journal.update(REQUEST, 'unknown', settledAs('confirmed'));
      assert.deepEqual(
        (await journal.unrecorded()).map((row) => [row.requestId, row.state]),
        [[REQUEST, 'confirmed']],
      );
      await journal.insert(purchase({ requestId: OTHER_REQUEST, createdAt: JOURNALLED_AT }));
      assert.deepEqual(
        (await journal.unrecorded()).map((row) => [row.requestId, row.state]),
        [
          [OTHER_REQUEST, 'unknown'],
          [REQUEST, 'confirmed'],
        ],
      );
      await journal.markRecorded(REQUEST, RECORDED_AT);
      assert.deepEqual(
        (await journal.unrecorded()).map((row) => row.requestId),
        [OTHER_REQUEST],
      );
    });

    it('lets exactly one of two purchases racing for one node in', async () => {
      const outcomes = await Promise.all([
        journal.insert(purchase()),
        journal.insert(purchase({ requestId: OTHER_REQUEST })),
      ]);
      assert.deepEqual([...outcomes].sort(), ['inserted', 'node_busy']);
    });

    it('updates a row only while it is in the state named, with the batch and the hash', async () => {
      await journal.insert(purchase());
      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('confirmed')), true);
      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('failed')), false);
      const row = await journal.find(REQUEST);
      assert.deepEqual(
        [row?.state, row?.batchId, row?.txHash, row?.error, row?.updatedAt],
        ['confirmed', BATCH, TX, null, ANSWERED_AT],
      );
      assert.equal(await journal.update(OTHER_REQUEST, 'unknown', settledAs('failed')), false);
    });

    it('refuses rows the service would never write, even past the journal', async () => {
      const refused: Array<[string, Record<string, unknown>]> = [
        ['a confirmed row with no batch', { state: 'confirmed' }],
        ['a depth under the capacity table', { depth: 16 }],
        ['a depth over it', { depth: 42 }],
        ['a node label not of the purchase’s form', { node_label: 'recordings' }],
        ['a node label with the whole request id', { node_label: `archive-${OTHER_REQUEST}` }],
        ['a purchase marked recorded before it was confirmed', { recorded_at: RECORDED_AT }],
        ['a batch id without 0x', { batch_id: 'c5'.repeat(32) }],
        ['an amount of nothing', { amount_per_chunk: '0' }],
        ['an empty label', { label: '' }],
        ['a state there is none of', { state: 'bought' }],
      ];
      for (const [what, columns] of refused) {
        await assert.rejects(rawInsert(columns), (err: unknown) => {
          assert.equal((err as { code?: unknown }).code, '23514', what);
          return true;
        });
      }
    });
  },
);
