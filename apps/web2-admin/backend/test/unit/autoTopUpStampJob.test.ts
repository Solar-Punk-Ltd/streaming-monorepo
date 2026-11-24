/**
 * The stamp job of stamp auto top-up, through the real stamp operation of the Stamps tab against a manager and a
 * journal in memory: the due stamps whose node covers them topped up in one operation as the system, the whole days to
 * the level at the tick's price; a short node's stamps left for the wallet job's send; once a day per stamp; a current
 * view of the chain only, with since when a stamp was unread; a lost stamp left; an operation already open, and a
 * price that rose, leaving the run to the next. Unit test, `pnpm test`.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { FundingInventory, FundingNode } from '@streaming-monorepo/contracts';
import { AUTO_TOPUP_DEFAULTS, autoTopUpStampPlan } from '@streaming-monorepo/web2-admin-common';

import { STAMP_AUTO_TOPUP } from '../../src/domain/actor.js';
import { markedStampsOf, type AutoTopUpTickContext } from '../../src/domain/funding/autoTopUpJobs.js';
import { AutoTopUpStampJob, type AutoTopUpStampJobStore } from '../../src/domain/funding/AutoTopUpStampJob.js';
import { FundingStampService } from '../../src/domain/funding/FundingStampService.js';
import type { AutoTopUpJournalledTopUp, AutoTopUpMarkRow } from '../../src/domain/funding/StampAutoTopUpStore.js';

import { InMemoryAuditLog } from './support/fakes.js';
import {
  BATCH_CATALOGUE,
  BATCH_RUNG,
  BATCH_STAGE,
  BZZ_TOKEN,
  DAY,
  FakeFundingManager,
  fundingBatch,
  fundingInventory,
  fundingNode,
  InMemoryFundingStampStore,
  NODE_A,
  NODE_CATALOGUE,
  NODE_RUNG,
  ONE_XBZZ,
  ONE_XDAI,
  POSTAGE,
  WALLET_C,
  WALLET_RUNG,
} from './support/fundingFakes.js';
import { STAGE_ID } from './support/stageFakes.js';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const FUNDED = { xdaiWei: (ONE_XDAI / 10n).toString(), xbzzPlur: (1000n * ONE_XBZZ).toString() };

/**
 * The stage's own node with its batch at 6 days, under the threshold; its 720p rung's node at 6.5 days; and the
 * catalogue node at 40 days. Every wallet holds 1000 xBZZ and 0.1 xDAI, and every node's view of the chain is current.
 */
function inventory(stage: Partial<FundingNode> = {}, rung: Partial<FundingNode> = {}): FundingInventory {
  return fundingInventory({
    chain: { chainId: 100, bzzToken: BZZ_TOKEN, postage: POSTAGE },
    stages: [
      {
        stageId: STAGE_ID,
        name: 'Main stage',
        nodes: [
          fundingNode({ ...FUNDED, chainLagBlocks: 0, batch: fundingBatch({ ttlSeconds: 6 * DAY }), ...stage }),
          fundingNode({
            nodeId: NODE_RUNG,
            label: 'Main stage 720p rung',
            role: 'rung',
            walletAddress: WALLET_RUNG,
            ...FUNDED,
            chainLagBlocks: 0,
            batch: fundingBatch({ batchId: BATCH_RUNG, ttlSeconds: 6.5 * DAY }),
            ...rung,
          }),
        ],
      },
    ],
    catalogue: fundingNode({
      nodeId: NODE_CATALOGUE,
      label: 'Catalogue node',
      walletAddress: WALLET_C,
      ...FUNDED,
      chainLagBlocks: 0,
      batch: fundingBatch({ batchId: BATCH_CATALOGUE, depth: 18, ttlSeconds: 40 * DAY }),
    }),
  });
}

function mark(nodeId: string, batchId: string, over: Partial<AutoTopUpMarkRow> = {}): AutoTopUpMarkRow {
  return {
    batchId,
    nodeId,
    nodeLabel: nodeId,
    markedAt: new Date(NOW - 30 * DAY * 1000),
    markedBy: 'test-operator',
    alert: null,
    unreadSince: null,
    ...over,
  };
}

/** What the stamp job uses of the store, in memory. */
class StampJobStore implements AutoTopUpStampJobStore {
  readonly unread = new Map<string, Date | null>();
  topUps: AutoTopUpJournalledTopUp[] = [];

  async setUnreadSince(batchId: string, since: Date | null): Promise<void> {
    this.unread.set(batchId, since);
  }

  async lastSystemTopUps(batchIds: readonly string[]): Promise<AutoTopUpJournalledTopUp[]> {
    return this.topUps.filter((topUp) => batchIds.includes(topUp.batchId));
  }
}

let manager: FakeFundingManager;
let journal: InMemoryFundingStampStore;
let stamps: FundingStampService;
let store: StampJobStore;
let job: AutoTopUpStampJob;

function context(marks: AutoTopUpMarkRow[], read: FundingInventory = manager.inventoryAnswer): AutoTopUpTickContext {
  return {
    now: new Date(NOW),
    settings: { ...AUTO_TOPUP_DEFAULTS },
    funding: { inventory: read, postage: POSTAGE, brandWallet: null, pins: new Map() },
    stamps: markedStampsOf(read, marks),
  };
}

beforeEach(() => {
  manager = new FakeFundingManager();
  manager.inventoryAnswer = inventory();
  journal = new InMemoryFundingStampStore();
  stamps = new FundingStampService({ manager, journal, audit: new InMemoryAuditLog(), now: () => NOW, waitMs: 5 });
  store = new StampJobStore();
  job = new AutoTopUpStampJob({ stamps, store });
});

describe('the stamp job', () => {
  it('tops up the due stamps whose node covers them, in one stamp operation as the system, to the level', async () => {
    const marks = [mark(NODE_A, BATCH_STAGE), mark(NODE_RUNG, BATCH_RUNG), mark(NODE_CATALOGUE, BATCH_CATALOGUE)];

    const result = await job.run(context(marks));
    await stamps.idle();

    assert.equal(result.ok, true, result.outcome);
    assert.match(result.outcome, /^Asked to top up 0xb1b1b1b1… by 8 days for [\d.,]+ xBZZ; 0xd3d3d3d3… by 7 days/);
    const rows = [...journal.rows.values()].sort((a, b) => a.position - b.position);
    assert.deepEqual(
      rows.map((row) => [row.nodeId, row.batchId, row.kind, row.days, row.expectedDepth, row.bulkId]),
      [
        [NODE_A, BATCH_STAGE, 'topup', 8, 20, rows[0]!.bulkId],
        [NODE_RUNG, BATCH_RUNG, 'topup', 7, 20, rows[0]!.bulkId],
      ],
      'one operation, the whole days to 14 for each; the catalogue batch is not due',
    );
    assert.deepEqual(
      rows.map((row) => [row.requestedByKind, row.requestedBy, row.requestedByUserId]),
      [
        ['system', STAMP_AUTO_TOPUP.reason, null],
        ['system', STAMP_AUTO_TOPUP.reason, null],
      ],
    );
    const plan = autoTopUpStampPlan({ depth: 20, ttlSeconds: 6 * DAY }, AUTO_TOPUP_DEFAULTS, POSTAGE);
    assert.equal(rows[0]!.costPlur, plan.costPlur, "the rule's cost at the tick's price");
    assert.equal(manager.calls.relay, 0, 'nothing is sent from the brand wallet');
  });

  it("leaves a short node's stamps for the wallet job, and tops up what a wallet covers", async () => {
    const plan = autoTopUpStampPlan({ depth: 20, ttlSeconds: 6 * DAY }, AUTO_TOPUP_DEFAULTS, POSTAGE);
    // The stage's node holds its own top-up and no more; the rung's node holds nothing.
    manager.inventoryAnswer = inventory({ xbzzPlur: plan.costPlur }, { xbzzPlur: '0' });
    const marks = [mark(NODE_A, BATCH_STAGE), mark(NODE_RUNG, BATCH_RUNG)];

    const result = await job.run(context(marks));
    await stamps.idle();

    assert.deepEqual(
      [...journal.rows.values()].map((row) => row.batchId),
      [BATCH_STAGE],
    );
    assert.match(result.outcome, /Waiting for the wallet job's send, since their node is short: 0xd3d3d3d3…\./);
    assert.equal(result.ok, true);
  });

  it('tops up the stamp with the least time left first when its wallet covers only one', async () => {
    const urgent = autoTopUpStampPlan({ depth: 20, ttlSeconds: 6 * DAY }, AUTO_TOPUP_DEFAULTS, POSTAGE);
    // The rung's node uploads with the stage's batch too: one wallet pays for both stamps, and holds one top-up.
    manager.inventoryAnswer = inventory(
      { xbzzPlur: urgent.costPlur },
      { walletAddress: fundingNode().walletAddress, xbzzPlur: urgent.costPlur },
    );

    await job.run(context([mark(NODE_RUNG, BATCH_RUNG), mark(NODE_A, BATCH_STAGE)]));
    await stamps.idle();

    assert.deepEqual(
      [...journal.rows.values()].map((row) => row.batchId),
      [BATCH_STAGE],
      'the 6-day stamp before the 6.5-day one, whatever the order of the marks',
    );
  });

  it('asks for nothing when no covered stamp is due, and never from the brand wallet', async () => {
    manager.inventoryAnswer = inventory({ xbzzPlur: '0' }, { xbzzPlur: '0' });

    const result = await job.run(context([mark(NODE_A, BATCH_STAGE), mark(NODE_RUNG, BATCH_RUNG)]));

    assert.equal(journal.rows.size, 0);
    assert.equal(manager.calls.relay, 0);
    assert.match(result.outcome, /^Nothing was topped up\. Waiting for the wallet job's send/);
  });

  it('leaves a stamp the system topped up within the last day, as a failure', async () => {
    store.topUps = [
      { batchId: BATCH_STAGE, at: new Date(NOW - 23 * 3600 * 1000), days: 8, costPlur: '1', state: 'confirmed' },
      { batchId: BATCH_RUNG, at: new Date(NOW - 25 * 3600 * 1000), days: 7, costPlur: '1', state: 'confirmed' },
    ];

    const result = await job.run(context([mark(NODE_A, BATCH_STAGE), mark(NODE_RUNG, BATCH_RUNG)]));
    await stamps.idle();

    assert.deepEqual(
      [...journal.rows.values()].map((row) => row.batchId),
      [BATCH_RUNG],
      'a top-up more than a day ago allows another',
    );
    assert.equal(result.ok, false);
    assert.match(result.outcome, /Due again within a day of their last automatic top-up, so left: 0xb1b1b1b1…\./);
  });

  it('goes by a current view of the chain only, and keeps since when a stamp could not be read', async () => {
    manager.inventoryAnswer = inventory({ chainLagBlocks: 121 }, { chainLagBlocks: null });
    const earlier = new Date(NOW - 600_000);
    const marks = [mark(NODE_A, BATCH_STAGE), mark(NODE_RUNG, BATCH_RUNG, { unreadSince: earlier })];

    const result = await job.run(context(marks));

    assert.equal(journal.rows.size, 0, 'nothing on a view that is behind or not known');
    assert.deepEqual(
      [...store.unread],
      [[BATCH_STAGE, new Date(NOW)]],
      'the one unread since earlier keeps its moment',
    );
    assert.match(result.outcome, /is 121 blocks behind/);
    assert.match(result.outcome, /does not say how far behind the chain/);

    manager.inventoryAnswer = inventory();
    store.unread.clear();
    await job.run(context([mark(NODE_A, BATCH_STAGE, { unreadSince: new Date(NOW) }), mark(NODE_RUNG, BATCH_RUNG)]));
    await stamps.idle();
    assert.deepEqual([...store.unread], [[BATCH_STAGE, null]], 'cleared once it reads well');
    assert.equal(journal.rows.size, 2);
  });

  it('leaves an expired stamp, one its node holds no more, one not usable yet, and one no funded node holds', async () => {
    const archive = `0x${'a4'.repeat(32)}`;
    const read = inventory({ batch: fundingBatch({ ttlSeconds: 0, state: 'expired' }) }, { batch: null });
    read.catalogue = {
      ...read.catalogue!,
      batch: fundingBatch({ batchId: BATCH_CATALOGUE, depth: 18, ttlSeconds: DAY, usable: false }),
    };
    read.archiveBatches = [
      {
        ...fundingBatch({ batchId: archive, depth: 22, immutable: true, ttlSeconds: DAY }),
        nodeId: 'catalogue-old:uploader',
        nodeLabel: 'Former catalogue node',
        label: null,
        writable: false,
      },
    ];
    manager.inventoryAnswer = read;
    const marks = [
      mark(NODE_A, BATCH_STAGE),
      mark(NODE_RUNG, BATCH_RUNG),
      mark(NODE_CATALOGUE, BATCH_CATALOGUE),
      mark('catalogue-old:uploader', archive),
    ];

    const result = await job.run(context(marks));

    assert.equal(journal.rows.size, 0);
    assert.match(result.outcome, /0xb1b1b1b1… cannot be topped up: it expired, and takes a Buy new\./);
    assert.match(result.outcome, /0xd3d3d3d3… cannot be topped up: its node holds it no more/);
    assert.match(
      result.outcome,
      /0xa4a4a4a4… cannot be topped up: it is held by a node that is the catalogue node no longer/,
    );
    assert.doesNotMatch(result.outcome, /0xc2c2c2c2/, 'a batch not usable yet just waits');
    assert.equal(result.ok, false, 'a stamp no funded node holds is for a person to look at');
  });

  it('asks for nothing while a stamp operation is under way, and the next run tries again', async () => {
    let release!: () => void;
    manager.stampGate = new Promise((resolve) => (release = resolve));
    await stamps.request(STAMP_AUTO_TOPUP, [
      {
        kind: 'topup',
        nodeId: NODE_CATALOGUE,
        batchId: BATCH_CATALOGUE,
        expectedDepth: 18,
        days: 1,
        pricePerChunkPerBlockPlur: POSTAGE.pricePerChunkPerBlockPlur,
      },
    ]);

    const result = await job.run(context([mark(NODE_A, BATCH_STAGE)]));

    assert.deepEqual(result, {
      ok: true,
      outcome: 'A stamp operation is still under way, so nothing was asked for. The next run tries again.',
    });
    assert.deepEqual(
      [...journal.rows.values()].map((row) => row.batchId),
      [BATCH_CATALOGUE],
    );
    release();
    await stamps.idle();
  });

  it('asks for nothing when the price rose since the tick read it, and the next run quotes again', async () => {
    const read = inventory();
    manager.inventoryAnswer = {
      ...read,
      chain: { ...read.chain, postage: { ...POSTAGE, pricePerChunkPerBlockPlur: '25000' } },
    };

    const result = await job.run(context([mark(NODE_A, BATCH_STAGE)], read));

    assert.equal(journal.rows.size, 0);
    assert.equal(result.ok, true);
    assert.match(
      result.outcome,
      /^Nothing was topped up: The price of postage has risen .* The next run quotes again\.$/,
    );
  });
});
