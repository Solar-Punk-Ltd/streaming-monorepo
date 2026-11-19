/**
 * Buying a new batch from the Stamps tab: the purchase service over its table in memory, a fake of the manager's
 * funding API and a fake of the catalogue move's port. `pnpm test`.
 *
 * Pinned here: a purchase is checked against the inventory read fresh and refused, nothing written and nothing asked,
 * in each way the plan names; it is written before the manager is asked, with the fields its row holds, and never
 * asked for twice; one runs on a node at a time; the manager's steps move it, a rung's stages and a catalogue's move
 * with them, and a catalogue purchase releases the batch it moved from once its move is done; Restart now and Check
 * again go to the manager under the purchase; each is audited.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  BATCH_PURCHASE_MOVE_OFF,
  BATCH_PURCHASES_NOT_OFFERED,
  type BatchPurchase,
  type BatchPurchaseRequest,
  batchBuyAmountPerChunkPlur,
} from '@streaming-monorepo/web2-admin-common';

import { FundingManagerUnavailableError, FundingRefusedError } from '../../src/domain/errors/index.js';
import { BatchPurchaseService, type BatchPurchaseServiceDeps } from '../../src/domain/funding/BatchPurchaseService.js';
import { ManagerFundingError } from '../../src/domain/funding/ManagerFundingClient.js';

import {
  BOUGHT,
  costOf,
  FakeCatalogueMove,
  FakePurchaseManager,
  FOLLOWING_STAGE,
  InMemoryBatchPurchaseStore,
  purchaseInventory,
  purchaseStatus,
} from './support/batchPurchaseFakes.js';
import { InMemoryAuditLog, TEST_OPERATOR } from './support/fakes.js';
import {
  BATCH_CATALOGUE,
  BATCH_RUNG,
  fundingBatch,
  NODE_B,
  NODE_CATALOGUE,
  NODE_RUNG,
  POSTAGE,
} from './support/fundingFakes.js';

const START = 1_700_000_000_000;

let store: InMemoryBatchPurchaseStore;
let manager: FakePurchaseManager;
let move: FakeCatalogueMove;
let audit: InMemoryAuditLog;
let service: BatchPurchaseService;
let clock: number;

function makeService(over: Partial<BatchPurchaseServiceDeps> = {}): BatchPurchaseService {
  let next = 0;
  return new BatchPurchaseService({
    manager,
    store,
    move,
    audit,
    newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    now: () => clock,
    pollMs: 60_000,
    waitMs: 1_000,
    ...over,
  });
}

beforeEach(() => {
  store = new InMemoryBatchPurchaseStore();
  manager = new FakePurchaseManager(store);
  move = new FakeCatalogueMove();
  audit = new InMemoryAuditLog();
  clock = START;
  service = makeService();
});

/** A rung's batch for 10 days at depth 22, in place of the expired one. */
function rung(over: Partial<BatchPurchaseRequest> = {}): BatchPurchaseRequest {
  return {
    purpose: 'rung',
    nodeId: NODE_RUNG,
    depth: 22,
    immutable: false,
    days: 10,
    costPlur: costOf(22, 10),
    replacesBatchId: BATCH_RUNG,
    ...over,
  };
}

/** A catalogue batch for 30 days at depth 18, in place of the one its node holds no more. */
function catalogue(over: Partial<BatchPurchaseRequest> = {}): BatchPurchaseRequest {
  return {
    purpose: 'catalogue',
    nodeId: NODE_CATALOGUE,
    depth: 18,
    immutable: true,
    days: 30,
    costPlur: costOf(18, 30),
    replacesBatchId: BATCH_CATALOGUE,
    ...over,
  };
}

/** What `run` threw, which has to be the admin's refusal. */
async function refusal(run: () => Promise<unknown>): Promise<FundingRefusedError> {
  const error = await run().then(
    () => assert.fail('it was not refused'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof FundingRefusedError, String(error));
  return error;
}

/** The purchase as it stands once the manager is read again. */
async function read(id: string): Promise<BatchPurchase> {
  const purchase = await service.get(id);
  assert.ok(purchase, 'the purchase is gone');
  return purchase;
}

/** Sets what the manager's status route answers for a purchase it was sent. */
function managerSays(purchase: BatchPurchase, over: Parameters<typeof purchaseStatus>[1]): void {
  manager.statuses.set(
    purchase.id,
    purchaseStatus({ requestId: purchase.id, purpose: purchase.purpose, nodeId: purchase.nodeId }, over),
  );
}

describe('BatchPurchaseService: a start', () => {
  it('writes the purchase before it asks the manager, with the fields its row holds, priced at the price read now', async () => {
    const started = await service.start(TEST_OPERATOR, rung());

    assert.equal(started.state, 'buying');
    assert.deepEqual(manager.writtenFirst, [true], 'written before the manager was asked');
    assert.deepEqual(manager.requests, [
      {
        requestId: started.id,
        purpose: 'rung',
        nodeId: NODE_RUNG,
        depth: 22,
        amountPerChunkPlur: batchBuyAmountPerChunkPlur(10, POSTAGE),
        immutable: false,
        label: null,
        replacesBatchId: BATCH_RUNG,
      },
    ]);
    const row = store.rows.get(started.id)!;
    assert.ok(row.relayedAt, 'marked sent');
    assert.equal(row.replacesBatchId, BATCH_RUNG.slice(2), 'kept without 0x, as the admin keeps a batch id');
    assert.equal(started.replacesBatchId, BATCH_RUNG, 'answered with 0x');
    assert.equal(started.costPlur, costOf(22, 10));
    const [entry] = audit.withAction('funding.purchase.request');
    assert.equal(entry?.details?.purchaseId, started.id);
    assert.equal(entry?.details?.costPlur, costOf(22, 10));
  });

  it('buys the catalogue batch on the catalogue node, immutable', async () => {
    const started = await service.start(TEST_OPERATOR, catalogue());

    assert.equal(manager.requests[0]?.purpose, 'catalogue');
    assert.equal(manager.requests[0]?.nodeId, NODE_CATALOGUE);
    assert.equal(manager.requests[0]?.immutable, true);
    assert.equal(manager.requests[0]?.replacesBatchId, BATCH_CATALOGUE);
    assert.equal(started.purpose, 'catalogue');
  });

  it('buys for a node that has no batch set, replacing none', async () => {
    const inventory = purchaseInventory();
    inventory.stages[0]!.nodes.find((each) => each.nodeId === NODE_RUNG)!.batch = null;
    manager.inventoryValue = inventory;

    await service.start(TEST_OPERATOR, rung({ replacesBatchId: null }));

    assert.equal(manager.requests[0]?.replacesBatchId, null);
  });

  it('refuses, writing nothing and asking nothing, in each way the plan names', async () => {
    const stillPays = purchaseInventory();
    stillPays.stages[0]!.nodes.find((each) => each.nodeId === NODE_RUNG)!.batch = fundingBatch({
      batchId: BATCH_RUNG,
      depth: 22,
      ttlSeconds: 3 * 86_400,
      state: 'active',
    });
    const noOffer = purchaseInventory();
    delete noOffer.stages[0]!.nodes.find((each) => each.nodeId === NODE_RUNG)!.replacement;
    const otherChain = { ...purchaseInventory(), chain: { ...purchaseInventory().chain, chainId: 5 } };
    const shortWallet = purchaseInventory();
    shortWallet.stages[0]!.nodes.find((each) => each.nodeId === NODE_RUNG)!.xbzzPlur = '1';
    const noPrice = { ...purchaseInventory(), chain: { ...purchaseInventory().chain, postage: null } };

    const cases: [
      string,
      BatchPurchaseRequest,
      ReturnType<typeof purchaseInventory> | null,
      string,
      RegExp | string,
    ][] = [
      ['another chain', rung(), otherChain, 'chain', /chain 5/],
      ['a node the manager does not run', rung({ nodeId: 'stage-9:uploader' }), null, 'node', /runs no stage node/],
      ['the catalogue node as a rung', rung({ nodeId: NODE_CATALOGUE }), null, 'node', /bought as the catalogue batch/],
      ['a rung as the catalogue', catalogue({ nodeId: NODE_RUNG }), null, 'node', /not the catalogue node/],
      ['a manager that offers no purchases', rung(), noOffer, 'node', BATCH_PURCHASES_NOT_OFFERED],
      [
        'a gateway, which stamps nothing',
        rung({ nodeId: NODE_B, replacesBatchId: null }),
        null,
        'node',
        /stamps nothing/,
      ],
      [
        'a batch other than the one shown',
        rung({ replacesBatchId: `0x${'aa'.repeat(32)}` }),
        null,
        'batch',
        /changed since/,
      ],
      ['a batch that still pays', rung(), stillPays, 'batch', /still pays/],
      ['a price that moved', rung({ costPlur: '1' }), null, 'price', new RegExp(`now costs ${costOf(22, 10)} PLUR`)],
      ['no price read', rung(), noPrice, 'price', /could not be read/],
      ['a wallet short of the cost', rung(), shortWallet, 'insufficient_funds', /PLUR short/],
      ['a mutable catalogue batch', catalogue({ immutable: false }), null, 'batch', /immutable/],
      ['a shallow catalogue batch', catalogue({ depth: 17, costPlur: costOf(17, 30) }), null, 'batch', /18 to 40/],
      ['a deep rung batch', rung({ depth: 41 }), null, 'batch', /17 to 40/],
      ['a day', rung({ days: 1 }), null, 'batch', /2 days or more/],
    ];
    for (const [what, request, inventory, kind, message] of cases) {
      manager.inventoryValue = inventory ?? purchaseInventory();
      const refused = await refusal(() => service.start(TEST_OPERATOR, request));
      assert.equal(refused.problem, kind, what);
      if (typeof message === 'string') assert.equal(refused.message, message, what);
      else assert.match(refused.message, message, what);
    }
    assert.equal(store.rows.size, 0, 'nothing written');
    assert.deepEqual(manager.requests, [], 'nothing asked of the manager');
    assert.deepEqual(audit.entries, []);
  });

  it('refuses without funding settings, and a catalogue batch while the move is off', async () => {
    const unset = await refusal(() => makeService({ manager: null }).start(TEST_OPERATOR, rung()));
    assert.equal(unset.problem, 'not_set_up');

    move.on = false;
    const off = await refusal(() => service.start(TEST_OPERATOR, catalogue()));
    assert.deepEqual([off.problem, off.message], ['not_set_up', BATCH_PURCHASE_MOVE_OFF]);
    // A rung's batch is bought with the move off.
    await service.start(TEST_OPERATOR, rung());
    assert.equal(manager.requests.length, 1);
  });

  it('answers the manager out of reach when the inventory cannot be read, and buys nothing', async () => {
    manager.inventory = async () => {
      throw new ManagerFundingError('unreachable', null, 'The manager could not be reached.');
    };

    await assert.rejects(service.start(TEST_OPERATOR, rung()), FundingManagerUnavailableError);
    assert.equal(store.rows.size, 0);
  });

  it('runs one purchase on a node at a time', async () => {
    await service.start(TEST_OPERATOR, rung());

    const busy = await refusal(() => service.start(TEST_OPERATOR, rung()));

    assert.equal(busy.problem, 'node');
    assert.match(busy.message, /One runs on a node at a time/);
    assert.equal(manager.requests.length, 1);
    // Another node buys meanwhile.
    await service.start(TEST_OPERATOR, catalogue());
    assert.equal(manager.requests.length, 2);
  });
});

describe('BatchPurchaseService: sending a purchase', () => {
  it('reads a purchase whose answer was lost, and sends it again under the same id only once the manager never received it', async () => {
    manager.sendFailure = new ManagerFundingError('timeout', null, 'The manager did not answer in time.');
    const started = await service.start(TEST_OPERATOR, rung());
    assert.equal(started.state, 'buying');
    assert.ok(store.rows.get(started.id)!.relayedAt, 'marked sent before the answer was lost');

    // The manager has it: it is read, never sent again.
    manager.sendFailure = null;
    managerSays(started, { step: 'buying', batchId: null, state: 'unknown' });
    await read(started.id);
    assert.equal(manager.requests.length, 1, 'read, not sent again');

    // The manager never received it: marked unsent, and the next look sends it again, the same fields.
    manager.statuses.set(started.id, 'unknown_request');
    await read(started.id);
    assert.equal(store.rows.get(started.id)!.relayedAt, null);
    manager.statuses.delete(started.id);
    await read(started.id);
    assert.equal(manager.requests.length, 2);
    assert.deepEqual(manager.requests[1], manager.requests[0]);
  });

  it("fails a purchase the manager refuses, with the manager's sentence, and audits it", async () => {
    manager.sendFailure = new ManagerFundingError(
      'stamp_refused',
      422,
      'The node holds less xBZZ than the batch costs.',
    );

    const started = await service.start(TEST_OPERATOR, rung());

    assert.equal(started.state, 'failed');
    assert.equal(started.error, 'The node holds less xBZZ than the batch costs.');
    assert.equal(started.canCheckAgain, false, 'nothing was bought, so there is nothing to check');
    assert.equal(audit.withAction('funding.purchase.failed').length, 1);
    // The node takes another purchase.
    manager.sendFailure = null;
    await service.start(TEST_OPERATOR, rung());
  });

  it('fails a purchase a manager without the route answers 404, saying it offers none', async () => {
    manager.sendFailure = new ManagerFundingError('bad_answer', 404, 'The manager answered with status 404.');

    const started = await service.start(TEST_OPERATOR, rung());

    assert.deepEqual([started.state, started.error], ['failed', BATCH_PURCHASES_NOT_OFFERED]);
  });

  it("takes the manager's sentence for a purchase it answered failed", async () => {
    const firstId = '00000000-0000-4000-8000-000000000001';
    manager.answerState = 'failed';
    manager.statuses.set(
      firstId,
      purchaseStatus(
        { requestId: firstId, purpose: 'rung', nodeId: NODE_RUNG },
        { state: 'failed', step: 'failed', batchId: null, error: 'The node refused the purchase: out of funds.' },
      ),
    );

    const started = await service.start(TEST_OPERATOR, rung());

    assert.equal(started.id, firstId);
    assert.deepEqual([started.state, started.error], ['failed', 'The node refused the purchase: out of funds.']);
  });
});

describe("BatchPurchaseService: a rung's purchase", () => {
  it("follows the manager's steps: bought, set with its stages restarting, and done", async () => {
    const started = await service.start(TEST_OPERATOR, rung());

    managerSays(started, { step: 'waiting_usable' });
    let purchase = await read(started.id);
    assert.deepEqual([purchase.state, purchase.batchId], ['waiting_usable', BOUGHT]);
    assert.equal(audit.withAction('funding.purchase.bought').length, 1);

    const stages = [{ stageId: FOLLOWING_STAGE, name: 'Main stage', apply: 'waiting_live' as const, message: null }];
    managerSays(started, { step: 'set', usable: true, stages });
    purchase = await read(started.id);
    assert.equal(purchase.state, 'restarting');
    assert.deepEqual(purchase.stages, stages);
    assert.equal(purchase.canCheckAgain, false);

    managerSays(started, { step: 'done', usable: true, stages: [{ ...stages[0]!, apply: 'applied' }] });
    purchase = await read(started.id);
    assert.equal(purchase.state, 'done');
    assert.equal(purchase.stages[0]?.apply, 'applied');
    assert.equal(audit.withAction('funding.purchase.done').length, 1);
    assert.equal(audit.withAction('funding.purchase.bought').length, 1, 'the batch is audited once');
  });

  it('restarts a stage that waits for a broadcast through the manager, and refuses one that does not', async () => {
    const started = await service.start(TEST_OPERATOR, rung());
    const waiting = { stageId: FOLLOWING_STAGE, name: 'Main stage', apply: 'waiting_unknown' as const, message: null };
    managerSays(started, { step: 'set', usable: true, stages: [waiting] });
    await read(started.id);

    const notThere = await refusal(() =>
      service.restart(TEST_OPERATOR, started.id, '11111111-2222-4333-8444-555555555555'),
    );
    assert.equal(notThere.problem, 'batch');

    managerSays(started, { step: 'set', usable: true, stages: [{ ...waiting, apply: 'applying' }] });
    const restarted = await service.restart(TEST_OPERATOR, started.id, FOLLOWING_STAGE);

    assert.deepEqual(manager.restarts, [{ requestId: started.id, stageId: FOLLOWING_STAGE }]);
    assert.equal(restarted?.stages[0]?.apply, 'applying');
    const [entry] = audit.withAction('funding.purchase.restart');
    assert.deepEqual([entry?.details?.stageId, entry?.details?.stageName], [FOLLOWING_STAGE, 'Main stage']);

    const applying = await refusal(() => service.restart(TEST_OPERATOR, started.id, FOLLOWING_STAGE));
    assert.match(applying.message, /does not wait for a broadcast/);
    assert.equal(manager.restarts.length, 1);
  });

  it("carries the manager's refusal of a restart as the admin's", async () => {
    const started = await service.start(TEST_OPERATOR, rung());
    managerSays(started, {
      step: 'set',
      usable: true,
      stages: [{ stageId: FOLLOWING_STAGE, name: 'Main stage', apply: 'waiting_live', message: null }],
    });
    await read(started.id);
    manager.callFailure = new ManagerFundingError('stamp_refused', 422, 'The stage is applying already.');

    const refused = await refusal(() => service.restart(TEST_OPERATOR, started.id, FOLLOWING_STAGE));

    assert.equal(refused.message, 'The manager refused it: The stage is applying already.');
    assert.equal(audit.withAction('funding.purchase.restart').length, 0);
  });

  it('answers null for a read, a restart or a check of a purchase never written', async () => {
    const never = '99999999-0000-4000-8000-000000000000';
    assert.equal(await service.restart(TEST_OPERATOR, never, FOLLOWING_STAGE), null);
    assert.equal(await service.check(TEST_OPERATOR, never), null);
    assert.equal(await service.get(never), null);
  });

  it('checks again a purchase that failed after its batch was bought, buying nothing a second time', async () => {
    const started = await service.start(TEST_OPERATOR, rung());
    managerSays(started, { step: 'failed', usable: false, error: 'The batch was not usable within an hour.' });
    let purchase = await read(started.id);
    assert.deepEqual([purchase.state, purchase.batchId, purchase.canCheckAgain], ['failed', BOUGHT, true]);

    managerSays(started, { step: 'waiting_usable' });
    purchase = (await service.check(TEST_OPERATOR, started.id))!;

    assert.deepEqual(manager.checks, [started.id]);
    assert.equal(manager.requests.length, 1, 'bought once');
    assert.deepEqual([purchase.state, purchase.error], ['waiting_usable', null]);
    assert.equal(store.rows.get(started.id)!.finishedAt, null, 'under way again');
    assert.equal(audit.withAction('funding.purchase.check').length, 1);
  });

  it('checks again a stage whose restart failed', async () => {
    const started = await service.start(TEST_OPERATOR, rung());
    const failed = { stageId: FOLLOWING_STAGE, name: 'Main stage', apply: 'failed' as const, message: 'No Docker.' };
    managerSays(started, { step: 'set', usable: true, stages: [failed] });
    assert.equal((await read(started.id)).canCheckAgain, true);

    managerSays(started, { step: 'set', usable: true, stages: [{ ...failed, apply: 'pending', message: null }] });
    const checked = await service.check(TEST_OPERATOR, started.id);

    assert.deepEqual(manager.checks, [started.id]);
    assert.equal(checked?.stages[0]?.apply, 'pending');
    assert.equal(checked?.canCheckAgain, false);
  });

  it('refuses a check when nothing stopped, and one that would run beside another purchase on the node', async () => {
    const started = await service.start(TEST_OPERATOR, rung());
    const nothing = await refusal(() => service.check(TEST_OPERATOR, started.id));
    assert.match(nothing.message, /nothing to check again/);

    managerSays(started, { step: 'failed', error: 'The batch was not usable within an hour.' });
    await read(started.id);
    const other = await service.start(TEST_OPERATOR, rung());
    managerSays(started, { step: 'waiting_usable' });
    const busy = await refusal(() => service.check(TEST_OPERATOR, started.id));
    assert.equal(busy.problem, 'node');
    assert.equal(store.rows.get(started.id)!.state, 'failed');
    assert.equal(store.rows.get(other.id)!.state, 'buying');
  });
});

describe("BatchPurchaseService: the catalogue's purchase", () => {
  it('moves the catalogue onto the designated batch through the port, then releases the batch it moved from', async () => {
    const started = await service.start(TEST_OPERATOR, catalogue());
    managerSays(started, {
      step: 'set',
      usable: true,
      catalogue: { previousBatchId: BATCH_CATALOGUE, released: false },
    });

    let purchase = await read(started.id);
    assert.equal(purchase.state, 'moving');
    assert.deepEqual(move.calls, [{ targetBatchId: BOUGHT.slice(2), purchaseId: started.id, retryFailed: false }]);
    assert.deepEqual(purchase.move, { ...move.reading, released: false });
    assert.deepEqual(manager.releases, [], 'nothing released while the move runs');

    const cleared = [{ streamId: 'stream-1', title: 'Opening night' }];
    move.reading = { state: 'done', slotsDone: 12, slotsTotal: 12, message: null, clearedThumbnails: cleared };
    purchase = await read(started.id);

    assert.deepEqual(manager.releases, [started.id]);
    assert.equal(purchase.state, 'done');
    assert.equal(purchase.move?.released, true);
    assert.deepEqual(purchase.move?.clearedThumbnails, cleared);
    assert.equal(audit.withAction('funding.purchase.release').length, 1);
    assert.equal(audit.withAction('funding.purchase.done').length, 1);
  });

  it('releases nothing for a catalogue node that had no batch designated', async () => {
    const started = await service.start(TEST_OPERATOR, catalogue());
    move.reading = { state: 'done', slotsDone: 0, slotsTotal: 0, message: null, clearedThumbnails: [] };
    managerSays(started, { step: 'done', usable: true, catalogue: { previousBatchId: null, released: false } });

    const purchase = await read(started.id);

    assert.equal(purchase.state, 'done');
    assert.deepEqual(manager.releases, []);
    assert.equal(purchase.move?.released, false);
  });

  it('keeps the purchase moving until the move is done, even once the manager calls its own part done', async () => {
    const started = await service.start(TEST_OPERATOR, catalogue());
    managerSays(started, { step: 'done', usable: true, catalogue: { previousBatchId: null, released: false } });

    assert.equal((await read(started.id)).state, 'moving');
  });

  it('asks for the release again at the next look when it did not go through', async () => {
    const started = await service.start(TEST_OPERATOR, catalogue());
    move.reading = { state: 'done', slotsDone: 4, slotsTotal: 4, message: null, clearedThumbnails: [] };
    managerSays(started, {
      step: 'set',
      usable: true,
      catalogue: { previousBatchId: BATCH_CATALOGUE, released: false },
    });
    manager.callFailure = new ManagerFundingError('unreachable', null, 'The manager could not be reached.');

    assert.equal((await read(started.id)).state, 'moving');
    manager.callFailure = null;
    assert.equal((await read(started.id)).state, 'done');
    assert.equal(manager.releases.length, 2);
  });

  it('starts a failed move again on a check, from where it stopped, without asking the manager to check', async () => {
    const started = await service.start(TEST_OPERATOR, catalogue());
    move.reading = {
      state: 'failed',
      slotsDone: 5,
      slotsTotal: 12,
      message: 'The node could not be reached.',
      clearedThumbnails: [],
    };
    managerSays(started, {
      step: 'set',
      usable: true,
      catalogue: { previousBatchId: BATCH_CATALOGUE, released: false },
    });
    assert.equal((await read(started.id)).canCheckAgain, true);

    move.reading = { state: 'running', slotsDone: 5, slotsTotal: 12, message: null, clearedThumbnails: [] };
    const checked = await service.check(TEST_OPERATOR, started.id);

    assert.equal(move.calls.at(-1)?.retryFailed, true);
    assert.deepEqual(manager.checks, []);
    assert.equal(checked?.move?.state, 'running');
    assert.equal(checked?.canCheckAgain, false);
  });
});

describe('BatchPurchaseService: the list and the background reads', () => {
  it('lists the purchases under way and those that ended in the last day, the latest first, with 0x batch ids', async () => {
    const first = await service.start(TEST_OPERATOR, rung());
    managerSays(first, { step: 'done', usable: true });
    await read(first.id);
    const second = await service.start(TEST_OPERATOR, catalogue());

    let listed = await service.list();
    assert.deepEqual(
      listed.purchases.map((purchase) => purchase.id),
      [second.id, first.id],
    );
    assert.equal(listed.purchases[1]?.batchId, BOUGHT);

    clock = START + 3 * 86_400_000;
    listed = await service.list();
    assert.deepEqual(
      listed.purchases.map((purchase) => purchase.id),
      [second.id],
      'the one that ended is off the list after a day; the one under way stays',
    );
  });

  it('reads the purchases under way in the background once booted, and stops on shutdown', async () => {
    const polled = makeService({ pollMs: 20 });
    const started = await polled.start(TEST_OPERATOR, rung());
    managerSays(started, { step: 'waiting_usable' });

    polled.boot();
    const deadline = Date.now() + 2_000;
    while (store.rows.get(started.id)!.state !== 'waiting_usable' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await polled.shutdown();

    assert.equal(store.rows.get(started.id)!.state, 'waiting_usable');
  });
});
