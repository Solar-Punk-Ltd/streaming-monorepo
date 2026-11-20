/**
 * The funding API's batch purchase journal, `funding_stamp_purchases` of migrations 055 and 056 and the stages of
 * `funding_purchase_stages`, against a real PostgreSQL, with the read of the stamp operations a purchase waits for.
 *
 * `pnpm test:database` in manager/, or on its own with CHEQUEBOOK_TEST_PG_PORT set.
 *
 * What only the database can show: that a row comes back as it was written, amounts of 78 digits included; that a
 * request id is journalled once and a second insert under it writes nothing; that a node label belongs to one
 * purchase; that a node holds one purchase under way at a time, being bought or waiting for its batch to become
 * usable, two inserts racing for it included, and is free again once it is past waiting; that an update lands only on a
 * row still in the state, or at the step, it names; that an archive stamp's row is marked recorded once, and no other
 * row ever; that a purchase's stages are written once each and come back in their order; and that the rules the
 * columns carry refuse a row the service would never write, even from a write that skipped it.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { purchaseNodeLabel } from '@streaming-infra-manager/common';
import type { FundingBatchPurchasePurpose } from '@streaming-monorepo/contracts';

import { PostgresFundingStampOperationJournal } from '../../src/domain/funding/FundingStampOperationJournal.js';
import {
  type FundingPurchaseStageRow,
  type FundingStampPurchasePatch,
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
const STAGE_ONE = '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c';
const STAGE_TWO = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d';
const RECORDED_AT = new Date('2026-11-13T10:03:00.000Z');
const NODE = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf:bee-uploader';
const OTHER_NODE = '5adebf83-7192-43a4-bf40-6b7c8d9eafb0:bee-uploader';
const BATCH = `0x${'c5'.repeat(32)}`;
const REPLACED = `0x${'d6'.repeat(32)}`;
const TX = `0x${'9a'.repeat(32)}`;
const JOURNALLED_AT = new Date('2026-11-13T10:00:00.000Z');
const ANSWERED_AT = new Date('2026-11-13T10:02:30.000Z');
const SET_AT = new Date('2026-11-13T10:05:00.000Z');
/** 2^256 - 1, the most an amount in the contract can be, 78 digits. */
const MAX_UINT256 = (2n ** 256n - 1n).toString();

function purchase(over: Partial<FundingStampPurchaseRow> = {}): FundingStampPurchaseRow {
  const requestId = over.requestId ?? REQUEST;
  const purpose: FundingBatchPurchasePurpose = over.purpose ?? 'archive';
  return {
    requestId,
    purpose,
    nodeId: NODE,
    depth: 20,
    amountPerChunkPlur: '12441600000',
    costPlur: '13045963161600000',
    immutable: true,
    label: 'Autumn event',
    nodeLabel: purchaseNodeLabel(purpose, requestId),
    replacesBatchId: null,
    batchId: null,
    txHash: null,
    state: 'unknown',
    step: 'buying',
    error: null,
    createdAt: JOURNALLED_AT,
    updatedAt: JOURNALLED_AT,
    boughtAt: null,
    setAt: null,
    previousBatchId: null,
    releasedAt: null,
    recordedAt: null,
    ...over,
  };
}

const settledAs = (state: 'confirmed' | 'failed'): FundingStampPurchasePatch => ({
  state,
  batchId: state === 'confirmed' ? BATCH : null,
  txHash: state === 'confirmed' ? TX : null,
  error: state === 'failed' ? 'The node refused it (402).' : null,
  updatedAt: ANSWERED_AT,
  step: state === 'confirmed' ? 'waiting_usable' : 'failed',
  boughtAt: state === 'confirmed' ? ANSWERED_AT : null,
});

const setOn = {
  step: 'set' as const,
  error: null,
  updatedAt: SET_AT,
  setAt: SET_AT,
  previousBatchId: null,
  releasedAt: null,
};

function stage(
  stageId: string,
  name: string,
  position: number,
  over: Partial<FundingPurchaseStageRow> = {},
): FundingPurchaseStageRow {
  return {
    stageId,
    name,
    position,
    apply: 'pending',
    message: null,
    forcedAt: null,
    updatedAt: SET_AT,
    ...over,
  };
}

describe(
  'the funding batch purchase journal, in isolated PostgreSQL',
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
        node_label: purchaseNodeLabel('archive', OTHER_REQUEST),
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
      const rung = purchase({
        requestId: THIRD_REQUEST,
        purpose: 'rung',
        nodeId: OTHER_NODE,
        immutable: false,
        replacesBatchId: REPLACED,
      });
      assert.equal(await journal.insert(rung), 'inserted');
      assert.deepEqual(await journal.find(THIRD_REQUEST), rung);
      assert.equal(await journal.find(OTHER_REQUEST), null);
    });

    it('journals a request id once: a second insert under it writes nothing and answers request_taken', async () => {
      assert.equal(await journal.insert(purchase()), 'inserted');
      assert.equal(await journal.insert(purchase({ depth: 30, label: 'Another' })), 'request_taken');
      assert.equal((await journal.find(REQUEST))?.depth, 20);
    });

    it('holds one purchase under way per node, while it is bought and while its batch is not usable yet', async () => {
      assert.equal(await journal.insert(purchase()), 'inserted');
      assert.equal(await journal.insert(purchase({ requestId: OTHER_REQUEST })), 'node_busy');
      assert.equal(await journal.insert(purchase({ requestId: THIRD_REQUEST, nodeId: OTHER_NODE })), 'inserted');
      assert.equal((await journal.openOn(NODE))?.requestId, REQUEST);

      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('confirmed')), true);
      assert.equal((await journal.openOn(NODE))?.step, 'waiting_usable', 'still under way while it waits');
      assert.equal(await journal.insert(purchase({ requestId: OTHER_REQUEST })), 'node_busy');

      assert.equal(await journal.advance(REQUEST, 'waiting_usable', setOn), true);
      assert.equal(await journal.openOn(NODE), null);
      assert.equal(await journal.insert(purchase({ requestId: OTHER_REQUEST })), 'inserted');
    });

    it('frees the node once a purchase failed', async () => {
      assert.equal(await journal.insert(purchase()), 'inserted');
      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('failed')), true);
      assert.equal(await journal.openOn(NODE), null);
      assert.equal(await journal.insert(purchase({ requestId: OTHER_REQUEST })), 'inserted');
    });

    it('reads the purchase for a purpose journalled last on a node, whatever it came to, and none for another', async () => {
      const rung = { purpose: 'rung' as const, immutable: false, label: null, replacesBatchId: REPLACED };
      const before = new Date(JOURNALLED_AT.getTime() - 60_000);
      assert.equal(await journal.insert(purchase({ ...rung, createdAt: before, updatedAt: before })), 'inserted');
      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('failed')), true);
      assert.equal(await journal.insert(purchase({ ...rung, requestId: OTHER_REQUEST })), 'inserted');
      assert.equal(await journal.update(OTHER_REQUEST, 'unknown', settledAs('confirmed')), true);
      const unused = { ...setOn, step: 'failed' as const, error: 'Not usable within the hour.', setAt: null };
      assert.equal(await journal.advance(OTHER_REQUEST, 'waiting_usable', unused), true);
      const after = new Date(SET_AT.getTime() + 60_000);
      assert.equal(
        await journal.insert(purchase({ requestId: THIRD_REQUEST, createdAt: after, updatedAt: after })),
        'inserted',
      );

      const last = await journal.latestOn(NODE, 'rung');
      assert.deepEqual(
        [last?.requestId, last?.state, last?.step, last?.batchId, last?.setAt],
        [OTHER_REQUEST, 'confirmed', 'failed', BATCH, null],
      );
      assert.equal((await journal.latestOn(NODE, 'archive'))?.requestId, THIRD_REQUEST);
      assert.equal(await journal.latestOn(NODE, 'catalogue'), null);
      assert.equal(await journal.latestOn(OTHER_NODE, 'rung'), null);
    });

    it('keeps a node label to one purchase: another whose request id begins alike is label_taken', async () => {
      assert.equal(await journal.insert(purchase()), 'inserted');
      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('failed')), true);
      const lookalike = purchase({ requestId: LOOKALIKE_REQUEST, nodeId: OTHER_NODE });
      assert.equal(lookalike.nodeLabel, purchase().nodeLabel);
      assert.equal(await journal.insert(lookalike), 'label_taken');
      assert.equal(await journal.find(LOOKALIKE_REQUEST), null);
    });

    it('marks a confirmed archive stamp recorded once, and no other purchase', async () => {
      await journal.insert(purchase());
      assert.equal(await journal.markRecorded(REQUEST, RECORDED_AT), false, 'an unknown purchase');
      await journal.update(REQUEST, 'unknown', settledAs('confirmed'));
      assert.equal(await journal.markRecorded(REQUEST, RECORDED_AT), true);
      assert.equal(await journal.markRecorded(REQUEST, ANSWERED_AT), false, 'a second time');
      assert.deepEqual((await journal.find(REQUEST))?.recordedAt, RECORDED_AT);

      await journal.insert(purchase({ requestId: OTHER_REQUEST, nodeId: OTHER_NODE, purpose: 'catalogue' }));
      await journal.update(OTHER_REQUEST, 'unknown', settledAs('confirmed'));
      assert.equal(await journal.markRecorded(OTHER_REQUEST, RECORDED_AT), false, 'a catalogue purchase');
    });

    it('lists the archive stamp purchases neither recorded nor failed, oldest first, and no other purchase', async () => {
      await journal.insert(purchase({ requestId: THIRD_REQUEST, nodeId: OTHER_NODE }));
      await journal.update(THIRD_REQUEST, 'unknown', settledAs('failed'));
      await journal.insert(purchase({ createdAt: ANSWERED_AT }));
      await journal.update(REQUEST, 'unknown', settledAs('confirmed'));
      assert.deepEqual(
        (await journal.unrecorded()).map((row) => [row.requestId, row.state]),
        [[REQUEST, 'confirmed']],
      );
      await journal.insert(
        purchase({ requestId: LOOKALIKE_REQUEST, nodeId: 'rung:bee-uploader', purpose: 'rung', immutable: false }),
      );
      await journal.insert(purchase({ requestId: OTHER_REQUEST, nodeId: OTHER_NODE, createdAt: JOURNALLED_AT }));
      assert.deepEqual(
        (await journal.unrecorded()).map((row) => [row.requestId, row.state]),
        [
          [OTHER_REQUEST, 'unknown'],
          [REQUEST, 'confirmed'],
        ],
        'a rung’s purchase holds no place on the archive batches’ list',
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

    it('updates a row only while it is in the state named, with the batch, the hash, the step and when it was bought', async () => {
      await journal.insert(purchase());
      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('confirmed')), true);
      assert.equal(await journal.update(REQUEST, 'unknown', settledAs('failed')), false);
      const row = await journal.find(REQUEST);
      assert.deepEqual(
        [row?.state, row?.batchId, row?.txHash, row?.error, row?.updatedAt, row?.step, row?.boughtAt],
        ['confirmed', BATCH, TX, null, ANSWERED_AT, 'waiting_usable', ANSWERED_AT],
      );
      assert.equal(await journal.update(OTHER_REQUEST, 'unknown', settledAs('failed')), false);
    });

    it('advances a row only from the step named, with what came with the step', async () => {
      await journal.insert(purchase({ purpose: 'catalogue' }));
      await journal.update(REQUEST, 'unknown', settledAs('confirmed'));
      assert.equal(await journal.advance(REQUEST, 'buying', setOn), false, 'from a step it is not at');
      assert.equal(await journal.advance(REQUEST, 'waiting_usable', { ...setOn, previousBatchId: REPLACED }), true);
      const released = new Date('2026-11-13T11:00:00.000Z');
      assert.equal(
        await journal.advance(REQUEST, 'set', {
          ...setOn,
          step: 'done',
          updatedAt: released,
          previousBatchId: REPLACED,
          releasedAt: released,
        }),
        true,
      );
      const row = await journal.find(REQUEST);
      assert.deepEqual(
        [row?.step, row?.setAt, row?.previousBatchId, row?.releasedAt, row?.updatedAt],
        ['done', SET_AT, REPLACED, released, released],
      );
    });

    it('lists the purchases being bought, waiting or set, oldest first, for the follow-up', async () => {
      await journal.insert(purchase({ createdAt: ANSWERED_AT }));
      await journal.insert(purchase({ requestId: OTHER_REQUEST, nodeId: OTHER_NODE }));
      await journal.update(OTHER_REQUEST, 'unknown', settledAs('confirmed'));
      await journal.insert(purchase({ requestId: THIRD_REQUEST, nodeId: 'third:bee-uploader' }));
      await journal.update(THIRD_REQUEST, 'unknown', settledAs('failed'));
      assert.deepEqual(
        (await journal.following()).map((row) => [row.requestId, row.step]),
        [
          [OTHER_REQUEST, 'waiting_usable'],
          [REQUEST, 'buying'],
        ],
      );
      await journal.advance(OTHER_REQUEST, 'waiting_usable', { ...setOn, step: 'done' });
      assert.deepEqual(
        (await journal.following()).map((row) => row.requestId),
        [REQUEST],
      );
    });

    it('writes a rung purchase’s stages once each, and gives them back in their order', async () => {
      await journal.insert(purchase({ purpose: 'rung', immutable: false }));
      await journal.addStages(REQUEST, [stage(STAGE_TWO, 'stage-two', 1), stage(STAGE_ONE, 'stage-one', 0)]);
      await journal.addStages(REQUEST, [stage(STAGE_ONE, 'stage-one', 0, { apply: 'applied' })]);
      assert.deepEqual(
        (await journal.stagesOf(REQUEST)).map((each) => [each.name, each.position, each.apply]),
        [
          ['stage-one', 0, 'pending'],
          ['stage-two', 1, 'pending'],
        ],
        'a stage written already is left as it is',
      );
      assert.deepEqual(await journal.stagesOf(OTHER_REQUEST), []);
    });

    it('writes what a look at a stage came to, keeping when its restart was asked unless a new time is given', async () => {
      await journal.insert(purchase({ purpose: 'rung', immutable: false }));
      await journal.addStages(REQUEST, [stage(STAGE_ONE, 'stage-one', 0)]);
      const forced = new Date('2026-11-13T10:06:00.000Z');
      await journal.updateStage(REQUEST, STAGE_ONE, {
        apply: 'applying',
        message: null,
        updatedAt: forced,
        forcedAt: forced,
      });
      const later = new Date('2026-11-13T10:07:00.000Z');
      await journal.updateStage(REQUEST, STAGE_ONE, {
        apply: 'failed',
        message: 'The Apply failed.',
        updatedAt: later,
      });
      assert.deepEqual(await journal.stagesOf(REQUEST), [
        {
          stageId: STAGE_ONE,
          name: 'stage-one',
          position: 0,
          apply: 'failed',
          message: 'The Apply failed.',
          forcedAt: forced,
          updatedAt: later,
        },
      ]);
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
        ['a purpose there is none of', { purpose: 'gateway' }],
        ['a step there is none of', { step: 'applied' }],
        ['a mutable catalogue batch', { purpose: 'catalogue', immutable: false }],
        ['an archive stamp that replaces a batch', { replaces_batch_id: REPLACED }],
        ['a rung’s purchase with a previous catalogue batch', { purpose: 'rung', previous_batch_id: REPLACED }],
        [
          'a catalogue purchase marked recorded',
          { purpose: 'catalogue', state: 'confirmed', batch_id: BATCH, recorded_at: RECORDED_AT },
        ],
        ['a purchase waiting for a batch it has none of', { step: 'waiting_usable' }],
        ['a replaced batch without 0x', { purpose: 'rung', replaces_batch_id: 'd6'.repeat(32) }],
      ];
      for (const [what, columns] of refused) {
        await assert.rejects(rawInsert(columns), (err: unknown) => {
          assert.equal((err as { code?: unknown }).code, '23514', what);
          return true;
        });
      }
    });

    it('refuses a stage in a state there is none of', async () => {
      await journal.insert(purchase({ purpose: 'rung', immutable: false }));
      await assert.rejects(
        journal.addStages(REQUEST, [stage(STAGE_ONE, 'stage-one', 0, { apply: 'restarted' as 'pending' })]),
        (err: unknown) => {
          assert.equal((err as { code?: unknown }).code, '23514');
          return true;
        },
      );
    });

    it('reads the stamp operation still under way on a node, and none once it settled', async () => {
      const operations = new PostgresFundingStampOperationJournal(pool);
      assert.equal(
        await operations.insert({
          requestId: REQUEST,
          kind: 'topup',
          nodeId: NODE,
          batchId: BATCH,
          expectedDepth: 20,
          newDepth: null,
          amountPerChunkPlur: '12441600000',
          costPlur: '13045963161600000',
          normalisedBalanceBefore: '1000',
          txHash: null,
          state: 'unknown',
          error: null,
          createdAt: JOURNALLED_AT,
          updatedAt: JOURNALLED_AT,
        }),
        true,
      );
      assert.equal((await operations.openOn(NODE))?.requestId, REQUEST);
      assert.equal(await operations.openOn(OTHER_NODE), null);
      await operations.update(REQUEST, 'unknown', {
        state: 'confirmed',
        txHash: TX,
        error: null,
        updatedAt: ANSWERED_AT,
      });
      assert.equal(await operations.openOn(NODE), null);
    });
  },
);
