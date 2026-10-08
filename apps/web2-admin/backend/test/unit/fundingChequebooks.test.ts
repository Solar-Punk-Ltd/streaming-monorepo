/**
 * The chequebook operations of the Funding page against fakes: the manager journals what it is relayed and runs each
 * move once per request id, and the journals and the pins are in memory. `pnpm test`.
 *
 * Pinned here: the move each item makes, to the PLUR, a deposit under the target and a withdrawal over it, worked out
 * again from the available balance read now and never more than the page showed, with the balance it was worked out
 * from journalled and the amount answered; every refusal and its problem, nothing journalled, the floor of 1 xBZZ, a
 * node named twice and a chequebook at the target or past it now among them; a request answered at once, every item
 * journalled `queued`, then relayed in turn behind it, a refusal failing its item alone; a refresh that relays again
 * only an item the manager never received, the same fields under the same request id, and never one it answered for;
 * one chequebook bulk at a time, apart from sends and stamp bulks; a read that shares the relays under way; the view's
 * open chequebook bulk; the settled and watched flags; and the audit rows of a request and of each outcome.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { FundingChequebookOperationRequest, FundingInventory, FundingNode } from '@streaming-monorepo/contracts';
import {
  type ChequebookItemRequest,
  type FundingChequebookOperationsAnswer,
  type FundingChequebookOperationsRequest,
  parseBaseUnits,
  XBZZ_DECIMALS,
} from '@streaming-monorepo/web2-admin-common';

import {
  FundingBulkNotFoundError,
  FundingBusyError,
  FundingManagerUnavailableError,
  FundingRefusedError,
  RequestShapeError,
} from '../../src/domain/errors/index.js';
import {
  FundingChequebookService,
  toFundingChequebookItem,
} from '../../src/domain/funding/FundingChequebookService.js';
import { FUNDING_SYSTEM, FundingService } from '../../src/domain/funding/FundingService.js';
import { FundingStampService } from '../../src/domain/funding/FundingStampService.js';

import { InMemoryAuditLog, TEST_OPERATOR } from './support/fakes.js';
import {
  BATCH_STAGE,
  BZZ_TOKEN,
  chequebookInventory,
  chequebookTxHash,
  FakeFundingManager,
  FakeFundingWallet,
  fundingBatch,
  fundingChequebook,
  fundingNode,
  InMemoryFundingChequebookStore,
  InMemoryFundingPinStore,
  InMemoryFundingStampStore,
  InMemoryFundingTransferStore,
  managerFailure,
  NODE_A,
  NODE_B,
  NODE_CATALOGUE,
  NODE_RUNG,
  POSTAGE,
  WALLET_A,
  WALLET_C,
} from './support/fundingFakes.js';

let manager: FakeFundingManager;
let journal: InMemoryFundingChequebookStore;
let stampJournal: InMemoryFundingStampStore;
let transfers: InMemoryFundingTransferStore;
let pins: InMemoryFundingPinStore;
let wallet: FakeFundingWallet;
let audit: InMemoryAuditLog;
let chequebooks: FundingChequebookService;
let stamps: FundingStampService;
let funding: FundingService;
/** The services' clock, which a test moves by hand. */
const clock = { now: 0 };

const THIRTY_MINUTES = 30 * 60 * 1000;

/** Builds the services over the same fakes: the chequebook and stamp services, and the page's that answers with both. */
function build(over: { manager?: FakeFundingManager | null; waitMs?: number } = {}): void {
  const builtManager = over.manager === undefined ? manager : over.manager;
  chequebooks = new FundingChequebookService({
    manager: builtManager,
    journal,
    audit,
    now: () => clock.now,
    ...(over.waitMs === undefined ? {} : { waitMs: over.waitMs }),
  });
  stamps = new FundingStampService({ manager: builtManager, journal: stampJournal, audit, now: () => clock.now });
  funding = new FundingService({
    wallet,
    manager: builtManager,
    transfers,
    pins,
    stamps,
    chequebooks,
    audit,
    now: () => clock.now,
  });
}

beforeEach(() => {
  clock.now = Date.parse('2026-10-08T18:00:00.000Z');
  manager = new FakeFundingManager();
  manager.inventoryAnswer = chequebookInventory();
  journal = new InMemoryFundingChequebookStore();
  stampJournal = new InMemoryFundingStampStore();
  transfers = new InMemoryFundingTransferStore();
  pins = new InMemoryFundingPinStore();
  wallet = new FakeFundingWallet();
  audit = new InMemoryAuditLog();
  build();
});

/** An amount of xBZZ, as a person types it, in PLUR. */
const xbzz = (amount: string) => parseBaseUnits(amount, XBZZ_DECIMALS) as string;

/** The target most tests bring the chequebooks to: 2 xBZZ. */
const TARGET = xbzz('2');

const item = (nodeId: string, availablePlur: string): ChequebookItemRequest => ({ nodeId, availablePlur });

/** The stage's own node as the page showed it, 1.5 xBZZ available: a deposit of 0.5 to the target. */
const STAGE_NODE = item(NODE_A, xbzz('1.5'));
/** The rung's node as the page showed it, 3.25 xBZZ available: a withdrawal of 1.25 to the target. */
const RUNG_NODE = item(NODE_RUNG, xbzz('3.25'));

const toTarget = (...items: ChequebookItemRequest[]): FundingChequebookOperationsRequest => ({
  targetPlur: TARGET,
  items,
});

/** The items of a bulk as the console reads them now, from the journal, asking the manager nothing. */
async function itemsOf(bulkId: string) {
  return (await journal.listBulk(bulkId)).map((row) => toFundingChequebookItem(row, clock.now));
}

/** Asks for `request` as the operator, lets the relays behind it end, and answers the items as they stand. */
async function requested(request: FundingChequebookOperationsRequest): Promise<FundingChequebookOperationsAnswer> {
  const answer = await funding.chequebookOperations(TEST_OPERATOR, request);
  await chequebooks.idle();
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

/** The chequebook inventory with one node changed, by its id, in the stage or as the catalogue node. */
function withNode(nodeId: string, change: (node: FundingNode) => void): FundingInventory {
  const inventory = chequebookInventory();
  for (const node of [...inventory.stages.flatMap((stage) => stage.nodes), inventory.catalogue]) {
    if (node?.nodeId === nodeId) change(node);
  }
  return inventory;
}

/** Settles each item as the manager does once the node's move is mined. */
function mined(answer: FundingChequebookOperationsAnswer): void {
  for (const one of answer.items) manager.chequebookJournalState.set(one.requestId, 'confirmed');
}

describe('a request, answered at once', () => {
  it('answers the bulk id and every item queued before the manager has answered any', async () => {
    let release!: () => void;
    manager.chequebookGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const answer = await funding.chequebookOperations(TEST_OPERATOR, toTarget(STAGE_NODE, RUNG_NODE));

    assert.match(answer.bulkId, /^[0-9a-f-]{36}$/);
    const [first, second] = answer.items;
    assert.deepEqual(first, {
      requestId: first?.requestId,
      nodeId: NODE_A,
      nodeLabel: 'Main stage uploader',
      direction: 'deposit',
      amountPlur: xbzz('0.5'),
      targetPlur: TARGET,
      state: 'queued',
      txHash: null,
      error: null,
      settled: false,
      watched: false,
    });
    assert.deepEqual(
      [second?.nodeLabel, second?.direction, second?.amountPlur, second?.state],
      ['Main stage 720p rung', 'withdraw', xbzz('1.25'), 'queued'],
    );

    release();
    await chequebooks.idle();
    // The manager answers once the node has sent the move: under way until it is mined, holding up the next bulk.
    assert.deepEqual(
      (await itemsOf(answer.bulkId)).map((one) => [one.state, one.txHash, one.settled, one.watched]),
      [
        ['submitted', chequebookTxHash(first?.requestId ?? ''), false, false],
        ['submitted', chequebookTxHash(second?.requestId ?? ''), false, false],
      ],
    );
  });

  it('journals every item before relaying any, then relays them in turn', async () => {
    const seen: string[] = [];
    manager.onChequebookOperation = (operation) => {
      // At the moment of each relay, every item of the request is journalled, this one queued with these fields.
      assert.equal(journal.rows.size, 2);
      const row = journal.get(operation.requestId);
      assert.ok(row, 'the item is journalled before it is relayed');
      assert.equal(row.state, 'queued');
      assert.deepEqual([row.direction, row.amountPlur], [operation.direction, operation.amountPlur]);
      seen.push(operation.requestId);
    };

    const answer = await requested(toTarget(STAGE_NODE, RUNG_NODE));

    assert.deepEqual(
      seen,
      answer.items.map((one) => one.requestId),
    );
  });
});

describe('the move, worked out again from the balance read now, never more than the confirm dialog showed', () => {
  it('deposits the target less the balance the page showed, and withdraws the balance less the target, while it still holds that', async () => {
    const answer = await requested(toTarget(STAGE_NODE, RUNG_NODE));

    const [stage, rung] = answer.items;
    assert.deepEqual(manager.chequebookOperations, [
      { requestId: stage?.requestId, nodeId: NODE_A, direction: 'deposit', amountPlur: xbzz('0.5') },
      { requestId: rung?.requestId, nodeId: NODE_RUNG, direction: 'withdraw', amountPlur: xbzz('1.25') },
    ]);
    const rows = await journal.listBulk(answer.bulkId);
    assert.deepEqual(
      rows.map((row) => [row.position, row.direction, row.amountPlur, row.targetPlur, row.availablePlur]),
      [
        [0, 'deposit', xbzz('0.5'), TARGET, xbzz('1.5')],
        [1, 'withdraw', xbzz('1.25'), TARGET, xbzz('3.25')],
      ],
    );
  });

  it('keeps the move shown for a deposit into a chequebook that drew down since, and a withdrawal from one that grew', async () => {
    // Since the page read them, the stage's node paid its peers 0.1 xBZZ, and 0.25 was deposited into the rung's.
    const inventory = withNode(NODE_A, (node) => {
      node.chequebook = fundingChequebook({ availablePlur: xbzz('1.4') });
    });
    inventory.stages[0]!.nodes[2]!.chequebook = fundingChequebook({ availablePlur: xbzz('3.5') });
    manager.inventoryAnswer = inventory;

    const answer = await funding.chequebookOperations(TEST_OPERATOR, toTarget(STAGE_NODE, RUNG_NODE));
    await chequebooks.idle();

    // The deposit lands a little under the target, at 1.9, and the withdrawal a little over it, at 2.25.
    const moves = [
      ['deposit', xbzz('0.5')],
      ['withdraw', xbzz('1.25')],
    ];
    assert.deepEqual(
      answer.items.map((one) => [one.direction, one.amountPlur]),
      moves,
    );
    assert.deepEqual(
      manager.chequebookOperations.map((operation) => [operation.direction, operation.amountPlur]),
      moves,
    );
    // Worked out from the larger balance for the deposit and the smaller for the withdrawal: the page's, both times.
    assert.deepEqual(
      (await journal.listBulk(answer.bulkId)).map((row) => [row.amountPlur, row.availablePlur]),
      [
        [xbzz('0.5'), xbzz('1.5')],
        [xbzz('1.25'), xbzz('3.25')],
      ],
    );
  });

  it('shrinks a deposit into a chequebook that grew since, and a withdrawal from one that drew down, to the target', async () => {
    // Since the page read them, 0.3 xBZZ was deposited into the stage's node's, and the rung paid its peers 0.25.
    const inventory = withNode(NODE_A, (node) => {
      node.chequebook = fundingChequebook({ availablePlur: xbzz('1.8') });
    });
    inventory.stages[0]!.nodes[2]!.chequebook = fundingChequebook({ availablePlur: xbzz('3') });
    manager.inventoryAnswer = inventory;

    const answer = await funding.chequebookOperations(TEST_OPERATOR, toTarget(STAGE_NODE, RUNG_NODE));
    await chequebooks.idle();

    // The request answers the moves it journalled, not the ones the dialog listed, 0.5 and 1.25.
    const moves = [
      ['deposit', xbzz('0.2')],
      ['withdraw', xbzz('1')],
    ];
    assert.deepEqual(
      answer.items.map((one) => [one.direction, one.amountPlur, one.targetPlur, one.state]),
      moves.map((move) => [...move, TARGET, 'queued']),
    );
    assert.deepEqual(
      manager.chequebookOperations.map((operation) => [operation.direction, operation.amountPlur]),
      moves,
    );
    // Worked out from the balances read now, the larger for the deposit and the smaller for the withdrawal.
    assert.deepEqual(
      (await journal.listBulk(answer.bulkId)).map((row) => [
        row.direction,
        row.amountPlur,
        row.targetPlur,
        row.availablePlur,
      ]),
      [
        ['deposit', xbzz('0.2'), TARGET, xbzz('1.8')],
        ['withdraw', xbzz('1'), TARGET, xbzz('3')],
      ],
    );
    const [request] = audit.withAction('funding.chequebook.request');
    const audited = (request?.details?.items ?? []) as { amountPlur: string; availablePlur: string }[];
    assert.deepEqual(
      audited.map((one) => [one.amountPlur, one.availablePlur]),
      [
        [xbzz('0.2'), xbzz('1.8')],
        [xbzz('1'), xbzz('3')],
      ],
    );
  });

  it('never takes a chequebook under the target by a withdrawal, nor under the floor of 1 xBZZ', async () => {
    // The page showed 3.25 against a target of 1, a withdrawal of 2.25, and the rung has paid its peers down to 1.5.
    manager.inventoryAnswer = withNode(NODE_RUNG, (node) => {
      node.chequebook = fundingChequebook({ availablePlur: xbzz('1.5') });
    });

    const answer = await requested({ targetPlur: xbzz('1'), items: [RUNG_NODE] });

    assert.deepEqual(
      answer.items.map((one) => [one.direction, one.amountPlur]),
      [['withdraw', xbzz('0.5')]],
    );
  });

  it('keeps every PLUR, past what a floating point number holds', async () => {
    manager.inventoryAnswer = withNode(NODE_A, (node) => {
      node.chequebook = fundingChequebook({ availablePlur: '1' });
    });

    await requested({ targetPlur: '20000000000000001', items: [item(NODE_A, '1')] });

    assert.equal(manager.chequebookOperations[0]?.amountPlur, '20000000000000000');
  });

  it('brings a chequebook to the floor, 1 xBZZ exactly', async () => {
    const answer = await requested({ targetPlur: xbzz('1'), items: [RUNG_NODE] });

    assert.deepEqual(
      answer.items.map((one) => [one.direction, one.amountPlur, one.targetPlur]),
      [['withdraw', xbzz('2.25'), xbzz('1')]],
    );
  });
});

describe('refusing a request, nothing journalled', () => {
  async function refused(request: FundingChequebookOperationsRequest): Promise<FundingRefusedError> {
    const error = await refusal(funding.chequebookOperations(TEST_OPERATOR, request));
    assert.ok(error instanceof FundingRefusedError, String(error));
    assert.equal(journal.rows.size, 0, 'nothing was journalled');
    assert.equal(manager.chequebookCalls.operation, 0, 'nothing was relayed');
    return error;
  }

  it('refuses what is not a request before it asks the manager anything, each with its sentence', async () => {
    const cases: [FundingChequebookOperationsRequest, string][] = [
      [{ targetPlur: '2.5', items: [STAGE_NODE] }, 'The target must be a whole number of PLUR, 30 digits at most.'],
      [
        { targetPlur: '1'.repeat(31), items: [STAGE_NODE] },
        'The target must be a whole number of PLUR, 30 digits at most.',
      ],
      [{ targetPlur: '9999999999999999', items: [STAGE_NODE] }, 'The target must be at least 1 xBZZ.'],
      [{ targetPlur: '0', items: [STAGE_NODE] }, 'The target must be at least 1 xBZZ.'],
      [{ targetPlur: TARGET, items: [] }, 'A request names one chequebook or more.'],
      [
        toTarget(item(NODE_A, '-1')),
        'The available balance of stage-1:uploader must be a whole number of PLUR, 30 digits at most.',
      ],
      [
        toTarget(STAGE_NODE, RUNG_NODE, { ...STAGE_NODE, availablePlur: xbzz('1') }),
        'stage-1:uploader is named twice: a request brings a chequebook to the target once.',
      ],
    ];
    for (const [request, sentence] of cases) {
      const error = await refusal(funding.chequebookOperations(TEST_OPERATOR, request));
      assert.ok(error instanceof RequestShapeError, JSON.stringify(request));
      assert.deepEqual(error.problems, [sentence]);
    }
    assert.equal(manager.calls.inventory, 0);
    assert.equal(journal.rows.size, 0);
  });

  it('refuses while funding is not set up', async () => {
    build({ manager: null });
    const error = await refused(toTarget(STAGE_NODE));

    assert.equal(error.problem, 'not_set_up');
  });

  it('refuses a manager on another chain', async () => {
    const inventory = chequebookInventory();
    inventory.chain = { chainId: 1, bzzToken: BZZ_TOKEN };
    manager.inventoryAnswer = inventory;

    const error = await refused(toTarget(STAGE_NODE));

    assert.equal(error.problem, 'chain');
  });

  it('answers a manager it cannot read with a sentence of its own', async () => {
    manager.inventoryError = managerFailure('timeout', null, 'GET http://manager.example/ timed out');

    const error = await refusal(funding.chequebookOperations(TEST_OPERATOR, toTarget(STAGE_NODE)));

    assert.ok(error instanceof FundingManagerUnavailableError);
    assert.equal(error.message, 'The manager could not be reached. Nothing was sent.');
    assert.equal(journal.rows.size, 0);
  });

  it('refuses a node the manager does not hold', async () => {
    const error = await refused(toTarget(item('stage-9:gone', '0')));

    assert.equal(error.problem, 'node');
    assert.equal(error.message, 'The manager has no node stage-9:gone, so nothing was sent.');
  });

  it("refuses the catalogue node, which no stage lists, and takes a stage's node that is the catalogue node too", async () => {
    const catalogue = await refused(toTarget(item(NODE_CATALOGUE, xbzz('1'))));
    assert.equal(catalogue.problem, 'node');
    assert.equal(
      catalogue.message,
      'Catalogue node (catalogue:uploader) is the catalogue node, which no stage lists: the Chequebooks tab leaves its chequebook alone. Nothing was sent.',
    );

    const inventory = chequebookInventory();
    inventory.catalogue = { ...inventory.stages[0]!.nodes[0]!, label: 'Main stage catalogue node' };
    manager.inventoryAnswer = inventory;
    const answer = await requested(toTarget(STAGE_NODE));
    assert.deepEqual(
      answer.items.map((one) => [one.nodeId, one.nodeLabel, one.state]),
      [[NODE_A, 'Main stage uploader', 'submitted']],
    );
  });

  it("refuses a gateway's chequebook, which the manager does not move", async () => {
    const error = await refused(toTarget(item(NODE_B, xbzz('3'))));

    assert.equal(error.problem, 'node');
    assert.equal(
      error.message,
      "Main stage gateway (stage-1:gateway) is a gateway: the manager moves only the chequebook of a stage's own Bee node or of a rung. Nothing was sent.",
    );
  });

  it('refuses a chequebook the node has not got, one not read, and one from a manager that reads none, saying which', async () => {
    const cases: [FundingNode['chequebook'], string][] = [
      [
        null,
        'Main stage uploader (stage-1:uploader) has no chequebook, so there is none to bring to the target. Nothing was sent.',
      ],
      [
        { address: null, availablePlur: null, totalPlur: null, readError: 'The node did not answer in time.' },
        'The chequebook of Main stage uploader (stage-1:uploader) could not be read, so nothing was sent. The node did not answer in time.',
      ],
      [
        undefined,
        'The manager did not say how the chequebook of Main stage uploader (stage-1:uploader) stands: it reads no chequebooks. Nothing was sent.',
      ],
    ];
    for (const [chequebook, sentence] of cases) {
      manager.inventoryAnswer = withNode(NODE_A, (node) => {
        if (chequebook === undefined) delete node.chequebook;
        else node.chequebook = chequebook;
      });
      const error = await refused(toTarget(STAGE_NODE));
      assert.equal(error.problem, 'chequebook');
      assert.equal(error.message, sentence);
    }
  });

  it('refuses a node whose wallet could not be read', async () => {
    manager.inventoryAnswer = withNode(NODE_RUNG, (node) => {
      node.walletAddress = null;
      node.xdaiWei = null;
      node.xbzzPlur = null;
      node.readError = 'The node did not answer in time.';
    });

    const error = await refused(toTarget(RUNG_NODE));

    assert.equal(error.problem, 'node');
    assert.equal(
      error.message,
      'The wallet of Main stage 720p rung (stage-2:uploader) could not be read, so there is no telling whether it can pay. Nothing was sent. The node did not answer in time.',
    );
  });

  it('refuses an item at the target as the page showed it, since there is nothing to move', async () => {
    const error = await refused(toTarget(STAGE_NODE, item(NODE_RUNG, TARGET)));

    assert.equal(error.problem, 'chequebook');
    assert.equal(
      error.message,
      'The chequebook of Main stage 720p rung (stage-2:uploader) is at the target as the page showed it, so there is nothing to move. Nothing was sent.',
    );
  });

  it('refuses a deposit into a chequebook at the target or past it now, and takes one a PLUR under it', async () => {
    // The page showed 1.5 against the target of 2, a deposit of 0.5, and something was deposited since.
    for (const [now, said] of [
      [TARGET, '2'],
      [xbzz('2.5'), '2.5'],
    ] as const) {
      manager.inventoryAnswer = withNode(NODE_A, (node) => {
        node.chequebook = fundingChequebook({ availablePlur: now });
      });
      const error = await refused(toTarget(STAGE_NODE));
      assert.equal(error.problem, 'chequebook');
      assert.equal(
        error.message,
        `The chequebook of Main stage uploader (stage-1:uploader) holds ${said} xBZZ available now, at the target or past it, so there is nothing to move. Read the page again. Nothing was sent.`,
      );
    }

    const short = (BigInt(TARGET) - 1n).toString();
    manager.inventoryAnswer = withNode(NODE_A, (node) => {
      node.chequebook = fundingChequebook({ availablePlur: short });
    });
    const answer = await requested(toTarget(STAGE_NODE));
    assert.deepEqual(
      answer.items.map((one) => [one.direction, one.amountPlur]),
      [['deposit', '1']],
    );
    assert.deepEqual(
      (await journal.listBulk(answer.bulkId)).map((row) => row.availablePlur),
      [short],
    );
  });

  it('refuses a withdrawal from a chequebook at the target or past it now, and takes one a PLUR over it', async () => {
    // The page showed 3.25 against the target of 2, a withdrawal of 1.25, and the rung has paid its peers since.
    for (const [now, said] of [
      [TARGET, '2'],
      [xbzz('1.5'), '1.5'],
    ] as const) {
      manager.inventoryAnswer = withNode(NODE_RUNG, (node) => {
        node.chequebook = fundingChequebook({ availablePlur: now });
      });
      const error = await refused(toTarget(RUNG_NODE));
      assert.equal(error.problem, 'chequebook');
      assert.equal(
        error.message,
        `The chequebook of Main stage 720p rung (stage-2:uploader) holds ${said} xBZZ available now, at the target or past it, so there is nothing to move. Read the page again. Nothing was sent.`,
      );
    }

    const over = (BigInt(TARGET) + 1n).toString();
    manager.inventoryAnswer = withNode(NODE_RUNG, (node) => {
      node.chequebook = fundingChequebook({ availablePlur: over });
    });
    const answer = await requested(toTarget(RUNG_NODE));
    assert.deepEqual(
      answer.items.map((one) => [one.direction, one.amountPlur]),
      [['withdraw', '1']],
    );
    assert.deepEqual(
      (await journal.listBulk(answer.bulkId)).map((row) => row.availablePlur),
      [over],
    );
  });

  it('refuses the whole request for one chequebook past the target now, the others with it', async () => {
    manager.inventoryAnswer = withNode(NODE_RUNG, (node) => {
      node.chequebook = fundingChequebook({ availablePlur: xbzz('1.5') });
    });

    const error = await refused(toTarget(STAGE_NODE, RUNG_NODE));

    assert.match(error.message, /^The chequebook of Main stage 720p rung \(stage-2:uploader\) holds 1\.5 xBZZ/);
  });

  it('refuses a node with no xDAI for the gas, for a deposit and a withdrawal alike', async () => {
    for (const [nodeId, one] of [
      [NODE_A, STAGE_NODE],
      [NODE_RUNG, RUNG_NODE],
    ] as const) {
      manager.inventoryAnswer = withNode(nodeId, (node) => {
        node.xdaiWei = '0';
      });
      const error = await refused(toTarget(one));
      assert.equal(error.problem, 'insufficient_funds');
      assert.match(
        error.message,
        /^The nodes cannot pay for this: .+ holds no xDAI to pay the gas\. Nothing was sent\.$/,
      );
    }
  });

  it('takes a deposit that fits the wallet to the PLUR, and refuses one PLUR more, naming the shortfall', async () => {
    manager.inventoryAnswer = withNode(NODE_A, (node) => {
      node.xbzzPlur = (BigInt(xbzz('0.5')) - 1n).toString();
    });
    const error = await refused(toTarget(STAGE_NODE));
    assert.equal(error.problem, 'insufficient_funds');
    assert.equal(
      error.message,
      'The nodes cannot pay for this: Main stage uploader (stage-1:uploader) is 0.0000000000000001 xBZZ short: it deposits 0.5 xBZZ, and its wallet holds 0.4999999999999999. Nothing was sent.',
    );

    manager.inventoryAnswer = withNode(NODE_A, (node) => {
      node.xbzzPlur = xbzz('0.5');
    });
    const answer = await requested(toTarget(STAGE_NODE));
    assert.equal(answer.items[0]?.state, 'submitted');
  });

  it('holds the wallet to the deposit worked out now, not the one the page showed', async () => {
    // The page showed 1.5, a deposit of 0.5; the chequebook holds 1.8 now, so the deposit is 0.2.
    const grown = (xbzzPlur: string) =>
      withNode(NODE_A, (node) => {
        node.chequebook = fundingChequebook({ availablePlur: xbzz('1.8') });
        node.xbzzPlur = xbzzPlur;
      });
    manager.inventoryAnswer = grown((BigInt(xbzz('0.2')) - 1n).toString());
    const error = await refused(toTarget(STAGE_NODE));
    assert.equal(
      error.message,
      'The nodes cannot pay for this: Main stage uploader (stage-1:uploader) is 0.0000000000000001 xBZZ short: it deposits 0.2 xBZZ, and its wallet holds 0.1999999999999999. Nothing was sent.',
    );

    manager.inventoryAnswer = grown(xbzz('0.2'));
    const answer = await requested(toTarget(STAGE_NODE));
    assert.deepEqual(
      answer.items.map((one) => [one.direction, one.amountPlur, one.state]),
      [['deposit', xbzz('0.2'), 'submitted']],
    );
  });

  it('lets a withdrawal through whatever the wallet holds in xBZZ, since it pays only the gas', async () => {
    manager.inventoryAnswer = withNode(NODE_RUNG, (node) => {
      node.xbzzPlur = '0';
    });

    const answer = await requested(toTarget(RUNG_NODE));

    assert.equal(answer.items[0]?.direction, 'withdraw');
  });

  it('names every node that cannot pay in one sentence', async () => {
    const inventory = withNode(NODE_A, (node) => {
      node.xbzzPlur = '0';
    });
    inventory.stages[0]!.nodes[2]!.xdaiWei = '0';
    manager.inventoryAnswer = inventory;

    const error = await refused(toTarget(STAGE_NODE, RUNG_NODE));

    assert.equal(
      error.message,
      'The nodes cannot pay for this: Main stage uploader (stage-1:uploader) is 0.5 xBZZ short: it deposits 0.5 xBZZ, and its wallet holds 0; Main stage 720p rung (stage-2:uploader) holds no xDAI to pay the gas. Nothing was sent.',
    );
  });

  it('takes a node two stages list under the listing that can move it, and moves its chequebook once', async () => {
    const inventory = chequebookInventory();
    const rung = inventory.stages[0]!.nodes[2]!;
    inventory.stages.push({
      stageId: '1f0c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      name: 'Side stage',
      nodes: [{ ...rung, label: 'Side stage Bee node', role: 'uploader' }],
    });
    manager.inventoryAnswer = inventory;

    const answer = await requested(toTarget(RUNG_NODE));

    assert.deepEqual(
      answer.items.map((one) => [one.nodeId, one.nodeLabel, one.direction]),
      [[NODE_RUNG, 'Main stage 720p rung', 'withdraw']],
    );
    assert.equal(manager.chequebookRuns.length, 1);
  });
});

describe('relaying the items in turn', () => {
  it('fails an item the manager refuses with its sentence, nothing done, and relays the next', async () => {
    for (const code of ['chequebook_refused', 'unknown_node', 'conflict', 'bad_transaction'] as const) {
      journal.rows.clear();
      manager.chequebookCalls.operation = 0;
      manager.chequebookErrors.clear();
      manager.chequebookErrors.set(0, managerFailure(code, 422, `The manager says no (${code}). Nothing was sent.`));

      const answer = await requested(toTarget(STAGE_NODE, RUNG_NODE));

      assert.deepEqual(
        answer.items.map((one) => [one.state, one.error, one.settled, one.watched]),
        [
          ['failed', `The manager refused it: The manager says no (${code}). Nothing was sent.`, true, false],
          ['submitted', null, false, false],
        ],
        code,
      );
      assert.equal(manager.chequebookCalls.operation, 2, code);
    }
  });

  it("takes the manager's sentence for an item its preflight refused, which its answer does not carry", async () => {
    manager.chequebookState = 'failed';
    const answer = await requested(toTarget(STAGE_NODE));

    assert.deepEqual(
      answer.items.map((one) => [one.state, one.error, one.txHash, one.settled, one.watched]),
      [['failed', "The node's wallet holds too little xBZZ for the deposit. Nothing was sent.", null, true, false]],
    );
    assert.equal(manager.chequebookCalls.status, 1);
  });

  it('says so in its own sentence when the reason cannot be read', async () => {
    manager.chequebookState = 'failed';
    manager.chequebookStatusError = managerFailure('unreachable', null);

    const answer = await requested(toTarget(STAGE_NODE));

    assert.equal(answer.items[0]?.error, 'The manager reports that it failed, without a reason the admin could read.');
  });

  it('leaves an item queued, and the ones after it unrelayed, when its answer is lost or cannot be read', async () => {
    for (const lost of [
      managerFailure('timeout', null),
      managerFailure('unreachable', null),
      managerFailure('bad_answer', 500, 'The manager answered with status 500 and no funding API error.'),
      // The manager's journal out of reach: 503 chequebook_journal_unavailable, no code of the contract's.
      managerFailure('bad_answer', 503, 'The manager answered with status 503 and no funding API error.'),
    ]) {
      journal.rows.clear();
      manager.chequebookCalls.operation = 0;
      manager.chequebookErrors.set(0, lost);

      const answer = await requested(toTarget(STAGE_NODE, RUNG_NODE));

      assert.deepEqual(
        answer.items.map((one) => [one.state, one.settled]),
        [
          ['queued', false],
          ['queued', false],
        ],
        lost.code,
      );
      assert.equal(manager.chequebookCalls.operation, 1, lost.code);
    }
  });

  it('records the hash the manager answers, and keeps it', async () => {
    manager.chequebookState = 'unknown';
    const answer = await requested(toTarget(STAGE_NODE));
    const requestId = answer.items[0]!.requestId;
    assert.equal(answer.items[0]?.txHash, null);

    manager.chequebookStatusAnswers.set(requestId, { state: 'unknown', txHash: chequebookTxHash(requestId) });
    assert.equal((await funding.chequebookBulk(answer.bulkId)).items[0]?.txHash, chequebookTxHash(requestId));

    manager.chequebookStatusAnswers.set(requestId, { state: 'confirmed', txHash: null });
    const settled = await funding.chequebookBulk(answer.bulkId);
    assert.deepEqual(
      settled.items.map((one) => [one.state, one.txHash]),
      [['confirmed', chequebookTxHash(requestId)]],
    );
  });
});

describe('refreshing a chequebook bulk', () => {
  it('relays an item the manager never received again: the same fields under the same request id', async () => {
    manager.chequebookErrorAlways = managerFailure('timeout', null);
    const sent = await requested(toTarget(STAGE_NODE, RUNG_NODE));
    assert.deepEqual(
      sent.items.map((one) => one.state),
      ['queued', 'queued'],
    );
    const firstAttempt = structuredClone(manager.chequebookOperations[0]);

    manager.chequebookErrorAlways = null;
    const refreshed = await funding.chequebookBulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((one) => one.state),
      ['submitted', 'submitted'],
    );
    const again = manager.chequebookOperations.slice(1);
    assert.deepEqual(again[0], firstAttempt, 'the same fields under the same request id');
    assert.deepEqual(
      again.map((operation) => operation.requestId),
      sent.items.map((one) => one.requestId),
    );
    assert.equal(manager.chequebookRuns.length, 2, 'the manager ran each once');
  });

  it('never relays again an item the manager answered for and no longer knows', async () => {
    manager.chequebookState = 'unknown';
    const sent = await requested(toTarget(STAGE_NODE));
    manager.chequebookJournal.clear();
    const relays = manager.chequebookCalls.operation;

    const refreshed = await funding.chequebookBulk(sent.bulkId);

    assert.equal(manager.chequebookCalls.operation, relays, 'a second run would move the balance again');
    assert.equal(refreshed.items[0]?.state, 'unknown');
  });

  it('records what the manager says of each item, and audits each outcome once, as the system', async () => {
    const sent = await requested(toTarget(STAGE_NODE, RUNG_NODE));
    const [first, second] = sent.items;
    manager.chequebookJournalState.set(first!.requestId, 'confirmed');
    manager.chequebookStatusAnswers.set(second!.requestId, {
      state: 'failed',
      error: 'The chain reverted the move; nothing moved.',
    });

    const refreshed = await funding.chequebookBulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((one) => [one.state, one.error, one.txHash, one.settled]),
      [
        ['confirmed', null, chequebookTxHash(first!.requestId), true],
        ['failed', 'The chain reverted the move; nothing moved.', chequebookTxHash(second!.requestId), true],
      ],
    );
    const [confirmed] = audit.withAction('funding.chequebook.confirmed');
    const [failed] = audit.withAction('funding.chequebook.failed');
    assert.deepEqual(confirmed?.actor, FUNDING_SYSTEM);
    assert.deepEqual(failed?.actor, FUNDING_SYSTEM);
    assert.equal(confirmed?.details?.txHash, chequebookTxHash(first!.requestId));

    // Settled for good: never asked about again, and audited no more.
    const reads = manager.chequebookCalls.status;
    await funding.chequebookBulk(sent.bulkId);
    assert.equal(manager.chequebookCalls.status, reads);
    assert.equal(audit.withAction('funding.chequebook.confirmed').length, 1);
    assert.equal(audit.withAction('funding.chequebook.failed').length, 1);
  });

  it('stops at the first item the manager cannot answer for, and leaves every item as it was', async () => {
    const sent = await requested(toTarget(STAGE_NODE, RUNG_NODE));
    manager.chequebookStatusError = managerFailure('unreachable', null);

    const refreshed = await funding.chequebookBulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((one) => one.state),
      ['submitted', 'submitted'],
    );
    assert.equal(manager.chequebookCalls.status, 1);
  });

  it('relays once and audits once for overlapping reads of one bulk', async () => {
    manager.chequebookErrorAlways = managerFailure('timeout', null);
    const sent = await requested(toTarget(STAGE_NODE));
    manager.chequebookErrorAlways = null;
    manager.chequebookState = 'confirmed';
    const relays = manager.chequebookCalls.operation;

    const [a, b] = await Promise.all([funding.chequebookBulk(sent.bulkId), funding.chequebookBulk(sent.bulkId)]);

    assert.equal(manager.chequebookCalls.operation, relays + 1);
    assert.equal(audit.withAction('funding.chequebook.confirmed').length, 1);
    assert.deepEqual(a, b);
    assert.equal(a.items[0]?.state, 'confirmed');
  });

  it('answers a bulk as stored while funding is not set up, and 404 for one never journalled', async () => {
    const sent = await requested(toTarget(STAGE_NODE));
    const reads = manager.chequebookCalls.status;
    build({ manager: null });

    assert.equal((await funding.chequebookBulk(sent.bulkId)).items[0]?.state, 'submitted');
    assert.equal(manager.chequebookCalls.status, reads);
    const missing = await refusal(funding.chequebookBulk('00000000-0000-4000-8000-00000000000a'));
    assert.ok(missing instanceof FundingBulkNotFoundError);
    assert.equal(missing.message, 'No chequebook bulk has the id 00000000-0000-4000-8000-00000000000a.');
  });
});

describe('one chequebook bulk at a time', () => {
  it('refuses a request while an earlier chequebook bulk has an item under way, and takes one once it is mined', async () => {
    const first = await requested(toTarget(STAGE_NODE));

    const busy = await refusal(funding.chequebookOperations(TEST_OPERATOR, toTarget(RUNG_NODE)));
    assert.ok(busy instanceof FundingBusyError);
    assert.equal(busy.message, 'An earlier chequebook bulk is not settled yet, so no new one starts.');
    assert.equal(journal.rows.size, 1);

    // Refreshed before the check: the manager has seen the move mined meanwhile.
    mined(first);
    const second = await requested(toTarget(RUNG_NODE));
    assert.equal(second.items[0]?.state, 'submitted');
  });

  it('refuses a request while an earlier one is still being relayed', async () => {
    let release!: () => void;
    manager.chequebookGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    build({ waitMs: 5 });
    await funding.chequebookOperations(TEST_OPERATOR, toTarget(STAGE_NODE));

    const busy = await refusal(funding.chequebookOperations(TEST_OPERATOR, toTarget(RUNG_NODE)));

    assert.ok(busy instanceof FundingBusyError);
    release();
    await chequebooks.idle();
  });

  it('lets exactly one of two requests at once through, and refuses the other at the lock', async () => {
    let release!: () => void;
    journal.lockGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const both = Promise.allSettled([
      funding.chequebookOperations(TEST_OPERATOR, toTarget(STAGE_NODE)),
      funding.chequebookOperations(TEST_OPERATOR, toTarget(RUNG_NODE)),
    ]);
    // Both are past their checks by now; one holds the lock.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const outcomes = await both;
    await chequebooks.idle();

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.ok(refused?.reason instanceof FundingBusyError);
    assert.equal(journal.lockRefusals, 1, 'the second was refused at the lock, not after the first finished');
    assert.equal(journal.rows.size, 1);
  });

  it('holds the next bulk for 30 minutes after the manager answered an item unknown, and keeps watching it', async () => {
    manager.chequebookState = 'unknown';
    const first = await requested(toTarget(STAGE_NODE));
    const requestId = first.items[0]!.requestId;
    assert.deepEqual(
      first.items.map((one) => [one.state, one.settled, one.watched]),
      [['unknown', false, true]],
    );
    manager.chequebookState = 'submitted';
    const next = () => requested(toTarget(RUNG_NODE));

    assert.ok((await refusal(next())) instanceof FundingBusyError);
    clock.now += THIRTY_MINUTES;
    assert.ok((await refusal(next())) instanceof FundingBusyError);
    clock.now += 1;
    assert.equal((await next()).items[0]?.state, 'submitted');

    // Still watched: the manager settles it after all, from the chain or its chequebook history.
    manager.chequebookStatusAnswers.set(requestId, { state: 'confirmed', txHash: chequebookTxHash(requestId) });
    const refreshed = await funding.chequebookBulk(first.bulkId);
    assert.deepEqual(
      refreshed.items.map((one) => [one.state, one.settled, one.watched]),
      [['confirmed', true, false]],
    );
  });

  it("lets the next bulk through once a move has been submitted for longer than the manager's 30-minute receipt budget, and keeps watching it", async () => {
    // The manager holds the move submitted: it crashed in the middle of it, say, and an operator has yet to settle it.
    const first = await requested(toTarget(STAGE_NODE));
    const requestId = first.items[0]!.requestId;
    const next = () => requested(toTarget(STAGE_NODE));

    clock.now += THIRTY_MINUTES;
    assert.ok((await refusal(next())) instanceof FundingBusyError);
    assert.equal((await funding.view()).openChequebookBulkId, first.bulkId);

    clock.now += 1;
    assert.deepEqual(
      (await funding.chequebookBulk(first.bulkId)).items.map((one) => [one.state, one.settled, one.watched]),
      [['submitted', true, true]],
    );
    assert.equal((await funding.view()).openChequebookBulkId, null);
    // The manager refuses a second move on the node while the first is in flight there, and the item says so.
    manager.chequebookErrorAlways = managerFailure(
      'conflict',
      409,
      'Another chequebook move on this node is still under way.',
    );
    const second = await next();
    assert.deepEqual(
      second.items.map((one) => [one.state, one.error, one.settled, one.watched]),
      [['failed', 'The manager refused it: Another chequebook move on this node is still under way.', true, false]],
    );

    // Still asked about: once an operator settles the first in the manager, the admin reads it.
    const reads = manager.chequebookCalls.status;
    manager.chequebookJournalState.set(requestId, 'confirmed');
    const settled = await funding.chequebookBulk(first.bulkId);
    assert.equal(manager.chequebookCalls.status, reads + 1);
    assert.deepEqual(
      settled.items.map((one) => [one.state, one.settled, one.watched]),
      [['confirmed', true, false]],
    );
  });

  it('holds the next bulk for as long as an item is queued, the manager not having it yet, whatever its age', async () => {
    manager.chequebookErrorAlways = managerFailure('unreachable', null);
    manager.chequebookStatusError = managerFailure('unreachable', null);
    const first = await requested(toTarget(STAGE_NODE));
    assert.equal(first.items[0]?.state, 'queued');

    clock.now += 24 * 60 * 60 * 1000;
    const busy = await refusal(funding.chequebookOperations(TEST_OPERATOR, toTarget(RUNG_NODE)));

    assert.ok(busy instanceof FundingBusyError);
    assert.deepEqual(
      (await itemsOf(first.bulkId)).map((one) => [one.state, one.settled, one.watched]),
      [['queued', false, false]],
    );
  });

  it('counts the 30 minutes from the status read that finds a relay whose answer was lost', async () => {
    manager.chequebookErrorAlways = managerFailure('timeout', null);
    const first = await requested(toTarget(STAGE_NODE));
    const requestId = first.items[0]!.requestId;
    manager.chequebookErrorAlways = null;
    // The manager did journal it, and cannot tell whether the node made the move.
    manager.chequebookStatusAnswers.set(requestId, {
      state: 'unknown',
      error: 'The manager could not tell whether the node made the move.',
    });

    clock.now += 40 * 60 * 1000;
    const found = await funding.chequebookBulk(first.bulkId);
    assert.deepEqual(
      found.items.map((one) => [one.state, one.error, one.settled]),
      [['unknown', 'The manager could not tell whether the node made the move.', false]],
    );
    assert.equal(journal.get(requestId)?.relayedAt?.getTime(), clock.now);
    const next = () => requested(toTarget(RUNG_NODE));

    clock.now += THIRTY_MINUTES;
    assert.ok((await refusal(next())) instanceof FundingBusyError);
    clock.now += 1;
    assert.equal((await next()).items.length, 1);
  });

  it('does not wait on a send or a stamp bulk, nor they on it', async () => {
    const inventory = chequebookInventory();
    inventory.chain.postage = POSTAGE;
    inventory.stages[0]!.nodes[0]!.batch = fundingBatch();
    manager.inventoryAnswer = inventory;
    pins.set(NODE_A, WALLET_A);
    manager.relayState = 'submitted';
    manager.stampState = 'unknown';
    const topUp = {
      kind: 'topup',
      nodeId: NODE_A,
      batchId: BATCH_STAGE,
      expectedDepth: 20,
      days: 30,
      pricePerChunkPerBlockPlur: POSTAGE.pricePerChunkPerBlockPlur,
    } as const;

    // A send and a stamp bulk under way, and a chequebook bulk goes ahead beside them.
    const send = await funding.send(TEST_OPERATOR, [{ nodeId: NODE_A, kind: 'xdai', amount: '1' }]);
    const stampBulk = await funding.stampOperations(TEST_OPERATOR, [topUp]);
    await stamps.idle();
    const chequebookBulk = await requested(toTarget(STAGE_NODE));
    let view = await funding.view();
    assert.deepEqual(
      [view.openBulkId, view.openStampBulkId, view.openChequebookBulkId],
      [send.bulkId, stampBulk.bulkId, chequebookBulk.bulkId],
    );

    // And a send and a stamp bulk go ahead while the chequebook bulk is under way, once those before them settled.
    manager.statusAnswers.set(send.items[0]!.requestId, { state: 'confirmed', blockNumber: 7 });
    manager.stampStatusAnswers.set(stampBulk.items[0]!.requestId, { state: 'confirmed' });
    const nextSend = await funding.send(TEST_OPERATOR, [{ nodeId: NODE_A, kind: 'xdai', amount: '2' }]);
    manager.stampState = 'confirmed';
    await funding.stampOperations(TEST_OPERATOR, [topUp]);
    await stamps.idle();
    view = await funding.view();
    assert.deepEqual(
      [view.openBulkId, view.openStampBulkId, view.openChequebookBulkId],
      [nextSend.bulkId, null, chequebookBulk.bulkId],
    );
  });
});

describe('the relays behind the request', () => {
  it('lets a read of the bulk share the relays under way, and pick their outcome up once they end', async () => {
    build({ waitMs: 5 });
    let release!: () => void;
    manager.chequebookGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    manager.chequebookState = 'confirmed';

    const answer = await funding.chequebookOperations(TEST_OPERATOR, toTarget(STAGE_NODE, RUNG_NODE));
    // A read while the first relay waits on the node shares the run under way: no relay or read of its own.
    const meanwhile = await funding.chequebookBulk(answer.bulkId);
    assert.deepEqual(
      meanwhile.items.map((one) => one.state),
      ['queued', 'queued'],
    );
    assert.deepEqual(manager.chequebookCalls, { operation: 1, status: 0 });
    assert.equal((await funding.view()).openChequebookBulkId, answer.bulkId);

    release();
    await chequebooks.idle();

    const after = await funding.chequebookBulk(answer.bulkId);
    assert.deepEqual(
      after.items.map((one) => one.state),
      ['confirmed', 'confirmed'],
    );
    assert.equal(manager.chequebookRuns.length, 2);
    assert.equal((await funding.view()).openChequebookBulkId, null);
    // The operator's relays, though they ended after the request answered.
    assert.deepEqual(
      audit.withAction('funding.chequebook.confirmed').map((entry) => entry.actor),
      [TEST_OPERATOR, TEST_OPERATOR],
    );
  });
});

describe("the Funding page's open chequebook bulk", () => {
  it('names the chequebook bulk still under way, refreshed, until it settles', async () => {
    assert.equal((await funding.view()).openChequebookBulkId, null);
    const sent = await requested(toTarget(STAGE_NODE));
    const reads = manager.chequebookCalls.status;

    const open = await funding.view();
    assert.equal(open.openChequebookBulkId, sent.bulkId);
    assert.equal(open.openStampBulkId, null);
    assert.equal(open.openBulkId, null);
    assert.equal(manager.chequebookCalls.status, reads + 1, 'the view refreshed the open chequebook bulk');

    mined(sent);
    assert.equal((await funding.view()).openChequebookBulkId, null);
  });

  it('names it without asking the manager while funding is not set up', async () => {
    const sent = await requested(toTarget(STAGE_NODE));
    const reads = manager.chequebookCalls.status;
    build({ manager: null });

    assert.equal((await funding.view()).openChequebookBulkId, sent.bulkId);
    assert.equal(manager.chequebookCalls.status, reads);
  });
});

describe('the audit log of a chequebook request', () => {
  it('records the request with its target and its items, then each outcome with its hash', async () => {
    manager.chequebookState = 'confirmed';
    const sent = await requested(toTarget(STAGE_NODE, RUNG_NODE));
    const [stage, rung] = await journal.listBulk(sent.bulkId);

    const [request] = audit.withAction('funding.chequebook.request');
    assert.deepEqual(request?.actor, TEST_OPERATOR);
    assert.deepEqual(request?.details, {
      bulkId: sent.bulkId,
      targetPlur: TARGET,
      items: [stage, rung].map((row) => ({
        requestId: row?.requestId,
        nodeId: row?.nodeId,
        nodeLabel: row?.nodeLabel,
        direction: row?.direction,
        amountPlur: row?.amountPlur,
        availablePlur: row?.availablePlur,
      })),
    });
    const confirmed = audit.withAction('funding.chequebook.confirmed');
    assert.deepEqual(
      confirmed.map((entry) => [entry.actor, entry.details?.requestId, entry.details?.txHash, entry.details?.state]),
      [
        [TEST_OPERATOR, stage?.requestId, chequebookTxHash(stage?.requestId ?? ''), 'confirmed'],
        [TEST_OPERATOR, rung?.requestId, chequebookTxHash(rung?.requestId ?? ''), 'confirmed'],
      ],
    );
    assert.deepEqual(confirmed[1]?.details, {
      bulkId: sent.bulkId,
      requestId: rung?.requestId,
      nodeId: NODE_RUNG,
      nodeLabel: 'Main stage 720p rung',
      direction: 'withdraw',
      amountPlur: xbzz('1.25'),
      targetPlur: TARGET,
      availablePlur: xbzz('3.25'),
      txHash: chequebookTxHash(rung?.requestId ?? ''),
      state: 'confirmed',
      error: null,
    });
  });

  it('records a failure with its sentence', async () => {
    manager.chequebookErrors.set(0, managerFailure('chequebook_refused', 422, 'The node is not in a stage.'));
    await requested(toTarget(STAGE_NODE));

    const [failed] = audit.withAction('funding.chequebook.failed');
    assert.deepEqual(failed?.actor, TEST_OPERATOR);
    assert.equal(failed?.details?.error, 'The manager refused it: The node is not in a stage.');
    assert.equal(failed?.details?.direction, 'deposit');
    assert.equal(failed?.details?.txHash, null);
  });

  it('writes no row for a request refused before it was journalled', async () => {
    await refusal(funding.chequebookOperations(TEST_OPERATOR, toTarget(item(NODE_B, xbzz('3')))));

    assert.deepEqual(audit.entries, []);
  });
});

describe('the settled and watched flags of a chequebook item', () => {
  it('say for each state whether it holds up a new chequebook bulk, and whether it is still watched', async () => {
    const bulkId = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
    const cases = [
      { name: 'queued', state: 'queued', settled: false, watched: false },
      { name: 'old queued', state: 'queued', ageMs: 24 * 60 * 60 * 1000, settled: false, watched: false },
      { name: 'young submitted', state: 'submitted', settled: false, watched: false },
      { name: 'submitted at 30 minutes', state: 'submitted', ageMs: THIRTY_MINUTES, settled: false, watched: false },
      { name: 'old submitted', state: 'submitted', ageMs: THIRTY_MINUTES + 1, settled: true, watched: true },
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
        direction: 'deposit' as const,
        amountPlur: xbzz('0.5'),
        targetPlur: TARGET,
        availablePlur: xbzz('1.5'),
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

    const { items } = await funding.chequebookBulk(bulkId);

    assert.deepEqual(
      items.map((one, index) => [cases[index]?.name, one.settled, one.watched]),
      cases.map((one) => [one.name, one.settled, one.watched]),
    );
  });
});

describe('what a chequebook request relays', () => {
  it('is built from the journal alone, so a relay again carries the same fields as the first', async () => {
    manager.chequebookErrorAlways = managerFailure('unreachable', null);
    const sent = await requested(toTarget(RUNG_NODE));
    const [first] = manager.chequebookOperations;
    // The chequebook moves meanwhile, as the manager will find: the relay again still says what the operator asked.
    manager.inventoryAnswer = withNode(NODE_RUNG, (node) => {
      node.chequebook = fundingChequebook({ availablePlur: xbzz('9') });
    });
    manager.chequebookErrorAlways = null;

    await funding.chequebookBulk(sent.bulkId);

    const again: FundingChequebookOperationRequest | undefined = manager.chequebookOperations[1];
    assert.deepEqual(again, first);
    assert.deepEqual(again, {
      requestId: sent.items[0]?.requestId,
      nodeId: NODE_RUNG,
      direction: 'withdraw',
      amountPlur: xbzz('1.25'),
    });
  });

  it('never carries an address: Bee withdraws into the node’s own wallet', async () => {
    const inventory = chequebookInventory();
    inventory.stages[0]!.nodes.push(
      fundingNode({
        nodeId: 'stage-3:uploader',
        label: 'Third stage Bee node',
        walletAddress: WALLET_C,
        xdaiWei: '1',
        xbzzPlur: '0',
        chequebook: fundingChequebook({ availablePlur: xbzz('4') }),
      }),
    );
    manager.inventoryAnswer = inventory;

    await requested(toTarget(item('stage-3:uploader', xbzz('4'))));

    assert.deepEqual(Object.keys(manager.chequebookOperations[0] ?? {}).sort(), [
      'amountPlur',
      'direction',
      'nodeId',
      'requestId',
    ]);
  });
});
