/**
 * The stamp operations of the Funding page against fakes: the manager journals what it is relayed and runs each
 * operation once per request id, and the journals and the pins are in memory. `pnpm test`.
 *
 * Pinned here: the amount per chunk and the cost of a top-up at the price the manager reads now, to the PLUR, its
 * blocks rounded up; a dilution's new depth and its 7 days; every refusal and its problem, nothing journalled; the
 * funds counted per wallet, xDAI for the gas of either kind; a request answered at once, every item journalled
 * `queued`, then relayed in turn behind it, a refusal failing its item alone, and a node asked for one operation at a
 * time; a refresh that relays again only an item the manager never received, the same fields under the same request
 * id, and never one it answered for; one stamp bulk at a time, apart from sends; a read that shares the relays under
 * way; the view's open stamp bulk; the settled and watched flags; and the audit rows of a request and of each outcome.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { FundingInventory, FundingStampOperationRequest } from '@streaming-monorepo/contracts';
import type { FundingStampOperationsAnswer, StampOperationItemRequest } from '@streaming-monorepo/web2-admin-common';

import {
  FundingBulkNotFoundError,
  FundingBusyError,
  FundingManagerUnavailableError,
  FundingRefusedError,
  RequestShapeError,
} from '../../src/domain/errors/index.js';
import { FUNDING_SYSTEM, FundingService } from '../../src/domain/funding/FundingService.js';
import { FundingStampService, toFundingStampItem } from '../../src/domain/funding/FundingStampService.js';

import { InMemoryAuditLog, TEST_OPERATOR } from './support/fakes.js';
import {
  BATCH_CATALOGUE,
  BATCH_RUNG,
  BATCH_STAGE,
  BZZ_TOKEN,
  DAY,
  FakeFundingManager,
  FakeFundingWallet,
  fundingBatch,
  InMemoryFundingPinStore,
  InMemoryFundingStampStore,
  InMemoryFundingTransferStore,
  managerFailure,
  NODE_A,
  NODE_B,
  NODE_CATALOGUE,
  NODE_RUNG,
  POSTAGE,
  stampInventory,
  stampTxHash,
  WALLET_A,
} from './support/fundingFakes.js';

let manager: FakeFundingManager;
let journal: InMemoryFundingStampStore;
let transfers: InMemoryFundingTransferStore;
let pins: InMemoryFundingPinStore;
let wallet: FakeFundingWallet;
let audit: InMemoryAuditLog;
let stamps: FundingStampService;
let funding: FundingService;
/** The services' clock, which a test moves by hand. */
const clock = { now: 0 };

const THIRTY_MINUTES = 30 * 60 * 1000;

/** Builds both services over the same fakes: the stamp service, and the Funding page's service that answers with it. */
function build(over: { manager?: FakeFundingManager | null; waitMs?: number } = {}): void {
  const builtManager = over.manager === undefined ? manager : over.manager;
  stamps = new FundingStampService({
    manager: builtManager,
    journal,
    audit,
    now: () => clock.now,
    ...(over.waitMs === undefined ? {} : { waitMs: over.waitMs }),
  });
  funding = new FundingService({
    wallet,
    manager: builtManager,
    transfers,
    pins,
    stamps,
    audit,
    now: () => clock.now,
  });
}

beforeEach(() => {
  clock.now = Date.parse('2026-10-08T12:00:00.000Z');
  manager = new FakeFundingManager();
  manager.inventoryAnswer = stampInventory();
  journal = new InMemoryFundingStampStore();
  transfers = new InMemoryFundingTransferStore();
  pins = new InMemoryFundingPinStore();
  wallet = new FakeFundingWallet();
  audit = new InMemoryAuditLog();
  build();
});

/** A top-up, quoted by the page at the test's price of postage unless another is given. */
const topUp = (
  nodeId: string,
  batchId: string,
  expectedDepth: number,
  days: number,
  pricePerChunkPerBlockPlur = POSTAGE.pricePerChunkPerBlockPlur,
): StampOperationItemRequest => ({
  kind: 'topup',
  nodeId,
  batchId,
  expectedDepth,
  days,
  pricePerChunkPerBlockPlur,
});

/** The stamp inventory with postage at this price per chunk per block. */
function pricedAt(pricePerChunkPerBlockPlur: string): FundingInventory {
  const inventory = stampInventory();
  inventory.chain.postage = { ...POSTAGE, pricePerChunkPerBlockPlur };
  return inventory;
}

const dilute = (nodeId: string, batchId: string, expectedDepth: number, steps: 1 | 2): StampOperationItemRequest => ({
  kind: 'dilute',
  nodeId,
  batchId,
  expectedDepth,
  steps,
});

/** The stage's own batch for 30 days, and the catalogue's for 7: the two top-ups most tests ask for. */
const TWO_TOP_UPS = [topUp(NODE_A, BATCH_STAGE, 20, 30), topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7)];

/** A top-up of `days` at the test's price, 24000 PLUR a chunk a block and 5-second blocks: 17280 blocks a day. */
const amountFor = (days: number) => BigInt(days) * 17_280n * 24_000n;

/** The items of a bulk as the console reads them now, from the journal, asking the manager nothing. */
async function itemsOf(bulkId: string) {
  return (await journal.listBulk(bulkId)).map((row) => toFundingStampItem(row, clock.now));
}

/** Asks for `items` as the operator, lets the relays behind the request end, and answers the items as they stand. */
async function requested(items: StampOperationItemRequest[]): Promise<FundingStampOperationsAnswer> {
  const answer = await funding.stampOperations(TEST_OPERATOR, items);
  await stamps.idle();
  return { bulkId: answer.bulkId, items: await itemsOf(answer.bulkId) };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a refusal');
}

/** The inventory with one node changed, by its id, in the stage or as the catalogue node. */
function withNode(nodeId: string, change: (node: FundingInventory['stages'][number]['nodes'][number]) => void) {
  const inventory = stampInventory();
  for (const node of [...inventory.stages.flatMap((stage) => stage.nodes), inventory.catalogue]) {
    if (node?.nodeId === nodeId) change(node);
  }
  return inventory;
}

/** The stage's own node is the catalogue node as well: one node, one wallet, listed for two batches. */
function oneNodeTwoBatches(): FundingInventory {
  const inventory = stampInventory();
  inventory.catalogue = {
    ...inventory.stages[0]!.nodes[0]!,
    label: 'Main stage catalogue node',
    batch: fundingBatch({ batchId: BATCH_CATALOGUE, depth: 18, ttlSeconds: 40 * DAY }),
  };
  return inventory;
}

describe('a request, answered at once', () => {
  it('answers the bulk id and every item queued before the manager has answered any', async () => {
    let release!: () => void;
    manager.stampGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const answer = await funding.stampOperations(TEST_OPERATOR, TWO_TOP_UPS);

    assert.match(answer.bulkId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      answer.items.map((item) => Object.keys(item).sort()),
      [0, 1].map(() => [
        'batchId',
        'costPlur',
        'days',
        'error',
        'kind',
        'nodeId',
        'nodeLabel',
        'requestId',
        'settled',
        'state',
        'steps',
        'txHash',
        'watched',
      ]),
    );
    const [first, second] = answer.items;
    assert.deepEqual(first, {
      requestId: first?.requestId,
      kind: 'topup',
      nodeId: NODE_A,
      nodeLabel: 'Main stage uploader',
      batchId: BATCH_STAGE,
      days: 30,
      steps: null,
      costPlur: (amountFor(30) * 2n ** 20n).toString(),
      state: 'queued',
      txHash: null,
      error: null,
      settled: false,
      watched: false,
    });
    assert.deepEqual([second?.nodeLabel, second?.days, second?.state], ['Catalogue node', 7, 'queued']);

    release();
    await stamps.idle();
    assert.deepEqual(
      (await itemsOf(answer.bulkId)).map((item) => [item.state, item.txHash, item.settled, item.watched]),
      [
        ['confirmed', stampTxHash(first?.requestId ?? ''), true, false],
        ['confirmed', stampTxHash(second?.requestId ?? ''), true, false],
      ],
    );
  });

  it('journals every item before relaying any, then relays them in turn', async () => {
    const seen: string[] = [];
    manager.onStampOperation = (operation) => {
      // At the moment of each relay, every item of the request is journalled, this one queued with these fields.
      assert.equal(journal.rows.size, 2);
      const row = journal.get(operation.requestId);
      assert.ok(row, 'the item is journalled before it is relayed');
      assert.equal(row.state, 'queued');
      assert.equal(row.amountPerChunkPlur, operation.kind === 'topup' ? operation.amountPerChunkPlur : null);
      seen.push(operation.requestId);
    };

    const answer = await requested(TWO_TOP_UPS);

    assert.deepEqual(
      seen,
      answer.items.map((item) => item.requestId),
    );
  });
});

describe('a top-up, priced at the price the manager reads now', () => {
  it('relays each with its amount per chunk, and journals its cost, to the PLUR', async () => {
    const answer = await requested(TWO_TOP_UPS);

    const [stage, catalogue] = await journal.listBulk(answer.bulkId);
    assert.deepEqual(
      [stage?.amountPerChunkPlur, stage?.costPlur],
      [amountFor(30).toString(), (amountFor(30) * 2n ** 20n).toString()],
    );
    assert.equal(stage?.costPlur, '13045963161600000');
    assert.deepEqual(
      [catalogue?.amountPerChunkPlur, catalogue?.costPlur],
      [amountFor(7).toString(), (amountFor(7) * 2n ** 18n).toString()],
    );
    assert.deepEqual(manager.stampOperations, [
      {
        requestId: stage?.requestId,
        kind: 'topup',
        nodeId: NODE_A,
        batchId: BATCH_STAGE,
        expectedDepth: 20,
        amountPerChunkPlur: amountFor(30).toString(),
      },
      {
        requestId: catalogue?.requestId,
        kind: 'topup',
        nodeId: NODE_CATALOGUE,
        batchId: BATCH_CATALOGUE,
        expectedDepth: 18,
        amountPerChunkPlur: amountFor(7).toString(),
      },
    ]);
  });

  it('prices each request at the price the manager reads for it, not one read before', async () => {
    await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    manager.inventoryAnswer = pricedAt('12000');

    // The page still quotes the price it read before, 24000: postage has become cheaper since.
    await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);

    assert.deepEqual(
      manager.stampOperations.map((operation) => (operation.kind === 'topup' ? operation.amountPerChunkPlur : null)),
      [amountFor(30).toString(), (amountFor(30) / 2n).toString()],
    );
  });

  it('is refused, nothing journalled, when postage costs more now than the price the page quoted it at', async () => {
    manager.inventoryAnswer = pricedAt('24001');

    const error = await refusal(funding.stampOperations(TEST_OPERATOR, TWO_TOP_UPS));

    assert.ok(error instanceof FundingRefusedError, String(error));
    assert.equal(error.problem, 'price');
    assert.equal(
      error.message,
      'The price of postage has risen since the page read it. Read the page again. Nothing was sent.',
    );
    assert.equal(journal.rows.size, 0, 'nothing was journalled');
    assert.equal(manager.stampCalls.operation, 0, 'nothing was relayed');
    assert.equal(audit.withAction('funding.stamp.request').length, 0);
  });

  it('goes ahead at the price the page quoted, or at a lower one, priced at the price of now', async () => {
    // Postage costs 24000 now: the page quoted that for one top-up, and a higher price for the other.
    await requested([
      topUp(NODE_A, BATCH_STAGE, 20, 30, '24000'),
      topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7, '30000'),
    ]);

    assert.deepEqual(
      manager.stampOperations.map((operation) => (operation.kind === 'topup' ? operation.amountPerChunkPlur : null)),
      [amountFor(30).toString(), amountFor(7).toString()],
    );
    const costOf = (batchId: string) => [...journal.rows.values()].find((row) => row.batchId === batchId)?.costPlur;
    assert.equal(costOf(BATCH_STAGE), (amountFor(30) * 2n ** 20n).toString());
    assert.equal(costOf(BATCH_CATALOGUE), (amountFor(7) * 2n ** 18n).toString());
  });

  it('rounds the days up to whole blocks, so a top-up never buys less than its days', async () => {
    const inventory = stampInventory();
    inventory.chain.postage = { ...POSTAGE, blockSeconds: 7 };
    manager.inventoryAnswer = inventory;

    await requested([topUp(NODE_A, BATCH_STAGE, 20, 1)]);

    // 86400 / 7 is 12342.86 blocks: 12343 of them.
    const [operation] = manager.stampOperations;
    assert.equal(operation?.kind === 'topup' ? operation.amountPerChunkPlur : null, (12_343n * 24_000n).toString());
  });

  it('takes a batch id in upper case for the one the inventory keeps in lower case', async () => {
    const shouted = `0x${BATCH_STAGE.slice(2).toUpperCase()}`;

    const answer = await requested([topUp(NODE_A, shouted, 20, 30)]);

    assert.equal(answer.items[0]?.batchId, BATCH_STAGE);
    assert.equal(manager.stampOperations[0]?.batchId, BATCH_STAGE);
  });
});

describe('a dilution', () => {
  it('journals its new depth and relays it, with no amount and no cost', async () => {
    const answer = await requested([
      dilute(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 2),
      dilute(NODE_RUNG, BATCH_RUNG, 22, 1),
    ]);

    assert.deepEqual(
      manager.stampOperations.map(({ requestId: _id, ...rest }) => rest),
      [
        { kind: 'dilute', nodeId: NODE_CATALOGUE, batchId: BATCH_CATALOGUE, expectedDepth: 18, newDepth: 20 },
        { kind: 'dilute', nodeId: NODE_RUNG, batchId: BATCH_RUNG, expectedDepth: 22, newDepth: 23 },
      ],
    );
    assert.deepEqual(
      answer.items.map((item) => [item.kind, item.days, item.steps, item.costPlur, item.state]),
      [
        ['dilute', null, 2, null, 'confirmed'],
        ['dilute', null, 1, null, 'confirmed'],
      ],
    );
    const rows = await journal.listBulk(answer.bulkId);
    assert.deepEqual(
      rows.map((row) => [row.expectedDepth, row.newDepth, row.amountPerChunkPlur]),
      [
        [18, 20, null],
        [22, 23, null],
      ],
    );
  });

  it('is refused when it would leave the batch under 7 days, and taken at 7 days exactly', async () => {
    const short = await refusal(funding.stampOperations(TEST_OPERATOR, [dilute(NODE_A, BATCH_STAGE, 20, 1)]));
    assert.ok(short instanceof FundingRefusedError);
    assert.equal(short.problem, 'batch');
    assert.equal(
      short.message,
      'The batch of Main stage uploader (stage-1:uploader) cannot be diluted 1 step: It would leave the batch under 7 days. Nothing was sent.',
    );

    manager.inventoryAnswer = withNode(NODE_A, (node) => {
      node.batch = fundingBatch({ ttlSeconds: 14 * DAY - 2 });
    });
    const second = await refusal(funding.stampOperations(TEST_OPERATOR, [dilute(NODE_A, BATCH_STAGE, 20, 1)]));
    assert.ok(second instanceof FundingRefusedError, 'a second under 7 days after it');

    manager.inventoryAnswer = withNode(NODE_A, (node) => {
      node.batch = fundingBatch({ ttlSeconds: 28 * DAY });
    });
    const answer = await requested([dilute(NODE_A, BATCH_STAGE, 20, 2)]);
    assert.equal(answer.items[0]?.state, 'confirmed');
    assert.equal(journal.rows.size, 1);
  });

  it('needs no price of postage', async () => {
    const inventory = stampInventory();
    inventory.chain.postage = null;
    manager.inventoryAnswer = inventory;

    const answer = await requested([dilute(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 1)]);

    assert.equal(answer.items[0]?.state, 'confirmed');
  });
});

describe('refusing a request, nothing journalled', () => {
  async function refused(items: StampOperationItemRequest[]): Promise<FundingRefusedError> {
    const error = await refusal(funding.stampOperations(TEST_OPERATOR, items));
    assert.ok(error instanceof FundingRefusedError, String(error));
    assert.equal(journal.rows.size, 0, 'nothing was journalled');
    assert.equal(manager.stampCalls.operation, 0, 'nothing was relayed');
    return error;
  }

  it('refuses a request of both kinds, or one that names a batch twice, before it asks the manager anything', async () => {
    const mixed = await refusal(
      funding.stampOperations(TEST_OPERATOR, [
        topUp(NODE_A, BATCH_STAGE, 20, 30),
        dilute(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 1),
      ]),
    );
    assert.ok(mixed instanceof RequestShapeError);
    assert.deepEqual(mixed.problems, ['A request takes one kind of operation: top-ups or dilutions, not both.']);

    const twice = await refusal(
      funding.stampOperations(TEST_OPERATOR, [
        topUp(NODE_A, BATCH_STAGE, 20, 30),
        topUp(NODE_A, `0x${BATCH_STAGE.slice(2).toUpperCase()}`, 20, 7),
      ]),
    );
    assert.ok(twice instanceof RequestShapeError);
    assert.match(twice.problems[0] ?? '', /is named twice: a request takes one operation on a batch/);
    assert.equal(manager.calls.inventory, 0);
  });

  it('refuses while funding is not set up', async () => {
    build({ manager: null });
    const error = await refused([topUp(NODE_A, BATCH_STAGE, 20, 30)]);

    assert.equal(error.problem, 'not_set_up');
  });

  it('refuses a manager on another chain', async () => {
    const inventory = stampInventory();
    inventory.chain = { chainId: 1, bzzToken: BZZ_TOKEN, postage: POSTAGE };
    manager.inventoryAnswer = inventory;

    const error = await refused([topUp(NODE_A, BATCH_STAGE, 20, 30)]);

    assert.equal(error.problem, 'chain');
  });

  it('answers a manager it cannot read with a sentence of its own', async () => {
    manager.inventoryError = managerFailure('timeout', null, 'GET http://manager.example/ timed out');

    const error = await refusal(funding.stampOperations(TEST_OPERATOR, [topUp(NODE_A, BATCH_STAGE, 20, 30)]));

    assert.ok(error instanceof FundingManagerUnavailableError);
    assert.equal(error.message, 'The manager could not be reached. Nothing was sent.');
    assert.equal(journal.rows.size, 0);
  });

  it('refuses a node the manager does not hold', async () => {
    const error = await refused([topUp('stage-9:gone', BATCH_STAGE, 20, 30)]);

    assert.equal(error.problem, 'node');
    assert.equal(error.message, 'The manager has no node stage-9:gone, so nothing was sent.');
  });

  it('refuses a batch its node does not upload with, and a node that uploads with none', async () => {
    const other = await refused([topUp(NODE_A, BATCH_CATALOGUE, 18, 30)]);
    assert.equal(other.problem, 'batch');
    assert.equal(
      other.message,
      'Batch 0xc2c2c2c2… is not a batch Main stage uploader (stage-1:uploader) uploads with, so nothing was sent.',
    );

    const gateway = await refused([topUp(NODE_B, BATCH_STAGE, 20, 30)]);
    assert.equal(gateway.problem, 'batch');
  });

  it('refuses a batch that could not be read, is not usable, or has expired, saying which', async () => {
    const cases = [
      {
        batch: {
          ...fundingBatch(),
          depth: null,
          immutable: null,
          usable: null,
          ttlSeconds: null,
          fillRatio: null,
          readError: 'The node did not answer about the batch.',
        },
        sentence:
          'The batch of Main stage uploader (stage-1:uploader) could not be read, so nothing was sent. The node did not answer about the batch.',
      },
      {
        batch: fundingBatch({ usable: false }),
        sentence: 'Bee does not call the batch of Main stage uploader (stage-1:uploader) usable, so nothing was sent.',
      },
      {
        batch: fundingBatch({ ttlSeconds: 0 }),
        sentence:
          'The batch of Main stage uploader (stage-1:uploader) has expired, and an expired batch can be neither topped up nor diluted. Nothing was sent.',
      },
    ];
    for (const { batch, sentence } of cases) {
      manager.inventoryAnswer = withNode(NODE_A, (node) => {
        node.batch = batch;
      });
      const error = await refused([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
      assert.equal(error.problem, 'batch');
      assert.equal(error.message, sentence);
    }
  });

  it('refuses a batch no longer at the depth the page showed', async () => {
    const error = await refused([topUp(NODE_A, BATCH_STAGE, 19, 30)]);

    assert.equal(error.problem, 'batch');
    assert.equal(
      error.message,
      'The batch of Main stage uploader (stage-1:uploader) is at depth 20 now, not the 19 the page showed: read the page again. Nothing was sent.',
    );
  });

  it('refuses a top-up when the manager read no price of postage', async () => {
    const inventory = stampInventory();
    inventory.chain.postage = null;
    manager.inventoryAnswer = inventory;

    const error = await refused([topUp(NODE_A, BATCH_STAGE, 20, 30)]);

    assert.equal(error.problem, 'price');
  });

  it('refuses a node whose wallet could not be read', async () => {
    manager.inventoryAnswer = withNode(NODE_CATALOGUE, (node) => {
      node.walletAddress = null;
      node.xdaiWei = null;
      node.xbzzPlur = null;
      node.readError = 'The node did not answer.';
    });

    const error = await refused([dilute(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 1)]);

    assert.equal(error.problem, 'node');
    assert.match(error.message, /The wallet of Catalogue node \(catalogue:uploader\) could not be read/);
  });

  it('refuses a node with no xDAI for the gas, for a top-up and for a dilution alike', async () => {
    manager.inventoryAnswer = withNode(NODE_CATALOGUE, (node) => {
      node.xdaiWei = '0';
    });

    for (const item of [
      topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7),
      dilute(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 1),
    ]) {
      const error = await refused([item]);
      assert.equal(error.problem, 'insufficient_funds');
      assert.equal(
        error.message,
        'The nodes cannot pay for this: Catalogue node (catalogue:uploader) holds no xDAI to pay the gas. Nothing was sent.',
      );
    }
  });

  it('takes top-ups that fit the wallet to the PLUR, and refuses them one PLUR short, naming the shortfall', async () => {
    const cost = amountFor(30) * 2n ** 20n;
    manager.inventoryAnswer = withNode(NODE_A, (node) => {
      node.xbzzPlur = (cost - 1n).toString();
    });

    const error = await refused([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    assert.equal(error.problem, 'insufficient_funds');
    assert.equal(
      error.message,
      'The nodes cannot pay for this: Main stage uploader (stage-1:uploader) is 0.0000000000000001 xBZZ short: its top-ups cost 1.30459631616 xBZZ, and its wallet holds 1.3045963161599999. Nothing was sent.',
    );

    manager.inventoryAnswer = withNode(NODE_A, (node) => {
      node.xbzzPlur = cost.toString();
    });
    const answer = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    assert.equal(answer.items[0]?.state, 'confirmed');
  });

  it('counts the top-ups of one wallet together, when a node is listed for two batches', async () => {
    const both = amountFor(30) * 2n ** 20n + amountFor(7) * 2n ** 18n;
    const inventory = oneNodeTwoBatches();
    inventory.stages[0]!.nodes[0]!.xbzzPlur = (both - 1n).toString();
    manager.inventoryAnswer = inventory;
    const items = [topUp(NODE_A, BATCH_STAGE, 20, 30), topUp(NODE_A, BATCH_CATALOGUE, 18, 7)];

    const error = await refused(items);
    assert.match(
      error.message,
      /^The nodes cannot pay for this: Main stage uploader \(stage-1:uploader\) and Main stage catalogue node \(stage-1:uploader\) is 0\.0000000000000001 xBZZ short/,
    );

    inventory.stages[0]!.nodes[0]!.xbzzPlur = both.toString();
    inventory.catalogue!.xbzzPlur = both.toString();
    const answer = await requested(items);
    assert.deepEqual(
      answer.items.map((item) => [item.nodeLabel, item.batchId, item.state]),
      [
        ['Main stage uploader', BATCH_STAGE, 'confirmed'],
        ['Main stage catalogue node', BATCH_CATALOGUE, 'confirmed'],
      ],
    );
  });
});

describe('relaying the items in turn', () => {
  it('fails an item the manager refuses, or whose node it could not reach, with its sentence, and relays the next', async () => {
    manager.stampErrors.set(0, managerFailure('stamp_refused', 422, 'The batch is not usable on the node.'));
    manager.stampErrors.set(1, managerFailure('node_unreachable', 502, "The node's Bee API did not answer."));
    const answer = await requested([...TWO_TOP_UPS, topUp(NODE_RUNG, BATCH_RUNG, 22, 7)]);

    assert.deepEqual(
      answer.items.map((item) => [item.state, item.error, item.settled, item.watched]),
      [
        ['failed', 'The manager refused it: The batch is not usable on the node.', true, false],
        ['failed', "The manager could not reach the node: The node's Bee API did not answer.", true, false],
        ['confirmed', null, true, false],
      ],
    );
    assert.equal(manager.stampCalls.operation, 3);
  });

  it("takes the manager's sentence for an item the node refused, which its answer does not carry", async () => {
    manager.stampState = 'failed';
    const answer = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);

    assert.deepEqual(
      answer.items.map((item) => [item.state, item.error, item.settled, item.watched]),
      [['failed', 'The node refused it: its wallet holds too little xBZZ.', true, false]],
    );
    assert.equal(manager.stampCalls.status, 1);
  });

  it('says so in its own sentence when the reason cannot be read', async () => {
    manager.stampState = 'failed';
    manager.stampStatusError = managerFailure('unreachable', null);

    const answer = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);

    assert.equal(answer.items[0]?.error, 'The manager reports that it failed, without a reason the admin could read.');
  });

  it('leaves an item queued, and the ones after it unrelayed, when the manager cannot be reached', async () => {
    manager.stampErrors.set(0, managerFailure('unreachable', null));
    const answer = await requested(TWO_TOP_UPS);

    assert.deepEqual(
      answer.items.map((item) => [item.state, item.settled]),
      [
        ['queued', false],
        ['queued', false],
      ],
    );
    assert.equal(manager.stampCalls.operation, 1);
  });

  it('records a hash the manager answers, and keeps it', async () => {
    manager.stampState = 'unknown';
    const answer = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    const requestId = answer.items[0]!.requestId;
    assert.equal(answer.items[0]?.txHash, null);

    manager.stampStatusAnswers.set(requestId, { state: 'unknown', txHash: stampTxHash(requestId) });
    assert.equal((await funding.stampBulk(answer.bulkId)).items[0]?.txHash, stampTxHash(requestId));

    manager.stampStatusAnswers.set(requestId, { state: 'confirmed', txHash: null });
    const settled = await funding.stampBulk(answer.bulkId);
    assert.deepEqual(
      settled.items.map((item) => [item.state, item.txHash]),
      [['confirmed', stampTxHash(requestId)]],
    );
  });

  it('audits an operation the manager confirmed from the chain with no hash, as it has none', async () => {
    manager.stampState = 'unknown';
    const answer = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    manager.stampStatusAnswers.set(answer.items[0]!.requestId, { state: 'confirmed', txHash: null });

    const settled = await funding.stampBulk(answer.bulkId);

    assert.deepEqual(
      settled.items.map((item) => [item.state, item.txHash]),
      [['confirmed', null]],
    );
    const [confirmed] = audit.withAction('funding.stamp.confirmed');
    assert.equal(confirmed?.details?.txHash, null);
  });
});

describe('a node asked for one operation at a time', () => {
  it("holds the next item for a node while the one before it is not known, and relays the other nodes' items", async () => {
    manager.inventoryAnswer = oneNodeTwoBatches();
    manager.stampStateOf = (operation) => (operation.batchId === BATCH_STAGE ? 'unknown' : 'confirmed');

    const answer = await requested([
      topUp(NODE_A, BATCH_STAGE, 20, 30),
      topUp(NODE_A, BATCH_CATALOGUE, 18, 7),
      topUp(NODE_RUNG, BATCH_RUNG, 22, 7),
    ]);

    assert.deepEqual(
      answer.items.map((item) => [item.batchId, item.state, item.settled]),
      [
        [BATCH_STAGE, 'unknown', false],
        [BATCH_CATALOGUE, 'queued', false],
        [BATCH_RUNG, 'confirmed', true],
      ],
    );
    assert.deepEqual(
      manager.stampOperations.map((operation) => operation.batchId),
      [BATCH_STAGE, BATCH_RUNG],
    );

    // A refresh reads the first again, and leaves the one waiting on it alone: not read, not relayed.
    const statusReads = manager.stampStatusReads.length;
    await funding.stampBulk(answer.bulkId);
    assert.deepEqual(manager.stampStatusReads.slice(statusReads), [answer.items[0]?.requestId]);
    assert.equal(manager.stampCalls.operation, 2);

    // Once the manager settled the first, the next refresh relays the one that waited.
    manager.stampStatusAnswers.set(answer.items[0]!.requestId, { state: 'confirmed', txHash: null });
    const after = await funding.stampBulk(answer.bulkId);
    assert.deepEqual(
      after.items.map((item) => item.state),
      ['confirmed', 'confirmed', 'confirmed'],
    );
    assert.deepEqual(
      manager.stampOperations.map((operation) => operation.batchId),
      [BATCH_STAGE, BATCH_RUNG, BATCH_CATALOGUE],
    );
  });

  it("relays the next item for a node once the one before it is unknown for longer than the manager's 30 minutes", async () => {
    manager.inventoryAnswer = oneNodeTwoBatches();
    manager.stampStateOf = (operation) => (operation.batchId === BATCH_STAGE ? 'unknown' : 'confirmed');
    const answer = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30), topUp(NODE_A, BATCH_CATALOGUE, 18, 7)]);

    clock.now += THIRTY_MINUTES;
    assert.deepEqual(
      (await funding.stampBulk(answer.bulkId)).items.map((item) => item.state),
      ['unknown', 'queued'],
    );

    clock.now += 1;
    assert.deepEqual(
      (await funding.stampBulk(answer.bulkId)).items.map((item) => [item.state, item.settled, item.watched]),
      [
        ['unknown', true, true],
        ['confirmed', true, false],
      ],
    );
  });

  it('relays the next item for a node at once after one confirmed or failed', async () => {
    manager.inventoryAnswer = oneNodeTwoBatches();
    manager.stampStateOf = (operation) => (operation.batchId === BATCH_STAGE ? 'failed' : 'confirmed');

    const answer = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30), topUp(NODE_A, BATCH_CATALOGUE, 18, 7)]);

    assert.deepEqual(
      answer.items.map((item) => item.state),
      ['failed', 'confirmed'],
    );
  });
});

describe('refreshing a stamp bulk', () => {
  it('relays an item the manager never received again: the same fields under the same request id', async () => {
    manager.stampErrorAlways = managerFailure('timeout', null);
    const sent = await requested(TWO_TOP_UPS);
    assert.deepEqual(
      sent.items.map((item) => item.state),
      ['queued', 'queued'],
    );
    const firstAttempt = structuredClone(manager.stampOperations[0]);

    manager.stampErrorAlways = null;
    const refreshed = await funding.stampBulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((item) => item.state),
      ['confirmed', 'confirmed'],
    );
    const again = manager.stampOperations.slice(1);
    assert.deepEqual(again[0], firstAttempt, 'the same fields under the same request id');
    assert.deepEqual(
      again.map((operation) => operation.requestId),
      sent.items.map((item) => item.requestId),
    );
    assert.equal(manager.stampRuns.length, 2, 'the manager ran each once');
  });

  it('never relays again an item the manager answered for and no longer knows', async () => {
    manager.stampState = 'unknown';
    const sent = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    manager.stampJournal.clear();
    const relays = manager.stampCalls.operation;

    const refreshed = await funding.stampBulk(sent.bulkId);

    assert.equal(manager.stampCalls.operation, relays, 'a second run would pay again');
    assert.equal(refreshed.items[0]?.state, 'unknown');
  });

  it('records what the manager says of each item, and audits each outcome once, as the system', async () => {
    manager.stampState = 'unknown';
    const sent = await requested(TWO_TOP_UPS);
    const [first, second] = sent.items;
    assert.deepEqual(
      sent.items.map((item) => [item.state, item.settled, item.watched]),
      [
        ['unknown', false, true],
        ['unknown', false, true],
      ],
    );
    manager.stampStatusAnswers.set(first!.requestId, { state: 'confirmed', txHash: stampTxHash(first!.requestId) });
    manager.stampStatusAnswers.set(second!.requestId, {
      state: 'failed',
      error: 'The top-up reverted on chain.',
    });

    const refreshed = await funding.stampBulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((item) => [item.state, item.error, item.txHash]),
      [
        ['confirmed', null, stampTxHash(first!.requestId)],
        ['failed', 'The top-up reverted on chain.', null],
      ],
    );
    const [confirmed] = audit.withAction('funding.stamp.confirmed');
    const [failed] = audit.withAction('funding.stamp.failed');
    assert.deepEqual(confirmed?.actor, FUNDING_SYSTEM);
    assert.deepEqual(failed?.actor, FUNDING_SYSTEM);
    assert.equal(confirmed?.details?.txHash, stampTxHash(first!.requestId));

    // Settled for good: never asked about again, and audited no more.
    const reads = manager.stampCalls.status;
    await funding.stampBulk(sent.bulkId);
    assert.equal(manager.stampCalls.status, reads);
    assert.equal(audit.withAction('funding.stamp.confirmed').length, 1);
    assert.equal(audit.withAction('funding.stamp.failed').length, 1);
  });

  it('stops at the first item the manager cannot answer for, and leaves every item as it was', async () => {
    manager.stampState = 'unknown';
    const sent = await requested(TWO_TOP_UPS);
    manager.stampStatusError = managerFailure('unreachable', null);

    const refreshed = await funding.stampBulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((item) => item.state),
      ['unknown', 'unknown'],
    );
    assert.equal(manager.stampCalls.status, 1);
  });

  it('relays once and audits once for overlapping reads of one bulk', async () => {
    manager.stampErrorAlways = managerFailure('timeout', null);
    const sent = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    manager.stampErrorAlways = null;
    const relays = manager.stampCalls.operation;

    const [a, b] = await Promise.all([funding.stampBulk(sent.bulkId), funding.stampBulk(sent.bulkId)]);

    assert.equal(manager.stampCalls.operation, relays + 1);
    assert.equal(audit.withAction('funding.stamp.confirmed').length, 1);
    assert.deepEqual(a, b);
    assert.equal(a.items[0]?.state, 'confirmed');
  });

  it('answers a bulk as stored while funding is not set up, and 404 for one never journalled', async () => {
    manager.stampState = 'unknown';
    const sent = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    const reads = manager.stampCalls.status;
    build({ manager: null });

    assert.equal((await funding.stampBulk(sent.bulkId)).items[0]?.state, 'unknown');
    assert.equal(manager.stampCalls.status, reads);
    const missing = await refusal(funding.stampBulk('00000000-0000-4000-8000-00000000000a'));
    assert.ok(missing instanceof FundingBulkNotFoundError);
    assert.equal(missing.message, 'No stamp bulk has the id 00000000-0000-4000-8000-00000000000a.');
  });
});

describe('one stamp bulk at a time', () => {
  it('refuses a request while an earlier stamp bulk has an item still under way, and takes one once it settled', async () => {
    manager.stampState = 'unknown';
    const first = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    manager.stampState = 'confirmed';

    const busy = await refusal(funding.stampOperations(TEST_OPERATOR, [topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7)]));
    assert.ok(busy instanceof FundingBusyError);
    assert.equal(busy.message, 'An earlier stamp bulk is not settled yet, so no new one starts.');
    assert.equal(journal.rows.size, 1);

    // Refreshed before the check: the manager has settled it meanwhile.
    manager.stampStatusAnswers.set(first.items[0]!.requestId, { state: 'confirmed' });
    const second = await requested([topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7)]);
    assert.equal(second.items[0]?.state, 'confirmed');
  });

  it('refuses a request while an earlier one is still being relayed', async () => {
    let release!: () => void;
    manager.stampGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    build({ waitMs: 5 });
    await funding.stampOperations(TEST_OPERATOR, [topUp(NODE_A, BATCH_STAGE, 20, 30)]);

    const busy = await refusal(funding.stampOperations(TEST_OPERATOR, [topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7)]));

    assert.ok(busy instanceof FundingBusyError);
    release();
    await stamps.idle();
  });

  it('lets exactly one of two requests at once through, and refuses the other at the lock', async () => {
    let release!: () => void;
    journal.lockGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const both = Promise.allSettled([
      funding.stampOperations(TEST_OPERATOR, [topUp(NODE_A, BATCH_STAGE, 20, 30)]),
      funding.stampOperations(TEST_OPERATOR, [topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7)]),
    ]);
    // Both are past their checks by now; one holds the lock.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const outcomes = await both;
    await stamps.idle();

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.ok(refused?.reason instanceof FundingBusyError);
    assert.equal(journal.lockRefusals, 1, 'the second was refused at the lock, not after the first finished');
    assert.equal(journal.rows.size, 1);
  });

  it('holds the next bulk for 30 minutes after the manager answered an item unknown, and keeps watching it', async () => {
    manager.stampState = 'unknown';
    const first = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    const requestId = first.items[0]!.requestId;
    assert.deepEqual(
      first.items.map((item) => [item.state, item.settled, item.watched]),
      [['unknown', false, true]],
    );
    manager.stampState = 'confirmed';
    const next = () => requested([topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7)]);

    assert.ok((await refusal(next())) instanceof FundingBusyError);
    clock.now += THIRTY_MINUTES;
    assert.ok((await refusal(next())) instanceof FundingBusyError);
    clock.now += 1;
    assert.equal((await next()).items[0]?.state, 'confirmed');

    // Still watched: the manager reads it from the chain, and finds it confirmed after all.
    manager.stampStatusAnswers.set(requestId, { state: 'confirmed', txHash: stampTxHash(requestId) });
    const refreshed = await funding.stampBulk(first.bulkId);
    assert.deepEqual(
      refreshed.items.map((item) => [item.state, item.settled, item.watched]),
      [['confirmed', true, false]],
    );
  });

  it('counts the 30 minutes from the status read that finds a relay whose answer was lost', async () => {
    manager.stampErrorAlways = managerFailure('timeout', null);
    const first = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    const requestId = first.items[0]!.requestId;
    manager.stampErrorAlways = null;
    // The manager did journal it, unknown while the node works, and cannot tell how it ended.
    manager.stampStatusAnswers.set(requestId, { state: 'unknown', error: 'The node did not answer in time.' });

    clock.now += 40 * 60 * 1000;
    const found = await funding.stampBulk(first.bulkId);
    assert.deepEqual(
      found.items.map((item) => [item.state, item.error, item.settled]),
      [['unknown', 'The node did not answer in time.', false]],
    );
    assert.equal(journal.get(requestId)?.relayedAt?.getTime(), clock.now);
    const next = () => requested([topUp(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 7)]);

    clock.now += THIRTY_MINUTES;
    assert.ok((await refusal(next())) instanceof FundingBusyError);
    clock.now += 1;
    assert.equal((await next()).items.length, 1);
  });

  it('does not wait on a send, nor a send on a stamp bulk', async () => {
    pins.set(NODE_A, WALLET_A);
    manager.relayState = 'submitted';
    manager.stampState = 'unknown';

    // A stamp bulk goes ahead while a send is under way.
    const send = await funding.send(TEST_OPERATOR, [{ nodeId: NODE_A, kind: 'xdai', amount: '1' }]);
    const stampBulk = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    let view = await funding.view();
    assert.equal(view.openBulkId, send.bulkId);
    assert.equal(view.openStampBulkId, stampBulk.bulkId);

    // And a send goes ahead while the stamp bulk is under way, once the send before it settled.
    manager.statusAnswers.set(send.items[0]!.requestId, { state: 'confirmed', blockNumber: 7 });
    const next = await funding.send(TEST_OPERATOR, [{ nodeId: NODE_A, kind: 'xdai', amount: '2' }]);
    view = await funding.view();
    assert.equal(view.openBulkId, next.bulkId);
    assert.equal(view.openStampBulkId, stampBulk.bulkId);
  });
});

describe('the relays behind the request', () => {
  it('lets a read of the bulk share the relays under way, and pick their outcome up once they end', async () => {
    build({ waitMs: 5 });
    let release!: () => void;
    manager.stampGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const answer = await funding.stampOperations(TEST_OPERATOR, TWO_TOP_UPS);
    // A read while the first relay waits on the node shares the run under way: no relay or read of its own.
    const meanwhile = await funding.stampBulk(answer.bulkId);
    assert.deepEqual(
      meanwhile.items.map((item) => item.state),
      ['queued', 'queued'],
    );
    assert.deepEqual(manager.stampCalls, { operation: 1, status: 0 });
    assert.equal((await funding.view()).openStampBulkId, answer.bulkId);

    release();
    await stamps.idle();

    const after = await funding.stampBulk(answer.bulkId);
    assert.deepEqual(
      after.items.map((item) => item.state),
      ['confirmed', 'confirmed'],
    );
    assert.equal(manager.stampRuns.length, 2);
    assert.equal((await funding.view()).openStampBulkId, null);
    // The operator's relays, though they ended after the request answered.
    assert.deepEqual(
      audit.withAction('funding.stamp.confirmed').map((entry) => entry.actor),
      [TEST_OPERATOR, TEST_OPERATOR],
    );
  });
});

describe("the Funding page's open stamp bulk", () => {
  it('names the stamp bulk still under way, refreshed, until it settles', async () => {
    assert.equal((await funding.view()).openStampBulkId, null);
    manager.stampState = 'unknown';
    const sent = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    const reads = manager.stampCalls.status;

    const open = await funding.view();
    assert.equal(open.openStampBulkId, sent.bulkId);
    assert.equal(open.openBulkId, null);
    assert.equal(manager.stampCalls.status, reads + 1, 'the view refreshed the open stamp bulk');

    manager.stampStatusAnswers.set(sent.items[0]!.requestId, { state: 'confirmed' });
    assert.equal((await funding.view()).openStampBulkId, null);
  });

  it('names it without asking the manager while funding is not set up', async () => {
    manager.stampState = 'unknown';
    const sent = await requested([topUp(NODE_A, BATCH_STAGE, 20, 30)]);
    const reads = manager.stampCalls.status;
    build({ manager: null });

    assert.equal((await funding.view()).openStampBulkId, sent.bulkId);
    assert.equal(manager.stampCalls.status, reads);
  });
});

describe('the audit log of a stamp request', () => {
  it('records the request with its price and its items, then each outcome with its hash', async () => {
    const sent = await requested(TWO_TOP_UPS);
    const [stage, catalogue] = await journal.listBulk(sent.bulkId);

    const [request] = audit.withAction('funding.stamp.request');
    assert.deepEqual(request?.actor, TEST_OPERATOR);
    assert.deepEqual(request?.details, {
      bulkId: sent.bulkId,
      kind: 'topup',
      postage: POSTAGE,
      items: [stage, catalogue].map((row) => ({
        requestId: row?.requestId,
        nodeId: row?.nodeId,
        nodeLabel: row?.nodeLabel,
        batchId: row?.batchId,
        days: row?.days,
        steps: null,
        expectedDepth: row?.expectedDepth,
        newDepth: null,
        amountPerChunkPlur: row?.amountPerChunkPlur,
        costPlur: row?.costPlur,
      })),
    });
    const confirmed = audit.withAction('funding.stamp.confirmed');
    assert.deepEqual(
      confirmed.map((entry) => [entry.actor, entry.details?.requestId, entry.details?.txHash, entry.details?.state]),
      [
        [TEST_OPERATOR, stage?.requestId, stampTxHash(stage?.requestId ?? ''), 'confirmed'],
        [TEST_OPERATOR, catalogue?.requestId, stampTxHash(catalogue?.requestId ?? ''), 'confirmed'],
      ],
    );
    assert.equal(confirmed[0]?.details?.costPlur, stage?.costPlur);
    assert.equal(confirmed[0]?.details?.bulkId, sent.bulkId);
  });

  it('records a dilution with no price, and a failure with its sentence', async () => {
    manager.stampErrors.set(0, managerFailure('stamp_refused', 422, 'The depth moved.'));
    await requested([dilute(NODE_CATALOGUE, BATCH_CATALOGUE, 18, 1)]);

    const [request] = audit.withAction('funding.stamp.request');
    assert.equal(request?.details?.kind, 'dilute');
    assert.equal(request?.details?.postage, null);
    const [failed] = audit.withAction('funding.stamp.failed');
    assert.equal(failed?.details?.error, 'The manager refused it: The depth moved.');
    assert.equal(failed?.details?.newDepth, 19);
    assert.equal(failed?.details?.steps, 1);
  });

  it('writes no row for a request refused before it was journalled', async () => {
    await refusal(funding.stampOperations(TEST_OPERATOR, [topUp(NODE_A, BATCH_STAGE, 19, 30)]));

    assert.deepEqual(audit.entries, []);
  });
});

describe('the settled and watched flags of a stamp item', () => {
  it('say for each state whether it holds up a new stamp bulk, and whether it is still watched', async () => {
    const bulkId = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
    const cases = [
      { name: 'queued', state: 'queued', settled: false, watched: false },
      { name: 'submitted', state: 'submitted', settled: false, watched: false },
      { name: 'confirmed', state: 'confirmed', settled: true, watched: false },
      { name: 'failed', state: 'failed', settled: true, watched: false },
      { name: 'young unknown', state: 'unknown', settled: false, watched: true },
      { name: 'old unknown', state: 'unknown', ageMs: THIRTY_MINUTES + 1, settled: true, watched: true },
    ] as const;
    await journal.insertAll(
      cases.map((one, index) => ({
        requestId: `00000000-0000-4000-8000-00000000000${index}`,
        bulkId,
        position: index,
        nodeId: `stage-1:node-${index}`,
        nodeLabel: one.name,
        batchId: `0x${String(index).repeat(64)}`,
        kind: 'dilute' as const,
        days: null,
        steps: 1 as const,
        expectedDepth: 20,
        newDepth: 21,
        amountPerChunkPlur: null,
        costPlur: null,
        requestedByUserId: null,
        requestedBy: 'test-operator',
      })),
    );
    cases.forEach((one, index) =>
      journal.force(`00000000-0000-4000-8000-00000000000${index}`, one.state, {
        // The manager answered its relay this long ago.
        relayedAt: new Date(clock.now - ('ageMs' in one ? one.ageMs : 0)),
      }),
    );
    build({ manager: null });

    const { items } = await funding.stampBulk(bulkId);

    assert.deepEqual(
      items.map((item, index) => [cases[index]?.name, item.settled, item.watched]),
      cases.map((one) => [one.name, one.settled, one.watched]),
    );
  });
});

describe('what a stamp request relays', () => {
  it('is built from the journal alone, so a relay again carries the same fields as the first', async () => {
    manager.stampErrorAlways = managerFailure('unreachable', null);
    const sent = await requested([dilute(NODE_RUNG, BATCH_RUNG, 22, 2)]);
    const [first] = manager.stampOperations;
    // The batch moves meanwhile, as the manager will find: the relay again still says what the operator asked.
    manager.inventoryAnswer = withNode(NODE_RUNG, (node) => {
      node.batch = fundingBatch({ batchId: BATCH_RUNG, depth: 23, ttlSeconds: 30 * DAY });
    });
    manager.stampErrorAlways = null;

    await funding.stampBulk(sent.bulkId);

    const again: FundingStampOperationRequest | undefined = manager.stampOperations[1];
    assert.deepEqual(again, first);
    assert.deepEqual(again, {
      requestId: sent.items[0]?.requestId,
      kind: 'dilute',
      nodeId: NODE_RUNG,
      batchId: BATCH_RUNG,
      expectedDepth: 22,
      newDepth: 24,
    });
  });
});
