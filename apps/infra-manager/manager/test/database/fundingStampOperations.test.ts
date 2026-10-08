/**
 * The funding API's stamp operation journal, migration 052's `funding_stamp_operations`, against a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with CHEQUEBOOK_TEST_PG_PORT set.
 *
 * What only the database can show: that a row comes back as it was written, amounts of 78 digits included; that a
 * request id is journalled once and a second insert under it writes nothing; that an update lands only on a row still
 * in the state it names, which is how the node's answer and the status route's reading of the chain settle one row
 * without overwriting each other; and that the rules the columns carry refuse a row the service would never write,
 * even from a write that skipped it.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import {
  type FundingStampOperationRow,
  PostgresFundingStampOperationJournal,
} from '../../src/domain/funding/FundingStampOperationJournal.js';

const port = Number(process.env.CHEQUEBOOK_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'chequebook_test',
  connectionTimeoutMillis: 10000,
};

const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const OTHER_REQUEST = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const NODE = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b:bee-uploader';
const BATCH = `0x${'ab'.repeat(32)}`;
const TX = `0x${'9a'.repeat(32)}`;
const JOURNALLED_AT = new Date('2026-10-08T10:00:00.000Z');
const ANSWERED_AT = new Date('2026-10-08T10:01:30.000Z');
/** 2^256 - 1, the most a balance in the contract can be, 78 digits. */
const MAX_UINT256 = (2n ** 256n - 1n).toString();

function topUp(over: Partial<FundingStampOperationRow> = {}): FundingStampOperationRow {
  return {
    requestId: REQUEST,
    kind: 'topup',
    nodeId: NODE,
    batchId: BATCH,
    expectedDepth: 22,
    newDepth: null,
    amountPerChunkPlur: '414720000',
    costPlur: '1739461754880000',
    normalisedBalanceBefore: '9000000000000',
    txHash: null,
    state: 'unknown',
    error: null,
    createdAt: JOURNALLED_AT,
    updatedAt: JOURNALLED_AT,
    ...over,
  };
}

function dilution(over: Partial<FundingStampOperationRow> = {}): FundingStampOperationRow {
  return topUp({ kind: 'dilute', newDepth: 24, amountPerChunkPlur: null, costPlur: null, ...over });
}

describe(
  'the funding stamp operation journal, in isolated PostgreSQL',
  {
    skip: !Number.isInteger(port) || port < 1 || port > 65535,
  },
  () => {
    let admin: Pool;
    let pool: Pool;
    let schema: string;
    let journal: PostgresFundingStampOperationJournal;

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
        kind: 'topup',
        node_id: NODE,
        batch_id: BATCH,
        expected_depth: 22,
        new_depth: null,
        amount_per_chunk: '414720000',
        cost: '1739461754880000',
        normalised_balance_before: '9000000000000',
        tx_hash: null,
        state: 'unknown',
        error: null,
        created_at: JOURNALLED_AT,
        updated_at: JOURNALLED_AT,
        ...columns,
      };
      const names = Object.keys(row);
      await pool.query(
        `INSERT INTO funding_stamp_operations (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    }

    beforeEach(async () => {
      schema = `funding_stamps_${randomBytes(8).toString('hex')}`;
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
      journal = new PostgresFundingStampOperationJournal(pool);
      await migrate(pool);
    });

    afterEach(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    it('gives a top-up and a dilution back as they were written, and nothing for an id never written', async () => {
      const written = topUp({ normalisedBalanceBefore: MAX_UINT256 });
      assert.equal(await journal.insert(written), true);
      assert.deepEqual(await journal.find(REQUEST), written);
      const diluted = dilution({ requestId: OTHER_REQUEST });
      assert.equal(await journal.insert(diluted), true);
      assert.deepEqual(await journal.find(OTHER_REQUEST), diluted);
      assert.equal(await journal.find('4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf'), null);
    });

    it('journals a request id once: a second insert under it writes nothing and answers false', async () => {
      await journal.insert(topUp());
      assert.equal(await journal.insert(dilution()), false);
      assert.equal((await journal.find(REQUEST))?.kind, 'topup');
    });

    it('updates a row only from the state it names, and leaves it as it is otherwise', async () => {
      await journal.insert(topUp());
      const answered = { state: 'confirmed' as const, txHash: TX, error: null, updatedAt: ANSWERED_AT };
      assert.equal(await journal.update(REQUEST, 'unknown', answered), true);
      assert.equal(
        await journal.update(REQUEST, 'unknown', {
          state: 'failed',
          txHash: null,
          error: 'The postage contract shows no top-up of the batch thirty minutes after the node was asked.',
          updatedAt: ANSWERED_AT,
        }),
        false,
      );
      assert.deepEqual(await journal.find(REQUEST), topUp(answered));
      assert.equal(await journal.update(OTHER_REQUEST, 'unknown', answered), false, 'no such row');
    });

    it('refuses rows the service never writes, even from a write that skipped it', async () => {
      const refused: Array<[string, Record<string, unknown>]> = [
        ['a top-up with a new depth', { new_depth: 23 }],
        ['a top-up with no amount', { amount_per_chunk: null }],
        ['a top-up with no cost', { cost: null }],
        ['a dilution with an amount', { kind: 'dilute', new_depth: 23, cost: null }],
        ['a dilution of three steps', { kind: 'dilute', new_depth: 25, amount_per_chunk: null, cost: null }],
        ['a dilution to the same depth', { kind: 'dilute', new_depth: 22, amount_per_chunk: null, cost: null }],
        ['a kind there is none of', { kind: 'buy' }],
        ['a batch id in upper case', { batch_id: BATCH.toUpperCase().replace('0X', '0x') }],
        ['a batch id without 0x', { batch_id: 'ab'.repeat(32) }],
        ['a transaction hash that is not one', { tx_hash: '0x1234' }],
        ['a state there is none of', { state: 'queued' }],
        ['an amount of nothing', { amount_per_chunk: '0' }],
        ['a negative balance', { normalised_balance_before: '-1' }],
        ['no balance', { normalised_balance_before: null }],
        ['a node id with a space in it', { node_id: 'stage one:bee-uploader' }],
        ['a depth past a byte', { expected_depth: 256 }],
      ];
      for (const [what, columns] of refused) {
        await assert.rejects(rawInsert(columns), /violates|invalid input/, what);
      }
      await rawInsert({});
      assert.equal((await journal.find(OTHER_REQUEST))?.state, 'unknown', 'the row the rules take');
    });
  },
);
