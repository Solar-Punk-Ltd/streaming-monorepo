/**
 * The wallet job of stamp auto top-up, through the real send of the Balance tab: the brand wallet signs for real with
 * a key generated here, and the manager, the journals, the pins and the store of stamp auto top-up are in memory.
 * Pinned here: what a short node lacks for its due top-up is sent as the system once its alert is a look-ahead old, or
 * at once under two look-aheads left; never more than the alert said; only to a confirmed address; within the daily
 * ceiling; the least time left first, each node in full or not at all; gas once a node a day; nothing for a node that
 * holds enough or a stamp topped up within the day; an earlier send that is not settled leaves the run to the next; and
 * a due top-up it cannot send for raises the warning of a failed top-up once the stamp has been due for an hour.
 * Unit test, `pnpm test`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import type { FundingAccountAnswer, FundingInventory, FundingNode } from '@streaming-monorepo/contracts';
import {
  AUTO_TOPUP_DEFAULTS,
  autoTopUpMonthlyEstimatePlur,
  autoTopUpStampPlan,
  NODE_GAS_FUND_WEI,
  type AutoTopUpSettings,
  type FundingTransferItemRequest,
} from '@streaming-monorepo/web2-admin-common';

import { STAMP_AUTO_TOPUP } from '../../src/domain/actor.js';
import { markedStampsOf, type AutoTopUpTickContext } from '../../src/domain/funding/autoTopUpJobs.js';
import { AutoTopUpWalletJob } from '../../src/domain/funding/AutoTopUpWalletJob.js';
import { FundingChequebookService } from '../../src/domain/funding/FundingChequebookService.js';
import { FundingService } from '../../src/domain/funding/FundingService.js';
import { FundingStampService } from '../../src/domain/funding/FundingStampService.js';
import type { AutoTopUpAlert, AutoTopUpMarkRow } from '../../src/domain/funding/StampAutoTopUpStore.js';

import { InMemoryStampAutoTopUpStore } from './support/autoTopUpFakes.js';
import { InMemoryAuditLog, TEST_OPERATOR } from './support/fakes.js';
import {
  BATCH_RUNG,
  BATCH_STAGE,
  BZZ_TOKEN,
  DAY,
  FakeFundingManager,
  FakeFundingWallet,
  fundingAccount,
  fundingBatch,
  fundingInventory,
  fundingNode,
  InMemoryFundingChequebookStore,
  InMemoryFundingPinStore,
  InMemoryFundingStampStore,
  InMemoryFundingTransferStore,
  NODE_A,
  NODE_RUNG,
  ONE_XDAI,
  POSTAGE,
  WALLET_A,
  WALLET_B,
  WALLET_RUNG,
} from './support/fundingFakes.js';
import { STAGE_ID } from './support/stageFakes.js';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const HOUR_MS = 3_600_000;
/** The depth of the test batches: 2^17 chunks, so a day of top-up costs about 5.4 xBZZ at the test's price. */
const DEPTH = 17;

/** A stamp's plan at `days` left, by the default numbers. */
function planAt(days: number) {
  return autoTopUpStampPlan({ depth: DEPTH, ttlSeconds: days * DAY }, AUTO_TOPUP_DEFAULTS, POSTAGE);
}

/**
 * The stage's own node and its 720p rung's node, each with a batch of depth 17, `days` left, and a wallet that holds
 * no xBZZ and 0.1 xDAI, unless told otherwise; every node's view of the chain is current.
 */
function inventory(
  stage: { days: number } & Partial<FundingNode>,
  rung: { days: number } & Partial<FundingNode> = { days: 30 },
): FundingInventory {
  const node = ({ days, ...over }: { days: number } & Partial<FundingNode>, defaults: Partial<FundingNode>) =>
    fundingNode({
      xdaiWei: (ONE_XDAI / 10n).toString(),
      xbzzPlur: '0',
      chainLagBlocks: 0,
      ...defaults,
      batch: fundingBatch({ batchId: defaults.batch?.batchId ?? BATCH_STAGE, depth: DEPTH, ttlSeconds: days * DAY }),
      ...over,
    });
  return fundingInventory({
    chain: { chainId: 100, bzzToken: BZZ_TOKEN, postage: POSTAGE },
    stages: [
      {
        stageId: STAGE_ID,
        name: 'Main stage',
        nodes: [
          node(stage, {}),
          node(rung, {
            nodeId: NODE_RUNG,
            label: 'Main stage 720p rung',
            role: 'rung',
            walletAddress: WALLET_RUNG,
            batch: fundingBatch({ batchId: BATCH_RUNG }),
          }),
        ],
      },
    ],
    catalogue: null,
  });
}

/** An alert given `hoursAgo`, saying the brand wallet sends `sendPlur` and, or not, gas. */
function alert(hoursAgo: number, sendPlur: string, gasSend = false): AutoTopUpAlert {
  const at = new Date(NOW - hoursAgo * HOUR_MS);
  return { days: 8, costPlur: '1', costWithMarginPlur: '2', sendPlur, gasSend, recordedAt: at, alertedAt: at };
}

function mark(nodeId: string, batchId: string, given: AutoTopUpAlert | null): AutoTopUpMarkRow {
  return {
    batchId,
    nodeId,
    nodeLabel: nodeId,
    markedAt: new Date(NOW - 30 * DAY * 1000),
    markedBy: 'test-operator',
    alert: given,
    unreadSince: null,
  };
}

let wallet: FakeFundingWallet;
let manager: FakeFundingManager;
let transfers: InMemoryFundingTransferStore;
let stampJournal: InMemoryFundingStampStore;
let pins: InMemoryFundingPinStore;
let store: InMemoryStampAutoTopUpStore;
let funding: FundingService;
let job: AutoTopUpWalletJob;

/**
 * A tick's context over `read`, with these stamps marked in the store, whose brand wallet holds what `account` says,
 * the manager answering the same.
 */
async function context(
  marks: AutoTopUpMarkRow[],
  read: FundingInventory,
  options: { account?: Partial<FundingAccountAnswer>; settings?: Partial<AutoTopUpSettings> } = {},
): Promise<AutoTopUpTickContext> {
  manager.inventoryAnswer = read;
  manager.accountAnswer = (address) => fundingAccount(address, options.account);
  store.markRows.clear();
  for (const row of marks) store.markRows.set(row.batchId, row);
  const confirmed = new Map([...(await pins.all()).values()].map((pin) => [pin.nodeId, pin.walletAddress]));
  return {
    now: new Date(NOW),
    settings: { ...AUTO_TOPUP_DEFAULTS, ...options.settings },
    funding: {
      inventory: read,
      postage: POSTAGE,
      brandWallet: fundingAccount(wallet.address()!, options.account),
      pins: confirmed,
    },
    stamps: markedStampsOf(read, marks),
  };
}

/** A send the system made `hoursAgo`, mined, as the journal keeps it. */
async function journalledSend(items: FundingTransferItemRequest[], hoursAgo: number): Promise<void> {
  const answer = await funding.send(STAMP_AUTO_TOPUP, items);
  for (const item of answer.items) {
    transfers.force(item.requestId, 'confirmed', { createdAt: new Date(NOW - hoursAgo * HOUR_MS) });
  }
}

/** A top-up the system asked for `hoursAgo`, as the stamp journal keeps it. */
async function journalledTopUp(nodeId: string, batchId: string, hoursAgo: number): Promise<void> {
  const requestId = randomUUID();
  await stampJournal.insertAll([
    {
      requestId,
      bulkId: randomUUID(),
      position: 0,
      nodeId,
      nodeLabel: nodeId,
      batchId,
      kind: 'topup',
      days: 8,
      steps: null,
      expectedDepth: DEPTH,
      newDepth: null,
      amountPerChunkPlur: '1',
      costPlur: '1',
      requestedByUserId: null,
      requestedBy: STAMP_AUTO_TOPUP.reason,
      requestedByKind: 'system',
    },
  ]);
  stampJournal.force(requestId, 'submitted', { createdAt: new Date(NOW - hoursAgo * HOUR_MS) });
}

/**
 * The transfers of the journal after the first `before` of them, as kind, node and amount, in the order they were
 * journalled: each send's in its own order, the one the nonces follow.
 */
function sentTransfers(before = 0): [string, string, string][] {
  return [...transfers.rows.values()].slice(before).map((row) => [row.kind, row.nodeId, row.amount]);
}

/** The standing warnings of a failed top-up, by batch, with what each says. */
function failures(): [string | null, string][] {
  return store.warningRows.filter((row) => row.kind === 'topup_failed').map((row) => [row.batchId, row.message]);
}

beforeEach(() => {
  wallet = new FakeFundingWallet();
  manager = new FakeFundingManager();
  transfers = new InMemoryFundingTransferStore();
  stampJournal = new InMemoryFundingStampStore();
  pins = new InMemoryFundingPinStore();
  pins.set(NODE_A, WALLET_A);
  pins.set(NODE_RUNG, WALLET_RUNG);
  store = new InMemoryStampAutoTopUpStore({ transfers, stamps: stampJournal });
  const audit = new InMemoryAuditLog();
  funding = new FundingService({
    wallet,
    manager,
    transfers,
    pins,
    stamps: new FundingStampService({ manager, journal: stampJournal, audit, now: () => NOW }),
    chequebooks: new FundingChequebookService({
      manager,
      journal: new InMemoryFundingChequebookStore(),
      audit,
      now: () => NOW,
    }),
    audit,
    now: () => NOW,
  });
  job = new AutoTopUpWalletJob({ funding, store });
});

describe('the wallet job', () => {
  it('sends a short node what its due top-up lacks, the cost plus the margin, as the system, a day after the alert', async () => {
    const lack = planAt(6).costWithMarginPlur;

    const result = await job.run(await context([mark(NODE_A, BATCH_STAGE, alert(25, lack))], inventory({ days: 6 })));

    assert.equal(result.ok, true, result.outcome);
    assert.deepEqual(sentTransfers(), [['xbzz', NODE_A, lack]]);
    const [row] = [...transfers.rows.values()];
    assert.deepEqual(
      [row!.requestedByKind, row!.requestedBy, row!.requestedByUserId],
      ['system', STAMP_AUTO_TOPUP.reason, null],
    );
    assert.equal(wallet.signed.length, 1, 'signed with no password');
    assert.match(result.outcome, /^Sent [\d.,]+ xBZZ to Main stage uploader \(stage-1:uploader\)\.$/);
    assert.deepEqual(failures(), []);
  });

  it('waits while the alert is younger than a look-ahead, or was never given, with two look-aheads left or more', async () => {
    const lack = planAt(6).costWithMarginPlur;

    const young = await job.run(await context([mark(NODE_A, BATCH_STAGE, alert(23, lack))], inventory({ days: 6 })));
    const none = await job.run(await context([mark(NODE_A, BATCH_STAGE, null)], inventory({ days: 2 })));

    assert.equal(transfers.rows.size, 0);
    assert.deepEqual(young, {
      ok: true,
      outcome: "Short nodes waiting for their top-up's alert to be a look-ahead old: 1.",
    });
    assert.equal(none.outcome, young.outcome, 'two days left is not under two look-aheads');
    assert.deepEqual(failures(), [], 'waiting for the notice is no failure');
  });

  it('sends at once under two look-aheads left, with no notice or past its figure, and says so', async () => {
    const lack = planAt(1.5).costWithMarginPlur;

    const result = await job.run(await context([mark(NODE_A, BATCH_STAGE, alert(1, '1'))], inventory({ days: 1.5 })));

    assert.deepEqual(sentTransfers(), [['xbzz', NODE_A, lack]]);
    assert.match(result.outcome, /without the day of notice, since a stamp of it has under two look-aheads left/);
  });

  it('never sends more than the alert said: past it, the top-up waits for a new alert', async () => {
    const lack = BigInt(planAt(6).costWithMarginPlur);

    const result = await job.run(
      await context([mark(NODE_A, BATCH_STAGE, alert(25, (lack - 1n).toString()))], inventory({ days: 6 })),
    );

    assert.equal(transfers.rows.size, 0);
    assert.deepEqual(result, {
      ok: true,
      outcome: "Short nodes that lack more than their top-up's alert said, waiting for a new alert: 1.",
    });
    assert.deepEqual(failures(), []);
  });

  it('sends only to an address an operator confirmed, never to one that changed since, and raises their failures', async () => {
    pins.rows.delete(NODE_A);
    pins.set(NODE_RUNG, WALLET_B);
    const marks = [
      mark(NODE_A, BATCH_STAGE, alert(25, planAt(6).costWithMarginPlur)),
      mark(NODE_RUNG, BATCH_RUNG, alert(25, planAt(6).costWithMarginPlur)),
    ];

    const result = await job.run(await context(marks, inventory({ days: 6 }, { days: 6 })));

    assert.equal(transfers.rows.size, 0);
    assert.equal(result.ok, false);
    assert.match(
      result.outcome,
      /Nothing was sent to Main stage uploader \(stage-1:uploader\): no operator has confirmed its wallet\./,
    );
    assert.match(
      result.outcome,
      /Nothing was sent to Main stage 720p rung \(stage-2:uploader\): it answers another wallet than the one an operator confirmed\./,
    );
    assert.deepEqual(failures(), [
      [
        BATCH_STAGE,
        'The batch of stage "Main stage" (batch 0xb1b1b1b1…, on Main stage uploader) could not be topped up. It has 6 days left. Its node, Main stage uploader (stage-1:uploader), is short, and no operator has confirmed the node\'s wallet, so the brand wallet sends it nothing. Confirm the node\'s wallet on the Balance tab.',
      ],
      [
        BATCH_RUNG,
        'The batch of stage "Main stage" (batch 0xd3d3d3d3…, on Main stage 720p rung) could not be topped up. It has 6 days left. Its node, Main stage 720p rung (stage-2:uploader), is short, and it answers another wallet than the one an operator confirmed, so the brand wallet sends it nothing. Check the node, and confirm its wallet again on the Balance tab.',
      ],
    ]);
  });

  it('raises a top-up it cannot send for only once the stamp has been due for an hour', async () => {
    pins.rows.delete(NODE_A);
    const days = 7 - 0.5 / 24;
    const marks = [mark(NODE_A, BATCH_STAGE, alert(25, planAt(days).costWithMarginPlur))];

    const fresh = await job.run(await context(marks, inventory({ days })));
    assert.equal(fresh.ok, false);
    assert.deepEqual(failures(), [], 'due for half an hour');

    await job.run(await context(marks, inventory({ days: 7 - 1 / 24 })));
    assert.deepEqual(
      failures().map(([batchId]) => batchId),
      [BATCH_STAGE],
      'due for an hour',
    );
  });

  it('sends within the daily ceiling only, which follows half the monthly estimate while none is saved', async () => {
    const lack = BigInt(planAt(6).costWithMarginPlur);
    const marks = [mark(NODE_A, BATCH_STAGE, alert(25, lack.toString()))];
    const read = inventory({ days: 6 }, { days: 6 });
    const ceiling = BigInt(autoTopUpMonthlyEstimatePlur([DEPTH], POSTAGE)) / 2n;
    assert.ok(ceiling > lack, 'the estimate of the one marked stamp lets its top-up through');

    // What went to the rung's node 23 hours ago counts; what went 25 hours ago does not.
    await context(marks, read);
    await journalledSend([{ nodeId: NODE_RUNG, kind: 'xbzz', amount: (ceiling - lack + 1n).toString() }], 23);
    await journalledSend([{ nodeId: NODE_RUNG, kind: 'xbzz', amount: lack.toString() }], 25);
    const over = await job.run(await context(marks, read));
    assert.deepEqual(sentTransfers(2), []);
    assert.equal(over.ok, false);
    assert.match(
      over.outcome,
      /would pass the daily ceiling of [\d.,]+ xBZZ, of which [\d.,]+ xBZZ went in the last 24 hours\./,
    );
    assert.match(failures()[0]![1], /would pass the daily ceiling of/);

    const saved = await job.run(await context(marks, read, { settings: { dailyCeilingPlur: '0' } }));
    assert.deepEqual(sentTransfers(2), [], 'a saved ceiling holds as well');
    assert.equal(saved.ok, false);
  });

  it('sends up to the daily ceiling exactly', async () => {
    const lack = BigInt(planAt(6).costWithMarginPlur);
    const marks = [mark(NODE_A, BATCH_STAGE, alert(25, lack.toString()))];
    const read = inventory({ days: 6 });
    const ceiling = BigInt(autoTopUpMonthlyEstimatePlur([DEPTH], POSTAGE)) / 2n;

    await context(marks, read);
    await journalledSend([{ nodeId: NODE_RUNG, kind: 'xbzz', amount: (ceiling - lack).toString() }], 1);
    await job.run(await context(marks, read));

    assert.deepEqual(sentTransfers(1), [['xbzz', NODE_A, lack.toString()]]);
  });

  it('funds the least time left first, each node in full; one the brand wallet cannot cover holds back the rest', async () => {
    const urgent = BigInt(planAt(5).costWithMarginPlur);
    const later = BigInt(planAt(6).costWithMarginPlur);
    assert.ok(later < urgent);
    const marks = [
      mark(NODE_RUNG, BATCH_RUNG, alert(25, later.toString())),
      mark(NODE_A, BATCH_STAGE, alert(25, urgent.toString())),
    ];
    const read = inventory({ days: 5 }, { days: 6 });

    const first = await job.run(
      await context(marks, read, { account: { xbzzPlur: (urgent + later - 1n).toString() } }),
    );
    assert.deepEqual(sentTransfers(), [['xbzz', NODE_A, urgent.toString()]], 'the 5-day node, then the money ran out');
    assert.equal(first.ok, false);
    assert.match(
      first.outcome,
      /Nothing was sent to Main stage 720p rung \(stage-2:uploader\): the brand wallet cannot cover/,
    );
    assert.match(
      failures()[0]![1],
      /the brand wallet cannot cover the [\d.,]+ xBZZ it lacks in full, fees counted\. Send xBZZ and xDAI to the brand wallet, 0x/,
    );

    transfers.rows.clear();
    await job.run(await context(marks, read, { account: { xbzzPlur: (urgent - 1n).toString() } }));
    assert.equal(transfers.rows.size, 0, 'the most urgent node cannot be covered, so the rest get nothing either');
  });

  it('sends gas with the xBZZ when the wallet lacks it and the alert said so, to a node once a day', async () => {
    const lack = planAt(6).costWithMarginPlur;
    const marks = [mark(NODE_A, BATCH_STAGE, alert(25, lack, true))];
    const read = inventory({ days: 6, xdaiWei: '0' });
    // A ceiling that takes two sends of it in a day.
    const settings = { dailyCeilingPlur: (1000n * 10n ** 16n).toString() };

    const result = await job.run(await context(marks, read, { settings }));
    assert.deepEqual(sentTransfers(), [
      ['xbzz', NODE_A, lack],
      ['xdai', NODE_A, NODE_GAS_FUND_WEI],
    ]);
    assert.match(result.outcome, /^Sent [\d.,]+ xBZZ and 0\.01 xDAI for its gas to Main stage uploader/);

    // That send is mined, an hour ago, and the node still lacks gas.
    for (const row of transfers.rows.values()) {
      transfers.force(row.requestId, 'confirmed', { createdAt: new Date(NOW - HOUR_MS) });
    }
    const again = await job.run(await context(marks, read, { settings }));
    assert.deepEqual(sentTransfers(2), [['xbzz', NODE_A, lack]], 'no second gas transfer in a day');
    assert.match(again.outcome, /stage-1:uploader was sent gas within the last day, so no more went to it\./);
    assert.match(failures()[0]![1], /it was sent gas within the last day already/);
  });

  it('sends nothing for a node that holds what its top-up costs, nor for a stamp topped up within the day', async () => {
    const plan = planAt(6);
    const covered = await job.run(
      await context(
        [mark(NODE_A, BATCH_STAGE, alert(25, plan.costWithMarginPlur))],
        inventory({ days: 6, xbzzPlur: plan.costPlur }),
      ),
    );
    assert.deepEqual(covered, {
      ok: true,
      outcome: "Every due stamp's node holds what its top-up costs, so nothing was sent.",
    });

    await journalledTopUp(NODE_A, BATCH_STAGE, 2);
    const recent = await job.run(
      await context([mark(NODE_A, BATCH_STAGE, alert(25, plan.costWithMarginPlur))], inventory({ days: 6 })),
    );
    assert.equal(
      recent.outcome,
      'Every due marked stamp was topped up within the last day, so nothing was sent for it again.',
    );

    const healthy = await job.run(await context([mark(NODE_A, BATCH_STAGE, null)], inventory({ days: 8 })));
    assert.equal(healthy.outcome, 'No marked stamp is due, so nothing was sent.');
    assert.equal(transfers.rows.size, 0);
    assert.deepEqual(failures(), []);
  });

  it('sends nothing while an earlier send is not settled, raises the failure, and the next run tries again', async () => {
    const lack = planAt(6).costWithMarginPlur;
    const ticked = await context([mark(NODE_A, BATCH_STAGE, alert(25, lack))], inventory({ days: 6 }));
    // A person's send, which the manager took and has not seen mined yet.
    await funding.send(TEST_OPERATOR, [{ nodeId: NODE_A, kind: 'xdai', amount: '1' }]);

    const result = await job.run(ticked);

    assert.deepEqual(result, {
      ok: true,
      outcome:
        'An earlier send from the brand wallet is not settled yet, so nothing was sent. The next run tries again.',
    });
    assert.deepEqual(sentTransfers(), [['xdai', NODE_A, '1']]);
    assert.match(
      failures()[0]![1],
      /an earlier send from the brand wallet is not settled yet, so nothing could be sent to it/,
    );
  });

  it('sends nothing with no brand wallet key, and says so', async () => {
    const lack = planAt(6).costWithMarginPlur;
    const ticked = await context([mark(NODE_A, BATCH_STAGE, alert(25, lack))], inventory({ days: 6 }));

    const result = await job.run({ ...ticked, funding: { ...ticked.funding, brandWallet: null } });

    assert.equal(transfers.rows.size, 0);
    assert.equal(result.ok, false);
    assert.match(result.outcome, /there is no brand wallet to send from, since BRAND_WALLET_SECRET is unset\./);
    assert.match(failures()[0]![1], /there is no brand wallet to send from/);
  });
});
