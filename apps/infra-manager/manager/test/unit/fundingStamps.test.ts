/**
 * The funding API's stamp operations: a top-up or a dilution of the batch one of the manager's nodes uploads with,
 * checked against the inventory and the postage contract, journalled, then asked of the node once; and its state,
 * settled from the postage contract when the node's answer was lost.
 *
 * Unit test, no database, no chain and no Bee node: a fake inventory with batches, a fake postage contract, an
 * in-memory journal, and a fake node, or the real BeeClient over a faked fetch where how its errors read matters.
 * Nothing reaches a network and no money moves. `pnpm test` in manager/.
 *
 * Every refusal is answered before anything is journalled or asked: 422 `stamp_refused` with a sentence for a check
 * that failed, 404 `unknown_node` for a node the manager does not run, 502 `chain_unreachable` when the postage
 * contract cannot be read.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { encodeAbiParameters } from 'viem';

import type { BeeStampTransaction } from '@streaming-infra-manager/common';
import type {
  FundingBatch,
  FundingInventory,
  FundingNode,
  FundingNodeRole,
  FundingStampDiluteRequest,
  FundingStampOperationRequest,
  FundingStampTopUpRequest,
} from '@streaming-monorepo/contracts';

import { BeeClient } from '../../src/domain/BeeClient.js';
import { BeeHttpError } from '../../src/domain/errors/BeeHttpError.js';
import { ChainReadError } from '../../src/domain/errors/ChainReadError.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';
import { FUNDING_STATUS_READ_MS, FUNDING_UNKNOWN_AFTER_MS } from '../../src/domain/funding/FundingChainService.js';
import { FUNDING_BZZ_TOKEN } from '../../src/domain/funding/FundingInventoryService.js';
import type { FundingStampOperationRow } from '../../src/domain/funding/FundingStampOperationJournal.js';
import {
  FUNDING_DILUTE_MIN_SECONDS,
  type FundingStampNode,
  FundingStampService,
} from '../../src/domain/funding/FundingStampService.js';
import { FUNDING_POSTAGE_STAMP, type PostageContractReader } from '../../src/domain/funding/postageStamp.js';
import { InMemoryFundingStampOperationJournal } from '../support/InMemoryFundingStampOperationJournal.js';

const DAY = 86_400;
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const STAGE = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const STAGE_TWO = '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c';
const RUNG_ID = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d';
const CATALOGUE_ID = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf';
const NODE = `${STAGE}:bee-uploader`;
const GATEWAY = `${STAGE}:bee-gateway`;
const RUNG = `${RUNG_ID}:bee-uploader`;
const CATALOGUE = `${CATALOGUE_ID}:bee-uploader`;
const BATCH = `0x${'ab'.repeat(32)}`;
const RUNG_BATCH = `0x${'cd'.repeat(32)}`;
const CATALOGUE_BATCH = `0x${'ef'.repeat(32)}`;
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const TX = `0x${'9a'.repeat(32)}`;
/** A day at 24000 PLUR a chunk a block: 17280 blocks of it. */
const AMOUNT = '414720000';
/** That amount for each of a depth 22 batch's 2^22 chunks, in PLUR: 0.173946175488 xBZZ. */
const COST = (414_720_000n * 2n ** 22n).toString();
const BALANCE_BEFORE = 9_000_000_000_000n;
const START = Date.parse('2026-10-08T10:00:00.000Z');
/** Where the fake nodes' Bee APIs are, on names that resolve nowhere. */
const APIS: Readonly<Record<string, string>> = {
  [NODE]: 'http://stage-one-node.invalid:1633',
  [RUNG]: 'http://pool-720p.invalid:1633',
  [CATALOGUE]: 'http://catalogue.invalid:1633',
};

function batch(batchId: string, over: Partial<FundingBatch> = {}): FundingBatch {
  return {
    batchId,
    depth: 22,
    immutable: true,
    usable: true,
    ttlSeconds: 30 * DAY,
    fillRatio: 0.25,
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
    xbzzPlur: '50000000000000000',
    readError: null,
    batch: null,
    ...over,
  };
}

/** Two stages and the catalogue node; the pool's 720p rung is listed under both stages, as a shared pool is. */
function inventory(): FundingInventory {
  return {
    observedAt: '2026-10-08T10:00:00.000Z',
    chain: {
      chainId: 100,
      bzzToken: FUNDING_BZZ_TOKEN,
      postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
    },
    stages: [
      {
        stageId: STAGE,
        name: 'stage-one',
        nodes: [
          node(NODE, 'stage-one Bee node', 'uploader', { batch: batch(BATCH) }),
          node(GATEWAY, 'stage-one gateway', 'gateway'),
          node(RUNG, 'stage-one 720p rung, pool-720p', 'rung', { batch: batch(RUNG_BATCH, { depth: 21 }) }),
        ],
      },
      {
        stageId: STAGE_TWO,
        name: 'stage-two',
        nodes: [node(RUNG, 'stage-two 720p rung, pool-720p', 'rung', { batch: batch(RUNG_BATCH, { depth: 21 }) })],
      },
    ],
    catalogue: node(CATALOGUE, 'catalogue catalogue node', 'uploader', {
      batch: batch(CATALOGUE_BATCH, { depth: 20 }),
    }),
  };
}

/** The getter's outputs, to encode the fake contract's answers with. */
const BATCH_OUTPUTS = [
  { name: 'owner', type: 'address' },
  { name: 'depth', type: 'uint8' },
  { name: 'bucketDepth', type: 'uint8' },
  { name: 'immutableFlag', type: 'bool' },
  { name: 'normalisedBalance', type: 'uint256' },
  { name: 'lastUpdatedBlockNumber', type: 'uint256' },
] as const;
const NO_OWNER = '0x0000000000000000000000000000000000000000';

interface ChainBatch {
  owner: string;
  depth: number;
  normalisedBalance: bigint;
}

/** The postage contract, as `batches(id)` answers it through `eth_call`. */
class FakeChain implements PostageContractReader {
  readonly batches = new Map<string, ChainBatch>([
    [BATCH, { owner: WALLET, depth: 22, normalisedBalance: BALANCE_BEFORE }],
    [RUNG_BATCH, { owner: WALLET, depth: 21, normalisedBalance: BALANCE_BEFORE }],
    [CATALOGUE_BATCH, { owner: WALLET, depth: 20, normalisedBalance: BALANCE_BEFORE }],
  ]);
  down = false;
  garbled = false;
  reads = 0;

  async call(to: string, data: string): Promise<string> {
    this.reads += 1;
    if (this.down) throw new ChainReadError();
    assert.equal(to, FUNDING_POSTAGE_STAMP);
    assert.equal(data.slice(0, 10), '0xc81e25ab', 'batches(bytes32)');
    if (this.garbled) return '0x1234';
    const held = this.batches.get(`0x${data.slice(10)}`);
    return encodeAbiParameters(BATCH_OUTPUTS, [
      (held?.owner ?? NO_OWNER) as `0x${string}`,
      held?.depth ?? 0,
      16,
      true,
      held?.normalisedBalance ?? 0n,
      39_000_000n,
    ]);
  }

  /** What a landed top-up or dilution leaves the batch with. */
  change(batchId: string, over: Partial<ChainBatch>): void {
    this.batches.set(batchId, { ...this.batches.get(batchId)!, ...over });
  }
}

interface NodeCall {
  apiUrl: string;
  kind: 'topup' | 'dilute';
  batchId: string;
  value: string | number;
}

/** The nodes' Bee APIs: what each was asked, and one answer for all of them. */
class FakeNodes {
  readonly calls: NodeCall[] = [];
  answer: () => Promise<BeeStampTransaction> = async () => ({ batchID: BATCH.slice(2), txHash: TX });
  /** Called as the node is asked, to look at the journal then. */
  onCall: () => Promise<void> | void = () => undefined;

  at(apiUrl: string): FundingStampNode {
    return {
      topUpStamp: async (batchId, amount) => {
        this.calls.push({ apiUrl, kind: 'topup', batchId, value: amount });
        await this.onCall();
        return this.answer();
      },
      diluteStamp: async (batchId, depth) => {
        this.calls.push({ apiUrl, kind: 'dilute', batchId, value: depth });
        await this.onCall();
        return this.answer();
      },
    };
  }
}

interface SetupOptions {
  edit?: (inventory: FundingInventory) => void;
  chain?: FakeChain | null;
  journal?: InMemoryFundingStampOperationJournal;
  /** The real BeeClient, over whatever fetch the test fakes, instead of the fake nodes. */
  realClient?: boolean;
}

function setup(options: SetupOptions = {}) {
  const chain = options.chain === undefined ? new FakeChain() : options.chain;
  const journal = options.journal ?? new InMemoryFundingStampOperationJournal();
  const nodes = new FakeNodes();
  let inventoryReads = 0;
  let now = START;
  const service = new FundingStampService({
    journal,
    inventory: {
      inventory: async () => {
        inventoryReads += 1;
        const answer = inventory();
        options.edit?.(answer);
        return answer;
      },
    },
    nodeApiUrl: async (nodeId) => APIS[nodeId] ?? null,
    node: (apiUrl) => (options.realClient ? new BeeClient(apiUrl) : nodes.at(apiUrl)),
    chain,
    now: () => now,
  });
  return {
    service,
    journal,
    chain: chain as FakeChain,
    nodes,
    inventoryReads: () => inventoryReads,
    advance: (ms: number) => void (now += ms),
  };
}

function topUp(over: Partial<FundingStampTopUpRequest> = {}): FundingStampTopUpRequest {
  return {
    requestId: REQUEST,
    kind: 'topup',
    nodeId: NODE,
    batchId: BATCH,
    expectedDepth: 22,
    amountPerChunkPlur: AMOUNT,
    ...over,
  };
}

function dilute(over: Partial<FundingStampDiluteRequest> = {}): FundingStampDiluteRequest {
  return { requestId: REQUEST, kind: 'dilute', nodeId: NODE, batchId: BATCH, expectedDepth: 22, newDepth: 23, ...over };
}

async function refusedWith(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof FundingApiError, String(err));
    assert.equal(err.code, code);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

/** A row as a manager that stopped between the journal and the node's answer leaves it. */
function journalled(over: Partial<FundingStampOperationRow> = {}): FundingStampOperationRow {
  return {
    requestId: REQUEST,
    kind: 'topup',
    nodeId: NODE,
    batchId: BATCH,
    expectedDepth: 22,
    newDepth: null,
    amountPerChunkPlur: AMOUNT,
    costPlur: COST,
    normalisedBalanceBefore: BALANCE_BEFORE.toString(),
    txHash: null,
    state: 'unknown',
    error: null,
    createdAt: new Date(START),
    updatedAt: new Date(START),
    ...over,
  };
}

describe('POST /api/admin-funding/stamp-operations', () => {
  it('journals a top-up before it asks the node, then answers it confirmed with the node’s transaction', async () => {
    const { journal, nodes, service } = setup();
    const atCall: { row: FundingStampOperationRow | null } = { row: null };
    nodes.onCall = async () => void (atCall.row = await journal.find(REQUEST));

    assert.deepEqual(await service.operate(topUp()), {
      requestId: REQUEST,
      kind: 'topup',
      state: 'confirmed',
      txHash: TX,
    });

    assert.equal(atCall.row?.state, 'unknown', 'the row was not there, as unknown, when the node was asked');
    assert.deepEqual(nodes.calls, [{ apiUrl: APIS[NODE], kind: 'topup', batchId: 'ab'.repeat(32), value: AMOUNT }]);
    const row = journal.rows.get(REQUEST)!;
    assert.equal(row.costPlur, COST, 'the amount for every chunk of the batch');
    assert.equal(row.normalisedBalanceBefore, BALANCE_BEFORE.toString());
    assert.equal(row.newDepth, null);
    assert.deepEqual([row.state, row.txHash, row.error], ['confirmed', TX, null]);
  });

  it('journals a dilution, asks the node for the new depth, and keeps no amount and no cost', async () => {
    const { journal, nodes, service } = setup();
    const answer = await service.operate(dilute({ newDepth: 24 }));
    assert.deepEqual(answer, { requestId: REQUEST, kind: 'dilute', state: 'confirmed', txHash: TX });
    assert.deepEqual(nodes.calls, [{ apiUrl: APIS[NODE], kind: 'dilute', batchId: 'ab'.repeat(32), value: 24 }]);
    const row = journal.rows.get(REQUEST)!;
    assert.deepEqual([row.expectedDepth, row.newDepth, row.amountPerChunkPlur, row.costPlur], [22, 24, null, null]);
  });

  it('takes the batch of a rung listed under two stages, and of the catalogue node', async () => {
    const rung = setup();
    await rung.service.operate(topUp({ nodeId: RUNG, batchId: RUNG_BATCH, expectedDepth: 21 }));
    assert.equal(rung.nodes.calls[0]?.apiUrl, APIS[RUNG]);
    const catalogue = setup();
    await catalogue.service.operate(
      dilute({ nodeId: CATALOGUE, batchId: CATALOGUE_BATCH, expectedDepth: 20, newDepth: 21 }),
    );
    assert.equal(catalogue.nodes.calls[0]?.apiUrl, APIS[CATALOGUE]);
  });

  it('finds the node’s batch wherever the node is listed, not only where it is listed first', async () => {
    const { nodes, service } = setup({
      edit: (answer) => {
        // The rung's first listing carries no batch, its second carries the one asked about.
        answer.stages[0]!.nodes[2] = node(RUNG, 'stage-one 720p rung, pool-720p', 'rung');
      },
    });
    await service.operate(topUp({ nodeId: RUNG, batchId: RUNG_BATCH, expectedDepth: 21 }));
    assert.equal(nodes.calls.length, 1);
  });

  const refusals: Array<
    [string, () => FundingStampOperationRequest, ((inventory: FundingInventory) => void) | null, RegExp]
  > = [
    ['a gateway, which uploads with no batch', () => topUp({ nodeId: GATEWAY }), null, /no batch/],
    [
      'a batch that is not the node’s',
      () => topUp({ batchId: RUNG_BATCH }),
      null,
      /not the one this node uploads with/,
    ],
    [
      'a batch the node could not be read about, with the reason',
      () => topUp(),
      (answer) => {
        answer.stages[0]!.nodes[0]!.batch = batch(BATCH, {
          depth: null,
          immutable: null,
          usable: null,
          ttlSeconds: null,
          fillRatio: null,
          readError: 'The node did not answer in time.',
        });
      },
      /could not be read.*did not answer in time/,
    ],
    [
      'a batch whose time left the node could not work out',
      () => topUp(),
      (answer) => void (answer.stages[0]!.nodes[0]!.batch = batch(BATCH, { ttlSeconds: null })),
      /time left/,
    ],
    [
      'an expired batch',
      () => topUp(),
      (answer) => void (answer.stages[0]!.nodes[0]!.batch = batch(BATCH, { ttlSeconds: 0, usable: false })),
      /expired/,
    ],
    [
      'a batch the node does not call usable',
      () => topUp(),
      (answer) => void (answer.stages[0]!.nodes[0]!.batch = batch(BATCH, { usable: false })),
      /usable/,
    ],
    ['a batch whose depth moved', () => topUp({ expectedDepth: 21 }), null, /depth 22 now, not the depth 21/],
    [
      'a top-up the node’s xBZZ does not cover, in xBZZ',
      () => topUp(),
      (answer) => void (answer.stages[0]!.nodes[0]!.xbzzPlur = (BigInt(COST) - 1n).toString()),
      /holds 0\.1739461754879999 xBZZ, less than the 0\.173946175488 xBZZ this top-up costs/,
    ],
    [
      'a top-up from a wallet with no xDAI for the gas',
      () => topUp(),
      (answer) => void (answer.stages[0]!.nodes[0]!.xdaiWei = '0'),
      /no xDAI/,
    ],
    [
      'a top-up from a wallet that could not be read',
      () => topUp(),
      (answer) => {
        Object.assign(answer.stages[0]!.nodes[0]!, {
          walletAddress: null,
          xdaiWei: null,
          xbzzPlur: null,
          readError: 'The node could not be reached.',
        });
      },
      /wallet could not be read.*could not be reached/,
    ],
    [
      'a dilution that leaves under seven days',
      () => dilute(),
      (answer) => void (answer.stages[0]!.nodes[0]!.batch = batch(BATCH, { ttlSeconds: 14 * DAY - 2 })),
      /one step would leave it 6d 23h of life, under the 7 days/,
    ],
    [
      'two steps that leave under seven days',
      () => dilute({ newDepth: 24 }),
      (answer) => void (answer.stages[0]!.nodes[0]!.batch = batch(BATCH, { ttlSeconds: 20 * DAY })),
      /two steps would leave it 5d 0h of life/,
    ],
    [
      'a dilution past depth 40',
      () => dilute({ expectedDepth: 39, newDepth: 41 }),
      (answer) => void (answer.stages[0]!.nodes[0]!.batch = batch(BATCH, { depth: 39, ttlSeconds: 400 * DAY })),
      /depth 40 at most/,
    ],
    [
      'a dilution from a wallet with no xDAI for the gas',
      () => dilute(),
      (answer) => void (answer.stages[0]!.nodes[0]!.xdaiWei = '0'),
      /no xDAI/,
    ],
  ];
  for (const [what, request, edit, pattern] of refusals) {
    it(`refuses ${what}, 422 stamp_refused, journalling nothing and asking nothing`, async () => {
      const { chain, journal, nodes, service } = setup({ edit: edit ?? undefined });
      await refusedWith(service.operate(request()), 'stamp_refused', pattern);
      assert.equal(journal.rows.size, 0);
      assert.deepEqual(nodes.calls, []);
      assert.equal(chain.reads, 0, 'the postage contract is read only once the inventory’s checks passed');
    });
  }

  it('dilutes when the time left after is seven days exactly', async () => {
    const { nodes, service } = setup({
      edit: (answer) =>
        void (answer.stages[0]!.nodes[0]!.batch = batch(BATCH, { ttlSeconds: 2 * FUNDING_DILUTE_MIN_SECONDS })),
    });
    assert.equal((await service.operate(dilute())).state, 'confirmed');
    assert.equal(nodes.calls.length, 1);
  });

  it('refuses a node it does not run, 404 unknown_node, and one whose Bee API it cannot work out', async () => {
    const { chain, journal, nodes, service } = setup();
    await refusedWith(service.operate(topUp({ nodeId: 'nobody:bee-uploader' })), 'unknown_node');
    const vanished = setup({
      edit: (answer) => {
        answer.stages[0]!.nodes[0] = node(`${STAGE_TWO}:bee-uploader`, 'gone', 'uploader', { batch: batch(BATCH) });
      },
    });
    await refusedWith(vanished.service.operate(topUp({ nodeId: `${STAGE_TWO}:bee-uploader` })), 'unknown_node');
    assert.equal(journal.rows.size + vanished.journal.rows.size, 0);
    assert.deepEqual([...nodes.calls, ...vanished.nodes.calls], []);
    assert.equal(chain.reads + vanished.chain.reads, 0);
  });

  it('answers chain_unreachable, journalling nothing, without a chain endpoint or when the chain does not answer', async () => {
    const none = setup({ chain: null });
    await refusedWith(none.service.operate(topUp()), 'chain_unreachable', /FUNDING_RPC_URL/);
    for (const broken of ['down', 'garbled'] as const) {
      const { chain, journal, nodes, service } = setup();
      chain[broken] = true;
      await refusedWith(service.operate(topUp()), 'chain_unreachable');
      assert.equal(journal.rows.size, 0, broken);
      assert.deepEqual(nodes.calls, [], broken);
    }
  });

  it('refuses what the postage contract contradicts, journalling nothing and asking nothing', async () => {
    const cases: Array<[string, (chain: FakeChain) => void, () => FundingStampOperationRequest, RegExp]> = [
      ['a batch it does not hold', (chain) => chain.batches.delete(BATCH), () => topUp(), /holds no such batch/],
      [
        'a depth the chain shows moved before the node read it back',
        (chain) => chain.change(BATCH, { depth: 23 }),
        () => topUp(),
        /postage contract has the batch at depth 23, not the depth 22/,
      ],
      [
        'a dilution of a batch another wallet bought',
        (chain) => chain.change(BATCH, { owner: OTHER_WALLET }),
        () => dilute(),
        /only the wallet that bought it can dilute it/,
      ],
    ];
    for (const [what, arrange, request, pattern] of cases) {
      const { chain, journal, nodes, service } = setup();
      arrange(chain);
      await refusedWith(service.operate(request()), 'stamp_refused', pattern);
      assert.equal(journal.rows.size, 0, what);
      assert.deepEqual(nodes.calls, [], what);
    }
  });

  it('tops up a batch another wallet bought, which the contract lets any wallet pay for', async () => {
    const { chain, service } = setup();
    chain.change(BATCH, { owner: OTHER_WALLET });
    assert.equal((await service.operate(topUp())).state, 'confirmed');
  });

  it('answers the same request again from the journal, reading nothing and never asking the node twice', async () => {
    const { chain, nodes, service, inventoryReads } = setup();
    const first = await service.operate(topUp());
    const reads = [inventoryReads(), chain.reads];
    assert.deepEqual(await service.operate(topUp()), first);
    assert.deepEqual([inventoryReads(), chain.reads], reads);
    assert.equal(nodes.calls.length, 1);
  });

  it('refuses another body under a known request id, 409 conflict, and asks nothing', async () => {
    const { nodes, service } = setup();
    await service.operate(topUp());
    await refusedWith(service.operate(topUp({ amountPerChunkPlur: '414720001' })), 'conflict');
    await refusedWith(service.operate(dilute()), 'conflict');
    await refusedWith(service.operate(topUp({ expectedDepth: 21 })), 'conflict');
    assert.equal(nodes.calls.length, 1);
  });

  it('answers a row a stopped manager left unknown without asking the node, and settles it from the contract', async () => {
    const { chain, journal, nodes, service } = setup();
    await journal.insert(journalled());
    assert.deepEqual(await service.operate(topUp()), {
      requestId: REQUEST,
      kind: 'topup',
      state: 'unknown',
      txHash: null,
    });
    assert.deepEqual(nodes.calls, []);
    chain.change(BATCH, { normalisedBalance: BALANCE_BEFORE + BigInt(AMOUNT) });
    assert.equal((await service.status(REQUEST)).state, 'confirmed');
  });
});

/** A journal another call wins the insert in: insert answers false, having written `racer` (or nothing). */
class RacedJournal extends InMemoryFundingStampOperationJournal {
  constructor(private readonly racer: FundingStampOperationRow | null) {
    super();
  }
  override async insert(): Promise<boolean> {
    if (this.racer) this.rows.set(this.racer.requestId, { ...this.racer });
    return false;
  }
}

describe('a request id two calls race for', () => {
  it('answers the winner’s state for the same body, and a conflict for another, asking nothing', async () => {
    const same = setup({ journal: new RacedJournal(journalled()) });
    assert.equal((await same.service.operate(topUp())).state, 'unknown');
    const other = setup({ journal: new RacedJournal(journalled({ amountPerChunkPlur: '1' })) });
    await refusedWith(other.service.operate(topUp()), 'conflict');
    assert.deepEqual([...same.nodes.calls, ...other.nodes.calls], []);
  });

  it('never asks the node without a journal row: an insert that writes nothing and leaves nothing throws', async () => {
    const { nodes, service } = setup({ journal: new RacedJournal(null) });
    await assert.rejects(service.operate(topUp()), /journalled/);
    assert.deepEqual(nodes.calls, []);
  });
});

/** The real BeeClient's fetch, faked: the node answers `status` and `body`, or `fetch` throws `failure`. */
function fakeFetch(t: TestContext, answer: { status: number; body: unknown } | { failure: unknown }) {
  const sent: Array<{ url: string; method: string | undefined }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method });
    if ('failure' in answer) throw answer.failure;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return sent;
}

/** What fetch throws when the socket's connection failed, as Node 24's fetch wraps it. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function socketError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
}

describe('what the node answers, through the real BeeClient', () => {
  it('sends a PATCH to the node’s /stamps/topup and takes its 202 with the hash as confirmed', async (t) => {
    const sent = fakeFetch(t, {
      status: 202,
      body: { batchID: 'ab'.repeat(32), txHash: TX.toUpperCase().replace('0X', '0x') },
    });
    const { service } = setup({ realClient: true });
    assert.deepEqual(await service.operate(topUp()), {
      requestId: REQUEST,
      kind: 'topup',
      state: 'confirmed',
      txHash: TX,
    });
    assert.deepEqual(sent, [{ url: `${APIS[NODE]}/stamps/topup/${'ab'.repeat(32)}/${AMOUNT}`, method: 'PATCH' }]);
  });

  it('marks a refusal failed with Bee’s words: out of funds, a busy node, a syncing one', async (t) => {
    for (const [status, words] of [
      [402, 'out of funds'],
      [429, 'simultaneous on-chain operations not supported'],
      [503, 'syncing in progress'],
    ] as const) {
      t.mock.restoreAll();
      fakeFetch(t, { status, body: { code: status, message: words } });
      const { journal, service } = setup({ realClient: true });
      assert.equal((await service.operate(topUp())).state, 'failed');
      assert.equal(journal.rows.get(REQUEST)?.error, `The node refused it (${status}, “${words}”).`);
    }
  });

  it('leaves a 500 unknown, since Bee answers one for a transaction it sent and lost sight of too', async (t) => {
    fakeFetch(t, { status: 500, body: { code: 500, message: 'cannot topup batch' } });
    const { chain, journal, service } = setup({ realClient: true });
    const answer = await service.operate(topUp());
    assert.deepEqual(answer, { requestId: REQUEST, kind: 'topup', state: 'unknown', txHash: null });
    assert.match(journal.rows.get(REQUEST)?.error ?? '', /500, “cannot topup batch”.*postage contract/);
    chain.change(BATCH, { normalisedBalance: BALANCE_BEFORE + BigInt(AMOUNT) });
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      kind: 'topup',
      state: 'confirmed',
      txHash: null,
      error: null,
    });
  });

  it('leaves an answer that never came unknown: a timeout of the on-chain budget', async (t) => {
    fakeFetch(t, { failure: new DOMException('The operation was aborted due to timeout', 'TimeoutError') });
    const { journal, service } = setup({ realClient: true });
    assert.equal((await service.operate(topUp())).state, 'unknown');
    assert.match(journal.rows.get(REQUEST)?.error ?? '', /answer was lost/);
  });

  it('leaves a reset connection unknown, since the request may have reached the node', async (t) => {
    fakeFetch(t, { failure: fetchFailed(socketError('ECONNRESET', 'read')) });
    const { service } = setup({ realClient: true });
    assert.equal((await service.operate(topUp())).state, 'unknown');
  });

  it('answers a node it could not connect to as node_unreachable, and journals it failed', async (t) => {
    const failures: Array<[string, unknown]> = [
      ['refused', fetchFailed(socketError('ECONNREFUSED', 'connect'))],
      ['no such name', fetchFailed(socketError('ENOTFOUND', 'getaddrinfo'))],
      [
        'refused on every address of a name',
        fetchFailed(
          Object.assign(
            new AggregateError([socketError('ECONNREFUSED', 'connect'), socketError('ECONNREFUSED', 'connect')]),
            {
              code: 'ECONNREFUSED',
            },
          ),
        ),
      ],
      [
        'a connect that timed out',
        fetchFailed(Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })),
      ],
    ];
    for (const [what, failure] of failures) {
      t.mock.restoreAll();
      fakeFetch(t, { failure });
      const { journal, service } = setup({ realClient: true });
      await refusedWith(service.operate(topUp()), 'node_unreachable', /could not be reached, so it was asked nothing/);
      const row = journal.rows.get(REQUEST);
      assert.deepEqual([row?.state, row?.txHash], ['failed', null], what);
      assert.deepEqual(
        await service.operate(topUp()),
        { requestId: REQUEST, kind: 'topup', state: 'failed', txHash: null },
        `${what}: the same request answers the journal and asks nothing again`,
      );
      assert.equal((await service.status(REQUEST)).state, 'failed', what);
    }
  });

  it('leaves an answer with no transaction hash unknown', async (t) => {
    fakeFetch(t, { status: 202, body: { batchID: 'ab'.repeat(32) } });
    const { service } = setup({ realClient: true });
    assert.equal((await service.operate(dilute())).state, 'unknown');
  });
});

describe('GET /api/admin-funding/stamp-operations/:requestId', () => {
  it('answers 404 unknown_request for a request id never journalled', async () => {
    await refusedWith(setup().service.status(REQUEST), 'unknown_request', /safe/);
  });

  it('answers a settled operation as journalled, without reading the chain', async () => {
    const { chain, service } = setup();
    await service.operate(topUp());
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      kind: 'topup',
      state: 'confirmed',
      txHash: TX,
      error: null,
    });
    const reads = chain.reads;
    await service.status(REQUEST);
    assert.equal(chain.reads, reads);
  });

  it('confirms an unknown top-up once the contract’s balance grew by the amount, not by less', async () => {
    const { chain, journal, service, advance } = setup();
    await journal.insert(journalled());
    chain.change(BATCH, { normalisedBalance: BALANCE_BEFORE + BigInt(AMOUNT) - 1n });
    assert.equal((await service.status(REQUEST)).state, 'unknown');
    chain.change(BATCH, { normalisedBalance: BALANCE_BEFORE + BigInt(AMOUNT) });
    advance(FUNDING_STATUS_READ_MS);
    assert.equal((await service.status(REQUEST)).state, 'confirmed');
    assert.deepEqual([journal.rows.get(REQUEST)?.state, journal.rows.get(REQUEST)?.error], ['confirmed', null]);
  });

  it('confirms an unknown dilution once the batch is at the new depth or deeper', async () => {
    for (const depth of [23, 24]) {
      const { chain, journal, service } = setup();
      await journal.insert(journalled({ kind: 'dilute', newDepth: 23, amountPerChunkPlur: null, costPlur: null }));
      chain.change(BATCH, { depth, normalisedBalance: BALANCE_BEFORE / 2n });
      assert.equal((await service.status(REQUEST)).state, 'confirmed', `depth ${depth}`);
    }
  });

  it('fails an unknown operation the contract never shows, thirty minutes after it was journalled', async () => {
    const { journal, service, advance } = setup();
    await journal.insert(journalled({ kind: 'dilute', newDepth: 23, amountPerChunkPlur: null, costPlur: null }));
    advance(FUNDING_UNKNOWN_AFTER_MS);
    assert.equal((await service.status(REQUEST)).state, 'unknown', 'not before the thirty minutes are past');
    advance(FUNDING_STATUS_READ_MS);
    const failed = await service.status(REQUEST);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error ?? '', /no dilution to depth 23 of the batch thirty minutes after/);
    assert.equal(journal.rows.get(REQUEST)?.state, 'failed');
  });

  it('reads the chain for a request id at most once every five seconds, answering the journal in between', async () => {
    const { chain, journal, service, advance } = setup();
    await journal.insert(journalled());
    await service.status(REQUEST);
    assert.equal(chain.reads, 1);
    advance(FUNDING_STATUS_READ_MS - 1);
    await service.status(REQUEST);
    await service.status(REQUEST);
    assert.equal(chain.reads, 1);
    advance(1);
    await service.status(REQUEST);
    assert.equal(chain.reads, 2);
  });

  it('answers the journalled state when the chain does not answer, or answers what it cannot read', async () => {
    for (const broken of ['down', 'garbled'] as const) {
      const { chain, journal, service, advance } = setup();
      await journal.insert(journalled());
      chain[broken] = true;
      advance(FUNDING_UNKNOWN_AFTER_MS + 1);
      assert.equal((await service.status(REQUEST)).state, 'unknown', broken);
    }
  });

  it('answers the journalled state with no chain endpoint', async () => {
    const { journal, service, advance } = setup({ chain: null });
    await journal.insert(journalled());
    advance(FUNDING_UNKNOWN_AFTER_MS + 1);
    assert.equal((await service.status(REQUEST)).state, 'unknown');
  });
});

describe('the node’s answer and the contract’s reading, settling one row', () => {
  it('writes the node’s hash onto a row the status route confirmed while the node was asked', async () => {
    const { chain, journal, nodes, service } = setup();
    nodes.onCall = async () => {
      chain.change(BATCH, { normalisedBalance: BALANCE_BEFORE + BigInt(AMOUNT) });
      assert.equal((await service.status(REQUEST)).state, 'confirmed');
    };
    assert.deepEqual(await service.operate(topUp()), {
      requestId: REQUEST,
      kind: 'topup',
      state: 'confirmed',
      txHash: TX,
    });
    assert.deepEqual([journal.rows.get(REQUEST)?.state, journal.rows.get(REQUEST)?.txHash], ['confirmed', TX]);
  });

  it('keeps a row the status route confirmed when the node then answers a 500', async () => {
    const { chain, journal, nodes, service } = setup();
    nodes.onCall = async () => {
      chain.change(BATCH, { normalisedBalance: BALANCE_BEFORE + BigInt(AMOUNT) });
      await service.status(REQUEST);
    };
    nodes.answer = async () => {
      throw new BeeHttpError(500, `bee PATCH /stamps/topup/x/y → 500: {"code":500,"message":"cannot topup batch"}`);
    };
    assert.equal((await service.operate(topUp())).state, 'confirmed');
    assert.deepEqual([journal.rows.get(REQUEST)?.state, journal.rows.get(REQUEST)?.error], ['confirmed', null]);
  });
});
