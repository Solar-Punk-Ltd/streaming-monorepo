/**
 * The funding API's chequebook operations: a deposit into or a withdrawal from the chequebook of a stage's own Bee
 * node or a rung, checked against the inventory, then carried out by the manager's own chequebook path and journalled
 * there as requested by `web2-admin`; and its state, in the transfers' four, checked again through that path.
 *
 * Unit test, no database, no chain, no Docker and no Bee node: the real `ChequebookOperationsService` and
 * `ChequebookSubmission` over the in-memory chequebook journal, a fake node behind the preparation, a fake check of the
 * chain, and a fake inventory. Nothing reaches a network and no money moves. `pnpm test` in manager/.
 *
 * Every refusal comes before anything is journalled: 422 `chequebook_refused` with a sentence for a check that failed
 * or a move the chequebook path could not prepare, 404 `unknown_node` for a node the manager does not run, 409
 * `conflict` for another move under the same request id or another still under way on the node.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RECEIPT_POLL_BUDGET_MS,
  type ChequebookOperation,
  type ChequebookTransferIntent,
  chequebookPreflightSentence,
  chequebookRefusal,
  chequebookRefusalSentence,
} from '@streaming-infra-manager/common';
import {
  type FundingChequebook,
  type FundingChequebookOperationRequest,
  type FundingInventory,
  type FundingNode,
  type FundingNodeRole,
  type FundingTransferState,
  fundingChequebookOperationAnswerSchema,
  fundingChequebookOperationStatusSchema,
} from '@streaming-monorepo/contracts';

import { ChequebookOperationsService } from '../../src/domain/chequebook/ChequebookOperationsService.js';
import type { ChequebookReceiptCheck } from '../../src/domain/chequebook/ChequebookReceiptCheck.js';
import type { ChequebookRecovery } from '../../src/domain/chequebook/ChequebookRecovery.js';
import {
  ChequebookSubmission,
  type PreparedChequebookTransfer,
} from '../../src/domain/chequebook/ChequebookSubmission.js';
import { ChequebookJournalError } from '../../src/domain/errors/ChequebookJournalError.js';
import { ChequebookPreflightRefusedError } from '../../src/domain/errors/ChequebookPreflightRefusedError.js';
import { ChequebookPreparationError } from '../../src/domain/errors/ChequebookPreparationError.js';
import { ChequebookProfileChangedError } from '../../src/domain/errors/ChequebookProfileChangedError.js';
import { ChequebookTargetChangedError } from '../../src/domain/errors/ChequebookTargetChangedError.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';
import {
  FUNDING_CHEQUEBOOK_CHECK_MS,
  FundingChequebookService,
} from '../../src/domain/funding/FundingChequebookService.js';
import { FUNDING_BZZ_TOKEN } from '../../src/domain/funding/FundingInventoryService.js';
import { InMemoryChequebookOperations, transferContext } from '../support/chequebookOperations.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const CHEQUEBOOK = '0x3333333333333333333333333333333333333333';
const STAGE = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const STAGE_TWO = '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c';
const RUNG_ID = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d';
const CATALOGUE_ID = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf';
const NODE = `${STAGE}:bee-uploader`;
const GATEWAY = `${STAGE}:bee-gateway`;
const RUNG = `${RUNG_ID}:bee-uploader`;
const CATALOGUE = `${CATALOGUE_ID}:bee-uploader`;
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const OTHER_REQUEST = '8e2f3a4b-5c6d-4e7f-8a1b-c2d3e4f5a6b7';
const OPERATION_ID = '9f3a4b5c-6d7e-4f80-9b2c-d3e4f5a6b7c8';
const OTHER_OPERATION_ID = 'a04b5c6d-7e8f-4091-8c3d-e4f5a6b7c8d9';
const TX = `0x${'9a'.repeat(32)}`;
const START = Date.parse('2026-10-08T10:00:00.000Z');
/** 0.05 xBZZ: what brings the stage node's chequebook, 0.95 xBZZ available, to a target of 1 xBZZ. */
const DEPOSIT = '500000000000000';
/** 0.2 xBZZ: what brings the rung's chequebook, 1.2 xBZZ available, down to the same target. */
const WITHDRAWAL = '2000000000000000';
const NOT_KNOWN =
  'The manager could not tell whether the node made the move; its chequebook history in the manager can settle it.';

/** The Ethereum address each deployment's node signs with, so one node's open move does not hold another's. */
const NODE_ADDRESSES: Readonly<Record<string, string>> = {
  [STAGE]: `0x${'a1'.repeat(20)}`,
  [RUNG_ID]: `0x${'b2'.repeat(20)}`,
};

/** The deployments whose own Bee nodes the inventory lists, by node id. */
const DEPLOYMENTS: Readonly<Record<string, { name: string; instance_id: string }>> = {
  [NODE]: { name: 'stage-one', instance_id: STAGE },
  [RUNG]: { name: 'pool-720p', instance_id: RUNG_ID },
  [CATALOGUE]: { name: 'catalogue', instance_id: CATALOGUE_ID },
};

function chequebook(over: Partial<FundingChequebook> = {}): FundingChequebook {
  return {
    address: CHEQUEBOOK,
    availablePlur: '9500000000000000',
    totalPlur: '10000000000000000',
    readError: null,
    ...over,
  };
}

function node(nodeId: string, label: string, role: FundingNodeRole, over: Partial<FundingNode> = {}): FundingNode {
  return {
    nodeId,
    label,
    role,
    walletAddress: WALLET,
    xdaiWei: '1000000000000000000',
    xbzzPlur: '20000000000000000',
    readError: null,
    batch: null,
    chequebook: chequebook(),
    ...over,
  };
}

function rung(stage: string): FundingNode {
  return node(RUNG, `${stage} 720p rung, pool-720p`, 'rung', {
    chequebook: chequebook({ availablePlur: '12000000000000000', totalPlur: '12500000000000000' }),
  });
}

/** Two stages and the catalogue node; the pool's 720p rung is listed under both stages, as a shared pool is. */
function inventory(): FundingInventory {
  return {
    observedAt: '2026-10-08T10:00:00.000Z',
    chain: { chainId: 100, bzzToken: FUNDING_BZZ_TOKEN },
    stages: [
      {
        stageId: STAGE,
        name: 'stage-one',
        nodes: [
          node(NODE, 'stage-one Bee node', 'uploader'),
          node(GATEWAY, 'stage-one gateway', 'gateway'),
          rung('stage-one'),
        ],
      },
      { stageId: STAGE_TWO, name: 'stage-two', nodes: [rung('stage-two')] },
    ],
    catalogue: node(CATALOGUE, 'catalogue catalogue node', 'uploader'),
  };
}

/** The first listing of a node in the inventory, the one a check reads. */
function listed(answer: FundingInventory, nodeId: string): FundingNode {
  const found = answer.stages.flatMap((stage) => stage.nodes).find((each) => each.nodeId === nodeId);
  assert.ok(found, nodeId);
  return found;
}

/**
 * The node behind the chequebook path, faked: the preparation that reads it, its last check before sending, and the
 * one POST, which answers a transaction hash.
 */
class FakeNode {
  readonly prepared: ChequebookTransferIntent[] = [];
  readonly sent: string[] = [];
  prepareFailure: unknown = null;
  /** What each preparation in turn fails with, ahead of `prepareFailure`: null for one that does not fail. */
  prepareFailures: unknown[] = [];
  preflightFailure: unknown = null;
  sendFailure: unknown = null;
  /** While set, a preparation waits for it, as one over a slow connection to the node's container does. */
  held: Promise<void> | null = null;

  readonly prepare = async (intent: ChequebookTransferIntent): Promise<PreparedChequebookTransfer> => {
    this.prepared.push(intent);
    const failure = this.prepareFailures[this.prepared.length - 1] ?? this.prepareFailure;
    if (this.held) await this.held;
    if (failure) throw failure;
    return {
      dispose: () => undefined,
      context: { ...transferContext, nodeAddress: NODE_ADDRESSES[intent.profileInstanceId]! },
      preflight: async () => {
        if (this.preflightFailure) throw this.preflightFailure;
      },
      send: async (operation) => {
        this.sent.push(operation.requestId);
        if (this.sendFailure) throw this.sendFailure;
        return { transactionHash: TX };
      },
    };
  };
}

/**
 * The chequebook path's look at the chain for an operation, faked: the receipt check of a submitted one and the
 * recovery of a submitting or unknown one, each writing `finds` onto the row, failing, or waiting until it is let go.
 */
class FakeCheck {
  readonly runs: Array<'receipt' | 'recovery'> = [];
  finds: Partial<ChequebookOperation> = {};
  failure: unknown = null;
  held: Promise<void> | null = null;

  constructor(private readonly journal: InMemoryChequebookOperations) {}

  async run(kind: 'receipt' | 'recovery', id: string): Promise<ChequebookOperation> {
    this.runs.push(kind);
    if (this.held) await this.held;
    if (this.failure) throw this.failure;
    const row = this.journal.rows.get(id);
    assert.ok(row, id);
    this.journal.rows.set(id, { ...row, ...this.finds });
    return structuredClone(this.journal.rows.get(id)!);
  }
}

interface SetupOptions {
  edit?: (inventory: FundingInventory) => void;
  checkWaitMs?: number;
}

function setup(options: SetupOptions = {}) {
  let now = START;
  const clock = () => now;
  const journal = new InMemoryChequebookOperations({ now: clock });
  const fakeNode = new FakeNode();
  const check = new FakeCheck(journal);
  let inventoryReads = 0;
  let whileRead: () => void = () => undefined;
  const operations = new ChequebookOperationsService(
    journal,
    new ChequebookSubmission(journal, fakeNode.prepare),
    { check: (id: string) => check.run('receipt', id) } as unknown as ChequebookReceiptCheck,
    { recover: (id: string) => check.run('recovery', id) } as unknown as ChequebookRecovery,
  );
  const service = new FundingChequebookService({
    operations,
    inventory: {
      inventory: async () => {
        inventoryReads += 1;
        whileRead();
        const answer = inventory();
        options.edit?.(answer);
        return answer;
      },
    },
    deployment: async (nodeId) => DEPLOYMENTS[nodeId] ?? null,
    now: clock,
    ...(options.checkWaitMs === undefined ? {} : { checkWaitMs: options.checkWaitMs }),
  });
  return {
    service,
    journal,
    node: fakeNode,
    check,
    inventoryReads: () => inventoryReads,
    advance: (ms: number) => void (now += ms),
    /** Runs while the inventory is read, between the service's look at the journal and the chequebook path's. */
    whileInventoryIsRead: (action: () => void) => void (whileRead = action),
  };
}

function deposit(over: Partial<FundingChequebookOperationRequest> = {}): FundingChequebookOperationRequest {
  return { requestId: REQUEST, nodeId: NODE, direction: 'deposit', amountPlur: DEPOSIT, ...over };
}

function withdrawal(over: Partial<FundingChequebookOperationRequest> = {}): FundingChequebookOperationRequest {
  return { requestId: REQUEST, nodeId: RUNG, direction: 'withdraw', amountPlur: WITHDRAWAL, ...over };
}

async function refusedWith(promise: Promise<unknown>, code: string, expected?: RegExp | string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof FundingApiError, String(err));
    assert.equal(err.code, code);
    if (typeof expected === 'string') assert.equal(err.message, expected);
    else if (expected) assert.match(err.message, expected);
    return true;
  });
}

/** Holds the node's preparations, as a slow connection to its container would, until the function returned is called. */
function hold(bee: FakeNode): () => void {
  let release: () => void = () => undefined;
  bee.held = new Promise<void>((resolve) => (release = resolve));
  return release;
}

/** Only so a call that never gets where a test waits for it says so, instead of hanging the suite. */
const ARRIVAL_BUDGET_MS = 2_000;

/** Lets the calls under way run until `reached` holds. */
async function until(reached: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + ARRIVAL_BUDGET_MS;
  while (!reached()) {
    if (Date.now() > deadline)
      throw new Error(`waited ${ARRIVAL_BUDGET_MS} ms for ${description} and it never happened`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** What a call comes to while another is held, or a plain error when it has not answered within the budget. */
async function promptly<T>(call: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} had no answer after ${ARRIVAL_BUDGET_MS} ms`)),
          ARRIVAL_BUDGET_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** An operation of the funding API's as the journal holds it, a stage node's deposit, in whatever state is needed. */
function journalled(over: Partial<ChequebookOperation> = {}): ChequebookOperation {
  const at = new Date(START).toISOString();
  return {
    ...transferContext,
    id: OPERATION_ID,
    requestId: REQUEST,
    profileName: 'stage-one',
    profileInstanceId: STAGE,
    requestedBy: 'web2-admin',
    direction: 'deposit',
    amountPlur: DEPOSIT,
    nodeAddress: NODE_ADDRESSES[STAGE]!,
    state: 'submitted',
    transactionHash: TX,
    failureReason: null,
    dispatchStartedAt: at,
    revision: '2',
    receiptObservation: null,
    receiptCheckedAt: null,
    receiptPollUntil: new Date(START + RECEIPT_POLL_BUDGET_MS).toISOString(),
    recoveryObservation: null,
    recoveryCheckedAt: null,
    assertion: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function seed(journal: InMemoryChequebookOperations, operation: ChequebookOperation): void {
  journal.rows.set(operation.id, structuredClone(operation));
}

/** A journalled operation no transaction is known for yet. */
const open = (state: 'submitting' | 'unknown', over: Partial<ChequebookOperation> = {}) =>
  journalled({
    state,
    transactionHash: null,
    receiptPollUntil: null,
    failureReason: state === 'unknown' ? 'response_unavailable' : null,
    ...over,
  });

describe('POST /api/admin-funding/chequebook-operations', () => {
  it('moves a deposit through the chequebook path, recorded as web2-admin’s, and answers it submitted with its hash', async () => {
    const { journal, node: bee, service } = setup();
    const answer = await service.operate(deposit());
    assert.deepEqual(answer, { requestId: REQUEST, direction: 'deposit', state: 'submitted', txHash: TX });
    fundingChequebookOperationAnswerSchema.parse(answer);
    assert.deepEqual(bee.prepared, [
      {
        requestId: REQUEST,
        profileName: 'stage-one',
        profileInstanceId: STAGE,
        requestedBy: 'web2-admin',
        direction: 'deposit',
        amountPlur: DEPOSIT,
      },
    ]);
    assert.deepEqual(bee.sent, [REQUEST]);
    const rows = [...journal.rows.values()];
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0]!.requestedBy, rows[0]!.profileName, rows[0]!.state, rows[0]!.transactionHash],
      ['web2-admin', 'stage-one', 'submitted', TX],
    );
  });

  it('withdraws from a rung two stages list, through the rung’s own deployment, once', async () => {
    const { node: bee, service } = setup();
    assert.deepEqual(await service.operate(withdrawal()), {
      requestId: REQUEST,
      direction: 'withdraw',
      state: 'submitted',
      txHash: TX,
    });
    assert.equal(bee.prepared.length, 1);
    assert.deepEqual(
      [bee.prepared[0]!.profileName, bee.prepared[0]!.profileInstanceId, bee.prepared[0]!.direction],
      ['pool-720p', RUNG_ID, 'withdraw'],
    );
  });

  it('answers the same request again from the journal, reading no inventory and sending nothing again', async () => {
    let gone = false;
    const {
      inventoryReads,
      node: bee,
      service,
    } = setup({
      edit: (answer) => {
        if (gone) answer.stages = [];
      },
    });
    const first = await service.operate(deposit());
    const reads = inventoryReads();
    gone = true;
    assert.deepEqual(await service.operate(deposit()), first, 'a replay answers even once the node has gone');
    assert.equal(inventoryReads(), reads);
    assert.deepEqual(bee.sent, [REQUEST]);
  });

  it('refuses another move under a known request id, 409 conflict, sending nothing', async () => {
    const { node: bee, service } = setup();
    await service.operate(deposit());
    for (const other of [deposit({ amountPlur: '1' }), deposit({ direction: 'withdraw' }), deposit({ nodeId: RUNG })]) {
      await refusedWith(service.operate(other), 'conflict', /another chequebook operation/);
    }
    assert.deepEqual(bee.sent, [REQUEST]);
  });

  it('refuses a request id an operator’s own transfer was journalled under, 409 conflict', async () => {
    const { inventoryReads, journal, node: bee, service } = setup();
    seed(journal, journalled({ requestedBy: 'user:7' }));
    await refusedWith(service.operate(deposit()), 'conflict', /another chequebook operation/);
    assert.equal(inventoryReads(), 0);
    assert.deepEqual(bee.prepared, []);
  });

  it('refuses a node it does not list, 404 unknown_node, and a listed one whose deployment is gone', async () => {
    const { journal, node: bee, service } = setup();
    await refusedWith(service.operate(deposit({ nodeId: 'nobody:bee-uploader' })), 'unknown_node');
    const vanished = setup({
      edit: (answer) => void (answer.stages[0]!.nodes[0] = node(`${STAGE_TWO}:bee-uploader`, 'gone', 'uploader')),
    });
    await refusedWith(vanished.service.operate(deposit({ nodeId: `${STAGE_TWO}:bee-uploader` })), 'unknown_node');
    assert.equal(journal.rows.size + vanished.journal.rows.size, 0);
    assert.deepEqual([...bee.prepared, ...vanished.node.prepared], []);
  });

  it('refuses a gateway’s chequebook and the catalogue node’s, which no stage lists, 422 chequebook_refused', async () => {
    const { journal, node: bee, service } = setup();
    for (const nodeId of [GATEWAY, CATALOGUE]) {
      await refusedWith(
        service.operate(deposit({ nodeId })),
        'chequebook_refused',
        'This manager moves only the chequebook of a stage’s Bee node or a rung.',
      );
    }
    assert.equal(journal.rows.size, 0);
    assert.deepEqual(bee.prepared, []);
  });

  it('moves the catalogue node’s chequebook where a stage lists that node as its own', async () => {
    const { node: bee, service } = setup({
      edit: (answer) => void (answer.catalogue = node(NODE, 'stage-one catalogue node', 'uploader')),
    });
    assert.equal((await service.operate(deposit())).state, 'submitted');
    assert.deepEqual(bee.sent, [REQUEST]);
  });

  const refusals: Array<
    [string, () => FundingChequebookOperationRequest, (inventory: FundingInventory) => void, RegExp]
  > = [
    [
      'a node whose wallet could not be read, with the reason',
      () => deposit(),
      (answer) =>
        void Object.assign(listed(answer, NODE), {
          walletAddress: null,
          xdaiWei: null,
          xbzzPlur: null,
          readError: 'The node could not be reached.',
        }),
      /wallet could not be read, so whether it can pay is not known\. The node could not be reached\.$/,
    ],
    [
      'a node that answered it has no chequebook',
      () => deposit(),
      (answer) => void (listed(answer, NODE).chequebook = null),
      /has no chequebook/,
    ],
    [
      'a chequebook that could not be read, with the reason',
      () => withdrawal(),
      (answer) =>
        void (listed(answer, RUNG).chequebook = {
          address: null,
          availablePlur: null,
          totalPlur: null,
          readError: 'The node did not answer in time.',
        }),
      /chequebook could not be read, so the move is not made now\. The node did not answer in time\.$/,
    ],
    [
      'a node an older inventory read no chequebook of',
      () => deposit(),
      (answer) => void delete listed(answer, NODE).chequebook,
      /chequebook could not be read, so the move is not made now\.$/,
    ],
    [
      'a deposit over the wallet’s xBZZ, in exact xBZZ',
      () => deposit(),
      (answer) => void (listed(answer, NODE).xbzzPlur = (BigInt(DEPOSIT) - 1n).toString()),
      /wallet holds 0\.0499999999999999 xBZZ, less than the 0\.05 xBZZ this deposit moves\./,
    ],
    [
      'a withdrawal over what the chequebook has available, in exact xBZZ',
      () => withdrawal(),
      (answer) =>
        void (listed(answer, RUNG).chequebook = chequebook({ availablePlur: (BigInt(WITHDRAWAL) - 1n).toString() })),
      /chequebook has 0\.1999999999999999 xBZZ available, less than the 0\.2 xBZZ this withdrawal moves\./,
    ],
    [
      'a deposit from a wallet with no xDAI for the gas',
      () => deposit(),
      (answer) => void (listed(answer, NODE).xdaiWei = '0'),
      /no xDAI to pay the gas with/,
    ],
    [
      'a withdrawal from a wallet with no xDAI for the gas',
      () => withdrawal(),
      (answer) => void (listed(answer, RUNG).xdaiWei = '0'),
      /no xDAI to pay the gas with/,
    ],
  ];
  for (const [what, request, edit, pattern] of refusals) {
    it(`refuses ${what}, 422 chequebook_refused, journalling nothing and preparing nothing`, async () => {
      const { journal, node: bee, service } = setup({ edit });
      await refusedWith(service.operate(request()), 'chequebook_refused', pattern);
      assert.equal(journal.rows.size, 0);
      assert.deepEqual(bee.prepared, []);
    });
  }

  it('takes a deposit of all the wallet’s xBZZ, and a withdrawal of all the chequebook has available', async () => {
    const all = setup({ edit: (answer) => void (listed(answer, NODE).xbzzPlur = DEPOSIT) });
    assert.equal((await all.service.operate(deposit())).state, 'submitted');
    const available = setup({
      edit: (answer) => void (listed(answer, RUNG).chequebook = chequebook({ availablePlur: WITHDRAWAL })),
    });
    assert.equal((await available.service.operate(withdrawal())).state, 'submitted');
  });

  it('answers 409 conflict for a node with another move still under way, adding nothing to the journal', async () => {
    const { journal, node: bee, service } = setup();
    seed(journal, journalled({ id: OTHER_OPERATION_ID, requestId: OTHER_REQUEST, requestedBy: 'user:7' }));
    await refusedWith(
      service.operate(deposit()),
      'conflict',
      'Another chequebook move on this node is still under way.',
    );
    assert.equal(journal.rows.size, 1);
    assert.deepEqual(bee.sent, []);
  });

  it('refuses what the chequebook path could not prepare with its own sentence for the cause, journalling nothing', async () => {
    const cases: Array<[string, unknown, string]> = [
      [
        'a Bee container that is not running',
        new ChequebookPreparationError('bee_container_not_found'),
        chequebookRefusalSentence(chequebookRefusal('bee_container_not_found')),
      ],
      [
        'a Bee image the bridge check failed',
        new ChequebookPreparationError('bridge_not_qualified', 'dev_tcp'),
        chequebookRefusalSentence(chequebookRefusal('bridge_not_qualified', 'dev_tcp')),
      ],
      [
        'a failure that says nothing of its cause',
        new Error('socket closed'),
        chequebookRefusalSentence(chequebookRefusal('unavailable')),
      ],
      [
        'a deployment removed or replaced while it was prepared',
        new ChequebookProfileChangedError(),
        'The node’s deployment was removed or replaced. Nothing was sent.',
      ],
    ];
    for (const [what, failure, sentence] of cases) {
      const { journal, node: bee, service } = setup();
      bee.prepareFailure = failure;
      await refusedWith(service.operate(deposit()), 'chequebook_refused', sentence);
      assert.match(sentence, / Nothing was sent\.$/, what);
      assert.equal(journal.rows.size, 0, what);
      assert.deepEqual(bee.sent, [], what);
    }
  });

  it('refuses a move whose deployment changed as it was journalled, with the manager’s sentence for that', async () => {
    const { journal, node: bee, service } = setup();
    journal.admit = async () => {
      throw new ChequebookTargetChangedError();
    };
    await refusedWith(
      service.operate(deposit()),
      'chequebook_refused',
      chequebookRefusalSentence(chequebookRefusal('target_changed')),
    );
    assert.deepEqual(bee.sent, []);
  });

  it('leaves a journal it cannot read or write as the manager’s own error, never a refusal', async () => {
    const unwritable = setup();
    unwritable.journal.admit = async () => {
      throw new Error('connection terminated');
    };
    await assert.rejects(unwritable.service.operate(deposit()), ChequebookJournalError);
    assert.deepEqual(unwritable.node.sent, []);
    const unreadable = setup();
    unreadable.journal.findByRequestId = async () => {
      throw new Error('connection terminated');
    };
    await assert.rejects(unreadable.service.operate(deposit()), ChequebookJournalError);
    assert.equal(unreadable.inventoryReads(), 0);
  });

  it('answers a move the last check refused before sending it failed, and one whose answer was lost unknown', async () => {
    const refused = setup();
    refused.node.preflightFailure = new ChequebookPreflightRefusedError('preflight_no_gas');
    assert.deepEqual(await refused.service.operate(deposit()), {
      requestId: REQUEST,
      direction: 'deposit',
      state: 'failed',
      txHash: null,
    });
    assert.deepEqual(refused.node.sent, []);
    const lost = setup();
    lost.node.sendFailure = new Error('socket hang up');
    assert.deepEqual(await lost.service.operate(deposit()), {
      requestId: REQUEST,
      direction: 'deposit',
      state: 'unknown',
      txHash: null,
    });
    assert.deepEqual(lost.node.sent, [REQUEST]);
  });

  it('answers the state of a request another call journalled while the inventory was read, or a conflict', async () => {
    const same = setup();
    same.whileInventoryIsRead(() => seed(same.journal, open('submitting')));
    assert.deepEqual(await same.service.operate(deposit()), {
      requestId: REQUEST,
      direction: 'deposit',
      state: 'submitted',
      txHash: null,
    });
    const other = setup();
    other.whileInventoryIsRead(() => seed(other.journal, open('submitting', { amountPlur: '1' })));
    await refusedWith(other.service.operate(deposit()), 'conflict', /another chequebook operation/);
    assert.deepEqual([...same.node.prepared, ...other.node.prepared], [], 'the chequebook path prepared neither');
  });
});

describe('GET /api/admin-funding/chequebook-operations/:requestId', () => {
  it('answers 404 unknown_request for a request id never journalled, and for an operator’s own transfer', async () => {
    const { journal, service } = setup();
    await refusedWith(service.status(REQUEST), 'unknown_request', /safe/);
    seed(journal, journalled({ requestedBy: 'user:7' }));
    await refusedWith(service.status(REQUEST), 'unknown_request');
  });

  it('answers each journal state in the transfers’ four, with a sentence for one that failed or is not known', async () => {
    const cases: Array<[string, ChequebookOperation, FundingTransferState, string | null]> = [
      ['a submitted move, while its receipt is polled', journalled(), 'submitted', null],
      ['a move being submitted', open('submitting'), 'submitted', null],
      ['a settled move', journalled({ state: 'settled' }), 'confirmed', null],
      ['a reverted move', journalled({ state: 'reverted' }), 'failed', 'The chain reverted the move; nothing moved.'],
      [
        'a deposit the last check refused for no gas',
        journalled({ state: 'rejected', transactionHash: null, failureReason: 'preflight_no_gas' }),
        'failed',
        chequebookPreflightSentence('preflight_no_gas', 'deposit'),
      ],
      [
        'a withdrawal the last check found the chequebook short for',
        journalled({
          state: 'rejected',
          direction: 'withdraw',
          transactionHash: null,
          failureReason: 'preflight_insufficient_balance',
        }),
        'failed',
        chequebookPreflightSentence('preflight_insufficient_balance', 'withdraw'),
      ],
      [
        'a move the last check refused otherwise',
        journalled({ state: 'rejected', transactionHash: null, failureReason: 'preflight_failed' }),
        'failed',
        chequebookPreflightSentence('preflight_failed', 'deposit'),
      ],
      [
        'a move an operator recorded as never made',
        journalled({ state: 'asserted', transactionHash: null }),
        'failed',
        'An operator recorded in the manager that the move was never made.',
      ],
      ['a move whose answer was lost', open('unknown'), 'unknown', NOT_KNOWN],
      [
        'a settled move whose transaction another operation’s evidence names too',
        journalled({ state: 'settled', failureReason: 'hash_conflict' }),
        'unknown',
        NOT_KNOWN,
      ],
    ];
    for (const [what, row, state, error] of cases) {
      const { journal, service } = setup();
      seed(journal, row);
      const answer = await service.status(REQUEST);
      assert.deepEqual(
        answer,
        { requestId: REQUEST, direction: row.direction, state, txHash: row.transactionHash, error, mined: false },
        what,
      );
      fundingChequebookOperationStatusSchema.parse(answer);
    }
  });

  it('answers mined while a submitted move’s block is not final yet, and not before it is mined nor once it has an outcome', async () => {
    const awaitingFinality = { kind: 'pending', reason: 'awaiting_finality' } as const;
    const settledReceipt = {
      kind: 'settled',
      receiptBlockNumber: '520',
      receiptBlockHash: `0x${'78'.repeat(32)}`,
      finalizedBlockNumber: '560',
      finalizedBlockHash: `0x${'9b'.repeat(32)}`,
    } as const;
    const cases: Array<[string, ChequebookOperation, FundingTransferState, boolean]> = [
      ['a submitted move whose receipt was not looked for yet', journalled(), 'submitted', false],
      [
        'a submitted move the chain has not taken yet',
        journalled({ receiptObservation: { kind: 'pending', reason: 'awaiting_transaction' } }),
        'submitted',
        false,
      ],
      [
        'a submitted move with no receipt yet',
        journalled({ receiptObservation: { kind: 'pending', reason: 'awaiting_receipt' } }),
        'submitted',
        false,
      ],
      [
        'a submitted move whose block is not final yet',
        journalled({ receiptObservation: awaitingFinality }),
        'submitted',
        true,
      ],
      [
        'a submitted move whose last look at the chain could not be made',
        journalled({ receiptObservation: { kind: 'could_not_check', reason: 'rpc_unavailable' } }),
        'submitted',
        false,
      ],
      ['a settled move', journalled({ state: 'settled', receiptObservation: settledReceipt }), 'confirmed', false],
      [
        'a reverted move',
        journalled({ state: 'reverted', receiptObservation: { ...settledReceipt, kind: 'reverted' } }),
        'failed',
        false,
      ],
      [
        'a submitted move whose transaction another operation’s evidence names too',
        journalled({ failureReason: 'hash_conflict', receiptObservation: awaitingFinality }),
        'unknown',
        false,
      ],
    ];
    for (const [what, row, state, mined] of cases) {
      const { check, journal, service } = setup();
      seed(journal, row);
      const answer = await service.status(REQUEST);
      assert.deepEqual([answer.state, answer.txHash, answer.mined], [state, TX, mined], what);
      fundingChequebookOperationStatusSchema.parse(answer);
      assert.deepEqual(check.runs, [], `${what}: answered from the journal, the receipt polled by the manager`);
    }
  });

  it('answers mined from what the receipt check found, then confirmed once the block is final', async () => {
    const { advance, check, journal, service } = setup();
    seed(journal, journalled({ receiptPollUntil: null }));
    check.finds = { receiptObservation: { kind: 'pending', reason: 'awaiting_finality' } };
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      direction: 'deposit',
      state: 'submitted',
      txHash: TX,
      error: null,
      mined: true,
    });
    advance(FUNDING_CHEQUEBOOK_CHECK_MS);
    check.finds = {
      state: 'settled',
      receiptObservation: {
        kind: 'settled',
        receiptBlockNumber: '520',
        receiptBlockHash: `0x${'78'.repeat(32)}`,
        finalizedBlockNumber: '560',
        finalizedBlockHash: `0x${'9b'.repeat(32)}`,
      },
    };
    const confirmed = await service.status(REQUEST);
    assert.deepEqual([confirmed.state, confirmed.mined], ['confirmed', false]);
    assert.deepEqual(check.runs, ['receipt', 'receipt']);
  });

  it('has the chequebook path check a submitting or unknown move first, and answers what it found', async () => {
    const { check, journal, service } = setup();
    seed(journal, open('unknown'));
    check.finds = { state: 'submitted', transactionHash: TX, failureReason: null };
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      direction: 'deposit',
      state: 'submitted',
      txHash: TX,
      error: null,
      mined: false,
    });
    assert.deepEqual(check.runs, ['recovery']);
  });

  it('checks a submitted move only once the manager’s receipt polling of it is over, or when it had none', async () => {
    const { advance, check, journal, service } = setup();
    seed(journal, journalled());
    check.finds = { state: 'settled' };
    assert.equal((await service.status(REQUEST)).state, 'submitted');
    assert.deepEqual(check.runs, [], 'the manager polls its receipt itself until then');
    advance(RECEIPT_POLL_BUDGET_MS);
    assert.equal((await service.status(REQUEST)).state, 'confirmed');
    assert.deepEqual(check.runs, ['receipt']);
    const unpolled = setup();
    seed(unpolled.journal, journalled({ receiptPollUntil: null }));
    await unpolled.service.status(REQUEST);
    assert.deepEqual(unpolled.check.runs, ['receipt']);
  });

  it('checks a request id at most once every thirty seconds, answering the journal in between', async () => {
    const { advance, check, journal, service } = setup();
    seed(journal, open('unknown'));
    await service.status(REQUEST);
    advance(FUNDING_CHEQUEBOOK_CHECK_MS - 1);
    await service.status(REQUEST);
    await service.status(REQUEST);
    assert.equal(check.runs.length, 1);
    advance(1);
    await service.status(REQUEST);
    assert.equal(check.runs.length, 2);
  });

  it('answers the journal as it stands when the check fails', async () => {
    const { check, journal, service } = setup();
    seed(journal, open('unknown'));
    check.failure = new ChequebookJournalError();
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      direction: 'deposit',
      state: 'unknown',
      txHash: null,
      error: NOT_KNOWN,
      mined: false,
    });
  });

  it('answers the journal as it stands while a check runs past the wait, and what it found once it has', async () => {
    const { check, journal, service } = setup({ checkWaitMs: 5 });
    seed(journal, open('unknown'));
    let release: () => void = () => undefined;
    check.held = new Promise<void>((resolve) => (release = resolve));
    check.finds = {
      state: 'submitted',
      transactionHash: TX,
      failureReason: null,
      receiptPollUntil: new Date(START + RECEIPT_POLL_BUDGET_MS).toISOString(),
    };
    assert.equal((await service.status(REQUEST)).state, 'unknown');
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      direction: 'deposit',
      state: 'submitted',
      txHash: TX,
      error: null,
      mined: false,
    });
    assert.deepEqual(check.runs, ['recovery'], 'the check that ran on is the only one');
  });

  it('answers a settled or failed move as journalled, checking nothing', async () => {
    for (const row of [
      journalled({ state: 'settled' }),
      journalled({ state: 'reverted' }),
      journalled({ state: 'asserted', transactionHash: null }),
    ]) {
      const { advance, check, journal, service } = setup();
      seed(journal, row);
      advance(RECEIPT_POLL_BUDGET_MS);
      await service.status(REQUEST);
      assert.deepEqual(check.runs, [], row.state);
    }
  });
});

/**
 * The chequebook path journals a move only once it has prepared it, so until then the manager knows a request by the
 * call under way. The web2 admin sends an item again under the same id when the `GET` answers `unknown_request`, as
 * it does after its first send lost its answer; the call under way must neither be taken for one never received nor
 * run beside a second.
 */
describe('a request id whose call is still under way', () => {
  const submittedDeposit = { requestId: REQUEST, direction: 'deposit', state: 'submitted', txHash: TX };

  it('answers the GET submitted, with no hash and no error, while the move is still being prepared', async () => {
    const { check, node: bee, service } = setup();
    const release = hold(bee);
    const call = service.operate(withdrawal());
    await until(() => bee.prepared.length === 1, 'the withdrawal to be prepared');
    const answer = await service.status(REQUEST);
    assert.deepEqual(answer, {
      requestId: REQUEST,
      direction: 'withdraw',
      state: 'submitted',
      txHash: null,
      error: null,
      mined: false,
    });
    fundingChequebookOperationStatusSchema.parse(answer);
    assert.deepEqual(check.runs, [], 'nothing journalled, so nothing to check');
    release();
    assert.equal((await call).txHash, TX);
    assert.deepEqual(await service.status(REQUEST), { ...answer, txHash: TX }, 'the journal answers once it holds it');
  });

  it('has the same request sent again wait for the call under way and answer alike, prepared and sent once', async () => {
    const { inventoryReads, journal, node: bee, service } = setup();
    // A preparation beside the first would fail for a passing cause, as a second connection to the node might.
    bee.prepareFailures = [null, new ChequebookPreparationError('chain_unreachable')];
    const release = hold(bee);
    const first = service.operate(deposit());
    await until(() => bee.prepared.length === 1, 'the deposit to be prepared');
    const again = service.operate(deposit());
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.deepEqual(await Promise.all([first, again]), [submittedDeposit, submittedDeposit]);
    assert.equal(bee.prepared.length, 1, 'the chequebook path prepared it once');
    assert.deepEqual(bee.sent, [REQUEST]);
    assert.equal(inventoryReads(), 1);
    assert.equal(journal.rows.size, 1);
    const [row] = [...journal.rows.values()];
    journal.rows.set(row!.id, { ...row!, state: 'settled' });
    assert.equal(
      (await service.operate(deposit())).state,
      'confirmed',
      'once answered, the id is freed: the journal answers as it stands now',
    );
  });

  it('answers another move under the id 409 conflict at once, reading and preparing nothing for it', async () => {
    const { inventoryReads, node: bee, service } = setup();
    const release = hold(bee);
    const first = service.operate(deposit());
    await until(() => bee.prepared.length === 1, 'the deposit to be prepared');
    for (const other of [deposit({ amountPlur: '1' }), deposit({ direction: 'withdraw' }), deposit({ nodeId: RUNG })]) {
      await refusedWith(
        promptly(service.operate(other), `another move, ${JSON.stringify(other)},`),
        'conflict',
        'This request id names another chequebook operation.',
      );
    }
    assert.equal(inventoryReads(), 1);
    assert.equal(bee.prepared.length, 1);
    release();
    assert.deepEqual(await first, submittedDeposit);
    assert.deepEqual(bee.sent, [REQUEST]);
  });

  it('refuses the same request sent again as the call under way was refused, preparing once', async () => {
    const { journal, node: bee, service } = setup();
    // The first preparation fails for a passing cause; a second, were there one, would not.
    bee.prepareFailures = [new ChequebookPreparationError('chain_unreachable')];
    const release = hold(bee);
    const first = service.operate(deposit());
    await until(() => bee.prepared.length === 1, 'the deposit to be prepared');
    const again = service.operate(deposit());
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const sentence = chequebookRefusalSentence(chequebookRefusal('chain_unreachable'));
    await Promise.all([
      refusedWith(first, 'chequebook_refused', sentence),
      refusedWith(again, 'chequebook_refused', sentence),
    ]);
    assert.equal(bee.prepared.length, 1);
    assert.deepEqual(bee.sent, []);
    assert.equal(journal.rows.size, 0);
    await refusedWith(service.status(REQUEST), 'unknown_request', /safe/);
    assert.deepEqual(
      await service.operate(deposit()),
      submittedDeposit,
      'once refused, the id is freed: sent again, it runs',
    );
    assert.equal(bee.prepared.length, 2);
  });
});
