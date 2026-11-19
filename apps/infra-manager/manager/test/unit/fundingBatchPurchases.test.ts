/**
 * The funding API's batch purchases: a new batch for a rung, for the catalogue or as an archive stamp, checked against
 * the inventory and the batch set in the role, journalled, then asked of the node once under the purchase's own label;
 * and its status, settled from the node's own list of batches when the node's answer was lost, with the node's word on
 * whether the batch is usable. The archive-only route of an older admin is a purchase of purpose `archive`.
 *
 * Unit test, no database, no chain and no Bee node: a fake inventory, an in-memory journal, a fake node that buys and
 * is read, fakes of the ports, the real follow-up for what it reads and records (its background step is recorded and
 * not run here; `fundingPurchaseFollowUp.test.ts` runs it), and the real BeeClient over a faked fetch where the request
 * it sends matters. Nothing reaches a network and no money moves. `pnpm test` in manager/.
 *
 * Every refusal is answered before anything is journalled or asked: 422 `stamp_refused` with a sentence for a check
 * that failed, 404 `unknown_node` for a node the manager does not run, 409 `conflict` for a node with another purchase
 * or operation under way.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import {
  ARCHIVE_PURCHASE_SETTLE_MS,
  ARCHIVE_SLOTS_FULL_REFUSAL,
  type ArchiveBatchDesignation,
  plurToBzzExact,
  purchaseNodeLabel,
  type StampState,
} from '@streaming-infra-manager/common';
import {
  CATALOGUE_ARCHIVE_BATCHES_MAX,
  type FundingBatchPurchaseRequest,
  type FundingInventory,
  type FundingNode,
  type FundingNodeRole,
  fundingBatchPurchaseAnswerSchema,
  fundingBatchPurchaseStatusSchema,
  fundingStampPurchaseAnswerSchema,
  fundingStampPurchaseStatusSchema,
} from '@streaming-monorepo/contracts';

import { BeeClient, type BeeStamp, type BuyStampInput } from '../../src/domain/BeeClient.js';
import { BeeHttpError } from '../../src/domain/errors/BeeHttpError.js';
import { ArchiveBatchRefusedError } from '../../src/domain/errors/index.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';
import {
  type FundingBatchPurchaseNode,
  FundingBatchPurchaseService,
} from '../../src/domain/funding/FundingBatchPurchaseService.js';
import { FUNDING_STATUS_READ_MS } from '../../src/domain/funding/FundingChainService.js';
import { FUNDING_BZZ_TOKEN } from '../../src/domain/funding/FundingInventoryService.js';
import {
  FundingPurchaseFollowUp,
  type FundingPurchaseReads,
} from '../../src/domain/funding/FundingPurchaseFollowUp.js';
import type { FundingStampPurchaseRow } from '../../src/domain/funding/FundingStampPurchaseJournal.js';
import type { RoleBatchReading } from '../../src/domain/funding/purchaseFollowUpPorts.js';
import { Logger } from '../../src/domain/Logger.js';
import type { ArchiveBatchToDesignate } from '../../src/domain/stages/archiveBatchPorts.js';
import type { Profile } from '../../src/types/index.js';
import { emptyCatalogueDesignationRow } from '../support/InMemoryCatalogueDesignation.js';
import { InMemoryFundingStampPurchaseJournal } from '../support/InMemoryFundingStampPurchaseJournal.js';
import { makeProfile } from '../support/profileFixtures.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const STAGE = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const ABR_STAGE = '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c';
const RUNG_ID = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d';
const CATALOGUE_ID = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf';
/** A single-node stage's own node, offered a replacement in the inventory. */
const NODE = `${STAGE}:bee-uploader`;
const GATEWAY = `${STAGE}:bee-gateway`;
const RUNG = `${RUNG_ID}:bee-uploader`;
const CATALOGUE = `${CATALOGUE_ID}:bee-uploader`;
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const OTHER_REQUEST = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
/** Another request id that begins with the same twelve hex digits as REQUEST. */
const LOOKALIKE_REQUEST = '7d1e2f3a-4b5c-4fff-8aaa-bbbbbbbbbbbb';
const NODE_LABEL = purchaseNodeLabel('archive', REQUEST);
const OTHER_LABEL = purchaseNodeLabel('archive', OTHER_REQUEST);
/** The catalogue's own batch, as the designation keeps it, and the batch a purchase buys, as Bee spells them. */
const CATALOGUE_BATCH = 'ef'.repeat(32);
const BOUGHT = 'c5'.repeat(32);
const ANOTHERS = 'd6'.repeat(32);
/** The batch a rung purchase replaces: the one set on the rung now. */
const REPLACED = 'b4'.repeat(32);
const TX = `0x${'9a'.repeat(32)}`;
/** Thirty days at 24000 PLUR a chunk a block: 518400 blocks of it. */
const AMOUNT = '12441600000';
/** The postage contract's floor at that price: a day, 17280 blocks. */
const FLOOR = '414720000';
const DEPTH = 20;
/** That amount for each of a depth 20 batch's 2^20 chunks, in PLUR: 1.30459631616 xBZZ. */
const COST = (BigInt(AMOUNT) << BigInt(DEPTH)).toString();
const START = Date.parse('2026-11-13T10:00:00.000Z');
const API = 'http://bee.invalid:1633';
const BUSY =
  'Another batch purchase on this node is still being bought or waits for its batch to become usable, and both would spend the same wallet. Try again once it is done.';

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
    replacement: role === 'gateway' ? null : { depth: DEPTH, immutable: false },
    ...over,
  };
}

/**
 * A single-node stage with its own node and a light gateway, an ABR stage with one rung, and the catalogue node, at
 * 24000 PLUR a chunk a block.
 */
function inventory(): FundingInventory {
  return {
    observedAt: '2026-11-13T10:00:00.000Z',
    chain: {
      chainId: 100,
      bzzToken: FUNDING_BZZ_TOKEN,
      postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
    },
    stages: [
      {
        stageId: STAGE,
        name: 'stage-one',
        nodes: [node(NODE, 'stage-one Bee node', 'uploader'), node(GATEWAY, 'stage-one gateway', 'gateway')],
      },
      { stageId: ABR_STAGE, name: 'stage-abr', nodes: [node(RUNG, 'stage-abr 720p rung, pool-720p', 'rung')] },
    ],
    catalogue: node(CATALOGUE, 'catalogue catalogue node', 'uploader', {
      replacement: { depth: 22, immutable: true },
    }),
    archiveBatches: [],
  };
}

/** A batch as Bee lists it in `GET /stamps`, under the archive purchase's label by default. */
function beeStamp(batchID: string, over: Partial<BeeStamp> = {}): BeeStamp {
  return {
    batchID,
    utilization: 0,
    usable: false,
    label: NODE_LABEL,
    depth: DEPTH,
    amount: AMOUNT,
    bucketDepth: 16,
    blockNumber: 43_000_000,
    immutableFlag: true,
    exists: true,
    batchTTL: 30 * 86_400,
    ...over,
  };
}

/** An archive batch the manager keeps already. */
function archived(batchId: string, over: Partial<ArchiveBatchDesignation> = {}): ArchiveBatchDesignation {
  return {
    batchId,
    profileName: 'catalogue',
    depth: 22,
    label: null,
    source: 'adopted',
    purchaseRequestId: null,
    designatedAt: '2026-11-13T09:00:00.000Z',
    designatedBy: 'operator',
    ...over,
  };
}

/** The nodes' Bee API: what each was asked to buy, and what it answers when read. */
class FakeNode {
  readonly bought: Array<BuyStampInput & { apiUrl: string }> = [];
  answer: () => Promise<{ batchID: string }> = async () => ({ batchID: BOUGHT, txHash: TX }) as { batchID: string };
  /** Called as the node is asked, to look at the journal then. */
  onBuy: () => Promise<void> | void = () => undefined;
  /** What `GET /stamps` lists, or the failure it throws. */
  stamps: BeeStamp[] | Error = [];
  /** What `GET /stamps/{id}` answers for the bought batch, or the failure it throws. */
  stamp: BeeStamp | Error = beeStamp(BOUGHT);
  listReads = 0;
  stampReads = 0;

  at(apiUrl: string): FundingBatchPurchaseNode {
    return {
      buyStamp: async (input) => {
        this.bought.push({ ...input, apiUrl });
        await this.onBuy();
        return this.answer();
      },
    };
  }

  reads(): FundingPurchaseReads {
    return {
      listStamps: async () => {
        this.listReads += 1;
        if (this.stamps instanceof Error) throw this.stamps;
        return this.stamps;
      },
      getStamp: async (batchId) => {
        this.stampReads += 1;
        assert.equal(batchId, BOUGHT, 'the batch is read by its id without 0x');
        if (this.stamp instanceof Error) throw this.stamp;
        return this.stamp;
      },
    };
  }
}

/** The archive batches' designation, faked: what it was asked to designate, and a failure to write while one is set. */
class FakeDesignator {
  readonly asked: ArchiveBatchToDesignate[] = [];
  failure: Error | null = null;

  async designateArchiveBatch(batch: ArchiveBatchToDesignate): Promise<void> {
    this.asked.push(batch);
    if (this.failure) throw this.failure;
  }
}

const PROFILES: Record<string, Profile> = {
  [NODE]: makeProfile({ name: 'stage-one', kind: 'streamer', instance_id: STAGE, port_slot: 1 }),
  [RUNG]: makeProfile({
    name: 'pool-720p',
    kind: 'custom',
    instance_id: RUNG_ID,
    components: ['bee-uploader'],
    port_slot: 3,
  }),
  [CATALOGUE]: makeProfile({
    name: 'catalogue',
    kind: 'custom',
    instance_id: CATALOGUE_ID,
    components: ['bee-uploader'],
    port_slot: 5,
  }),
};

interface SetupOptions {
  edit?: (inventory: FundingInventory) => void;
  journal?: InMemoryFundingStampPurchaseJournal;
  designator?: FakeDesignator;
  /** The archive batches the manager keeps. */
  archived?: ArchiveBatchDesignation[];
  /** The catalogue node's deployment gone. */
  gone?: boolean;
  /** How many places on the catalogue stamp record's list are held, each time it is asked. */
  slotsTaken?: () => Promise<number>;
  /** The batch set on a rung's or a stage's node now; an expired REPLACED by default. */
  rungBatch?: RoleBatchReading;
  /** The designated catalogue batch now; the catalogue's own, gone, by default. */
  catalogueBatch?: RoleBatchReading;
  /** Whether another operation of the funding API is under way on a node. */
  otherOperation?: boolean;
}

function setup(options: SetupOptions = {}) {
  const journal = options.journal ?? new InMemoryFundingStampPurchaseJournal();
  const bee = new FakeNode();
  const designator = options.designator ?? new FakeDesignator();
  const designation = emptyCatalogueDesignationRow();
  Object.assign(designation, {
    profileName: 'catalogue',
    batchId: CATALOGUE_BATCH,
    batchDepth: 22,
    designatedAt: new Date(START),
  });
  let inventoryReads = 0;
  let now = START;
  const currents: string[] = [];
  const advanced: string[] = [];
  const unreachable = (): Promise<never> => Promise.reject(new Error('not asked here'));
  const followUp = new FundingPurchaseFollowUp({
    journal,
    deployment: async (nodeId) => (options.gone ? null : (PROFILES[nodeId] ?? null)),
    uploaderApiUrl: () => API,
    reads: () => bee.reads(),
    archiveBatches: { list: async () => options.archived ?? [] },
    catalogue: { read: async () => designation },
    designator,
    rungs: { current: unreachable, set: unreachable },
    stages: { look: unreachable },
    catalogueBatches: { current: unreachable, designate: unreachable, release: unreachable },
    now: () => now,
  });
  const calls: string[] = [];
  const service = new FundingBatchPurchaseService({
    journal,
    inventory: {
      inventory: async () => {
        inventoryReads += 1;
        const answer = inventory();
        options.edit?.(answer);
        return answer;
      },
    },
    deployment: async (nodeId) => (options.gone ? null : (PROFILES[nodeId] ?? null)),
    uploaderApiUrl: () => API,
    node: (apiUrl) => bee.at(apiUrl),
    // The follow-up's own reads and records, and its background step recorded rather than run.
    followUp: {
      settle: (row, apiUrl) => followUp.settle(row, apiUrl),
      usable: (batchId, apiUrl) => followUp.usable(batchId, apiUrl),
      designateArchive: (row, profileName) => followUp.designateArchive(row, profileName),
      advance: async (requestId) => void advanced.push(requestId),
      restart: async (requestId, stageId) => void calls.push(`restart ${requestId} ${stageId}`),
      check: async (requestId) => void calls.push(`check ${requestId}`),
      release: async (requestId) => void calls.push(`release ${requestId}`),
    },
    rungs: {
      current: async (profileName) => {
        currents.push(`rung ${profileName}`);
        return options.rungBatch ?? { batchId: REPLACED, state: 'expired' };
      },
    },
    catalogueBatches: {
      current: async (profileName) => {
        currents.push(`catalogue ${profileName}`);
        return options.catalogueBatch ?? { batchId: CATALOGUE_BATCH, state: 'gone' };
      },
    },
    otherOperationOpen: async () => options.otherOperation ?? false,
    archiveSlotsTaken: options.slotsTaken,
    now: () => now,
  });
  return {
    service,
    journal,
    bee,
    designator,
    designation,
    currents,
    advanced,
    calls,
    inventoryReads: () => inventoryReads,
    later: (ms: number) => void (now += ms),
  };
}

function request(over: Partial<FundingBatchPurchaseRequest> = {}): FundingBatchPurchaseRequest {
  return {
    requestId: REQUEST,
    purpose: 'archive',
    nodeId: CATALOGUE,
    depth: DEPTH,
    amountPerChunkPlur: AMOUNT,
    immutable: true,
    label: 'Autumn event',
    replacesBatchId: null,
    ...over,
  };
}

/** A rung's purchase, a mutable batch in place of the expired one set on the rung. */
function rungRequest(over: Partial<FundingBatchPurchaseRequest> = {}): FundingBatchPurchaseRequest {
  return request({
    purpose: 'rung',
    nodeId: RUNG,
    immutable: false,
    label: null,
    replacesBatchId: `0x${REPLACED}`,
    ...over,
  });
}

/** The catalogue's purchase, an immutable batch in place of the designated one, gone. */
function catalogueRequest(over: Partial<FundingBatchPurchaseRequest> = {}): FundingBatchPurchaseRequest {
  return request({ purpose: 'catalogue', label: null, replacesBatchId: `0x${CATALOGUE_BATCH}`, ...over });
}

/** A row as a manager that stopped between the journal and the node's answer leaves it. */
function journalled(over: Partial<FundingStampPurchaseRow> = {}): FundingStampPurchaseRow {
  return {
    requestId: REQUEST,
    purpose: 'archive',
    nodeId: CATALOGUE,
    depth: DEPTH,
    amountPerChunkPlur: AMOUNT,
    costPlur: COST,
    immutable: true,
    label: 'Autumn event',
    nodeLabel: NODE_LABEL,
    replacesBatchId: null,
    batchId: null,
    txHash: null,
    state: 'unknown',
    step: 'buying',
    error: null,
    createdAt: new Date(START),
    updatedAt: new Date(START),
    boughtAt: null,
    setAt: null,
    previousBatchId: null,
    releasedAt: null,
    recordedAt: null,
    ...over,
  };
}

/** The other purchase, left open on the catalogue node. */
const otherOpen = (over: Partial<FundingStampPurchaseRow> = {}) =>
  journalled({ requestId: OTHER_REQUEST, nodeLabel: OTHER_LABEL, ...over });

async function refusedWith(promise: Promise<unknown>, code: string, expected?: RegExp | string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof FundingApiError, String(err));
    assert.equal(err.code, code);
    if (typeof expected === 'string') assert.equal(err.message, expected);
    else if (expected) assert.match(err.message, expected);
    return true;
  });
}

describe('POST /api/admin-funding/batch-purchases for an archive stamp', () => {
  it('journals the purchase before it asks the node, buys an immutable batch under its own label, and confirms it', async () => {
    const { advanced, bee, journal, service } = setup();
    const atBuy: { row: FundingStampPurchaseRow | null } = { row: null };
    bee.onBuy = async () => void (atBuy.row = await journal.find(REQUEST));

    const answer = await service.purchase(request());
    assert.deepEqual(answer, {
      requestId: REQUEST,
      purpose: 'archive',
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: TX,
    });
    fundingBatchPurchaseAnswerSchema.parse(answer);

    assert.equal(NODE_LABEL, 'archive-7d1e2f3a4b5c', 'the first twelve hex digits of the request id');
    assert.deepEqual(
      [atBuy.row?.state, atBuy.row?.step, atBuy.row?.nodeLabel],
      ['unknown', 'buying', NODE_LABEL],
      'journalled before the node',
    );
    assert.deepEqual(bee.bought, [{ apiUrl: API, amount: AMOUNT, depth: DEPTH, label: NODE_LABEL, immutable: true }]);
    const row = journal.rows.get(REQUEST)!;
    assert.deepEqual(
      [row.costPlur, row.label, row.batchId, row.txHash, row.state, row.step, row.boughtAt, row.error],
      [COST, 'Autumn event', `0x${BOUGHT}`, TX, 'confirmed', 'waiting_usable', new Date(START), null],
    );
    assert.deepEqual(advanced, [REQUEST], 'the follow-up takes it from there');
  });

  it('makes the bought batch an archive batch on the catalogue node, and marks the purchase recorded', async () => {
    const { designator, journal, service } = setup();
    await service.purchase(request());
    assert.deepEqual(designator.asked, [
      {
        batchId: BOUGHT,
        profileName: 'catalogue',
        depth: DEPTH,
        label: 'Autumn event',
        designatedBy: null,
        purchaseRequestId: REQUEST,
      },
    ]);
    assert.deepEqual(journal.rows.get(REQUEST)?.recordedAt, new Date(START));
  });

  it('keeps a purchase with no label as none, on the node and in the archive batches', async () => {
    const { bee, designator, service } = setup();
    await service.purchase(request({ label: null }));
    assert.equal(bee.bought[0]?.label, NODE_LABEL, 'the node keeps the purchase’s own label all the same');
    assert.equal(designator.asked[0]?.label, null);
  });

  it('answers the same request again from the journal, buying once; another body under its id is a conflict', async () => {
    const { bee, inventoryReads, service } = setup();
    const first = await service.purchase(request());
    assert.deepEqual(await service.purchase(request()), first);
    assert.equal(bee.bought.length, 1);
    assert.equal(inventoryReads(), 1, 'a repeat reads nothing');
    for (const other of [
      { depth: 21 },
      { amountPerChunkPlur: FLOOR },
      { label: 'Winter' },
      { label: null },
      { purpose: 'catalogue' as const },
      { immutable: false },
      { replacesBatchId: `0x${ANOTHERS}` },
    ]) {
      await refusedWith(service.purchase(request(other)), 'conflict', 'This request id names another batch purchase.');
    }
    assert.equal(bee.bought.length, 1);
  });

  it('buys on the catalogue node alone: 422 for a stage’s node, 404 for one it does not run or no catalogue node', async () => {
    const { bee, journal, service } = setup();
    await refusedWith(
      service.purchase(request({ nodeId: NODE })),
      'stamp_refused',
      'An archive stamp is bought on the catalogue node alone, and this node is not the catalogue node.',
    );
    await refusedWith(service.purchase(request({ nodeId: 'nobody:bee-uploader' })), 'unknown_node');
    const none = setup({ edit: (answer) => void (answer.catalogue = null) });
    await refusedWith(none.service.purchase(request()), 'unknown_node');
    const gone = setup({ gone: true });
    await refusedWith(gone.service.purchase(request()), 'unknown_node');
    assert.equal(journal.rows.size + none.journal.rows.size + gone.journal.rows.size, 0);
    assert.deepEqual([...bee.bought, ...none.bee.bought, ...gone.bee.bought], []);
  });

  it('refuses a wallet short of the cost with what is missing, one with no xDAI, and one it could not read', async () => {
    const holds = 10_000_000_000_000_000n;
    const cases: Array<[Partial<FundingNode>, string]> = [
      [
        { xbzzPlur: holds.toString() },
        `The node’s wallet holds ${plurToBzzExact(holds)} xBZZ, ${plurToBzzExact(BigInt(COST) - holds)} xBZZ short of the ${plurToBzzExact(BigInt(COST))} xBZZ this archive stamp costs.`,
      ],
      [{ xdaiWei: '0' }, 'The node’s wallet holds no xDAI to pay the gas with.'],
      [
        { walletAddress: null, xbzzPlur: null, xdaiWei: null, readError: 'The node did not answer in time.' },
        'The node’s wallet could not be read, so whether it can pay is not known. The node did not answer in time.',
      ],
    ];
    for (const [over, expected] of cases) {
      const { bee, journal, service } = setup({ edit: (answer) => void Object.assign(answer.catalogue!, over) });
      await refusedWith(service.purchase(request()), 'stamp_refused', expected);
      assert.equal(journal.rows.size + bee.bought.length, 0, JSON.stringify(over));
    }
    assert.equal(plurToBzzExact(BigInt(COST)), '1.30459631616');
  });

  it('refuses an amount that buys less than the postage contract’s day of life at today’s price, and buys the day', async () => {
    const short = setup();
    await refusedWith(
      short.service.purchase(request({ amountPerChunkPlur: (BigInt(FLOOR) - 1n).toString() })),
      'stamp_refused',
      'At today’s price this amount buys 23h 59m of life, under the 1d 0h the postage contract asks of a new batch.',
    );
    assert.equal(short.bee.bought.length, 0);
    const day = setup();
    assert.equal((await day.service.purchase(request({ amountPerChunkPlur: FLOOR }))).state, 'confirmed');
  });

  it('refuses when no node answered the price of postage, since the life an amount buys is not known', async () => {
    const { bee, service } = setup({ edit: (answer) => void (answer.chain.postage = null) });
    await refusedWith(service.purchase(request()), 'stamp_refused', /^No node answered the price of postage/);
    assert.equal(bee.bought.length, 0);
  });

  it('refuses a purchase once every place on the catalogue stamp record is held, before the node is read', async () => {
    const { bee, journal, service, inventoryReads } = setup({
      slotsTaken: async () => CATALOGUE_ARCHIVE_BATCHES_MAX,
    });
    await refusedWith(service.purchase(request()), 'stamp_refused', ARCHIVE_SLOTS_FULL_REFUSAL);
    assert.equal(inventoryReads(), 0);
    assert.equal(journal.rows.size, 0);
    assert.deepEqual(bee.bought, []);
  });

  it('refuses a purchase whose last place another took while the node was read, and journals nothing', async () => {
    const counts = [CATALOGUE_ARCHIVE_BATCHES_MAX - 1, CATALOGUE_ARCHIVE_BATCHES_MAX];
    const { bee, journal, service } = setup({ slotsTaken: async () => counts.shift() ?? 0 });
    await refusedWith(service.purchase(request()), 'stamp_refused', ARCHIVE_SLOTS_FULL_REFUSAL);
    assert.deepEqual(counts, [], 'counted before the node and again as it is journalled');
    assert.equal(journal.rows.size, 0);
    assert.deepEqual(bee.bought, []);
  });

  it('buys while a place is left, and counts no place for a rung’s purchase', async () => {
    const { service } = setup({ slotsTaken: async () => CATALOGUE_ARCHIVE_BATCHES_MAX - 1 });
    assert.equal((await service.purchase(request())).state, 'confirmed');
    const full = setup({ slotsTaken: async () => CATALOGUE_ARCHIVE_BATCHES_MAX });
    assert.equal((await full.service.purchase(rungRequest())).state, 'confirmed');
  });

  it('answers 409 conflict while another purchase on the node is still being bought, asking the node nothing', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(OTHER_REQUEST, otherOpen());
    const { bee, service } = setup({ journal });
    await refusedWith(service.purchase(request()), 'conflict', BUSY);
    assert.equal(bee.bought.length, 0);
    assert.equal(journal.rows.has(REQUEST), false);
    assert.equal(bee.listReads, 1, 'the open purchase was looked for on the node first');
  });

  it('answers 409 conflict while another purchase on the node waits for its batch to become usable', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(
      OTHER_REQUEST,
      otherOpen({ state: 'confirmed', step: 'waiting_usable', batchId: `0x${ANOTHERS}`, boughtAt: new Date(START) }),
    );
    const { bee, service } = setup({ journal });
    await refusedWith(service.purchase(request()), 'conflict', BUSY);
    assert.equal(bee.bought.length, 0);
  });

  it('answers 409 conflict while another operation of the funding API is under way on the node', async () => {
    const { bee, journal, service } = setup({ otherOperation: true });
    await refusedWith(service.purchase(rungRequest()), 'conflict', /top-up, a dilution or a chequebook move/);
    assert.equal(bee.bought.length + journal.rows.size, 0);
  });

  it('settles an open purchase the node lists as bought first, then refuses while its batch is not usable', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(OTHER_REQUEST, otherOpen());
    const { bee, designator, service } = setup({ journal });
    bee.stamps = [beeStamp(ANOTHERS, { label: OTHER_LABEL })];
    await refusedWith(service.purchase(request()), 'conflict', BUSY);
    const other = journal.rows.get(OTHER_REQUEST);
    assert.deepEqual([other?.state, other?.batchId, other?.step], ['confirmed', `0x${ANOTHERS}`, 'waiting_usable']);
    assert.deepEqual(
      designator.asked.map((batch) => [batch.purchaseRequestId, batch.batchId]),
      [[OTHER_REQUEST, ANOTHERS]],
      'made an archive batch as it was settled',
    );
  });

  it('buys once the open purchase on the node failed', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(OTHER_REQUEST, otherOpen());
    const { later, service } = setup({ journal });
    later(ARCHIVE_PURCHASE_SETTLE_MS + 1);
    assert.equal((await service.purchase(request())).state, 'confirmed');
    assert.equal(journal.rows.get(OTHER_REQUEST)?.state, 'failed');
  });

  it('answers 409 conflict for a purchase another call journalled on the node in between, through the table’s rule', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    const openOn = journal.openOn.bind(journal);
    // The look before the insert finds nothing, then another call's row lands before this one's.
    journal.openOn = async () => {
      journal.rows.set(OTHER_REQUEST, otherOpen());
      journal.openOn = openOn;
      return null;
    };
    const { bee, service } = setup({ journal });
    await refusedWith(service.purchase(request()), 'conflict', BUSY);
    assert.equal(bee.bought.length, 0);
  });

  it('answers 409 conflict for a request id whose first twelve hex digits another purchase’s label carries', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled({ state: 'failed', step: 'failed', error: 'The node refused it (402).' }));
    const { bee, service } = setup({ journal });
    await refusedWith(service.purchase(request({ requestId: LOOKALIKE_REQUEST })), 'conflict', /new request id/);
    assert.equal(bee.bought.length, 0);
    assert.equal(journal.rows.has(LOOKALIKE_REQUEST), false);
  });
});

describe('POST /api/admin-funding/batch-purchases for a rung', () => {
  it('buys a batch of the kind asked for on the rung’s node, under a label of its own, in place of the set one', async () => {
    const { bee, currents, journal, service } = setup();
    const answer = await service.purchase(rungRequest());
    assert.deepEqual([answer.purpose, answer.state], ['rung', 'confirmed']);
    assert.deepEqual(bee.bought, [
      { apiUrl: API, amount: AMOUNT, depth: DEPTH, label: 'rung-7d1e2f3a4b5c', immutable: false },
    ]);
    assert.deepEqual(currents, ['rung pool-720p'], 'the batch set now is read through the port');
    const row = journal.rows.get(REQUEST)!;
    assert.deepEqual(
      [row.purpose, row.immutable, row.replacesBatchId, row.recordedAt],
      ['rung', false, `0x${REPLACED}`, null],
    );
  });

  it('buys on a single-node stage’s own node too, and on none the inventory offers no replacement for', async () => {
    const own = setup();
    assert.equal((await own.service.purchase(rungRequest({ nodeId: NODE }))).state, 'confirmed');
    const refusal =
      'A rung’s batch is bought on a rung’s node or on a single-node stage’s own node, and this node is neither.';
    for (const nodeId of [GATEWAY, CATALOGUE]) {
      const { bee, service } = setup();
      await refusedWith(service.purchase(rungRequest({ nodeId })), 'stamp_refused', refusal);
      assert.equal(bee.bought.length, 0, nodeId);
    }
    const offeredNone = setup({ edit: (answer) => void (answer.stages[0]!.nodes[0]!.replacement = null) });
    await refusedWith(offeredNone.service.purchase(rungRequest({ nodeId: NODE })), 'stamp_refused', refusal);
    const unknown = setup();
    await refusedWith(unknown.service.purchase(rungRequest({ nodeId: 'nobody:bee-uploader' })), 'unknown_node');
  });

  it('refuses a batch named as replaced that is not the one set now, and none named while one is set', async () => {
    const cases: Array<[string | null, string | null, RegExp | string]> = [
      [
        `0x${ANOTHERS}`,
        REPLACED,
        `The batch set here now is 0x${REPLACED}, another than the one the purchase names as replaced. Read the inventory again.`,
      ],
      [null, REPLACED, /another than the one the purchase names/],
      [
        `0x${REPLACED}`,
        null,
        'No batch is set here now, and the purchase names one it replaces. Read the inventory again.',
      ],
    ];
    for (const [named, set, expected] of cases) {
      const { bee, journal, service } = setup({
        rungBatch: { batchId: set, state: set === null ? 'none' : 'expired' },
      });
      await refusedWith(service.purchase(rungRequest({ replacesBatchId: named })), 'stamp_refused', expected);
      assert.equal(bee.bought.length + journal.rows.size, 0);
    }
  });

  it('refuses in place of a batch that still pays, and buys in place of one expired, gone or none', async () => {
    const refused: Array<[StampState, RegExp]> = [
      ['active', /still pays for uploads/],
      ['full', /Dilute it for more room/],
      ['pending', /not usable yet/],
      ['unknown', /could not be read from its node/],
    ];
    for (const [state, expected] of refused) {
      const { bee, service } = setup({ rungBatch: { batchId: REPLACED, state } });
      await refusedWith(service.purchase(rungRequest()), 'stamp_refused', expected);
      assert.equal(bee.bought.length, 0, state);
    }
    for (const state of ['expired', 'gone'] as const) {
      const { service } = setup({ rungBatch: { batchId: REPLACED, state } });
      assert.equal((await service.purchase(rungRequest())).state, 'confirmed', state);
    }
    const none = setup({ rungBatch: { batchId: null, state: 'none' } });
    assert.equal((await none.service.purchase(rungRequest({ replacesBatchId: null }))).state, 'confirmed');
  });

  it('refuses a wallet short of the cost in words of a batch', async () => {
    const { service } = setup({
      edit: (answer) => void Object.assign(answer.stages[1]!.nodes[0]!, { xbzzPlur: '1' }),
    });
    await refusedWith(service.purchase(rungRequest()), 'stamp_refused', /this batch costs\.$/);
  });
});

describe('POST /api/admin-funding/batch-purchases for the catalogue', () => {
  it('buys an immutable batch on the catalogue node in place of the designated one, and records no archive batch', async () => {
    const { bee, currents, designator, journal, service } = setup();
    assert.equal((await service.purchase(catalogueRequest())).state, 'confirmed');
    assert.equal(bee.bought[0]?.label, 'catalogue-7d1e2f3a4b5c');
    assert.equal(bee.bought[0]?.immutable, true);
    assert.deepEqual(currents, ['catalogue catalogue']);
    assert.deepEqual(designator.asked, [], 'designated by the follow-up, never as an archive batch');
    assert.equal(journal.rows.get(REQUEST)?.recordedAt, null);
  });

  it('buys on the catalogue node alone, and in place of a batch that no longer pays', async () => {
    const stage = setup();
    await refusedWith(
      stage.service.purchase(catalogueRequest({ nodeId: RUNG })),
      'stamp_refused',
      'A catalogue batch is bought on the catalogue node alone, and this node is not the catalogue node.',
    );
    const active = setup({ catalogueBatch: { batchId: CATALOGUE_BATCH, state: 'active' } });
    await refusedWith(active.service.purchase(catalogueRequest()), 'stamp_refused', /^The catalogue batch still pays/);
  });
});

describe('a confirmed archive stamp made an archive batch', () => {
  it('is designated once, and a later status call never designates it again, after a restart too', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    const designator = new FakeDesignator();
    const first = setup({ journal, designator });
    await first.service.purchase(request());
    await first.service.status(REQUEST);
    const restarted = setup({ journal, designator });
    await restarted.service.status(REQUEST);
    assert.equal(designator.asked.length, 1);
  });

  it('whose designation failed stays unmarked, and the next status call designates it, after a restart too', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    const designator = new FakeDesignator();
    designator.failure = new Error('the archive batches could not be written');
    const first = setup({ journal, designator });
    assert.equal((await first.service.purchase(request())).state, 'confirmed');
    assert.equal(journal.rows.get(REQUEST)?.recordedAt, null);

    designator.failure = null;
    const restarted = setup({ journal, designator });
    assert.equal((await restarted.service.status(REQUEST)).state, 'confirmed');
    assert.equal(designator.asked.length, 2, 'designated again');
    assert.ok(journal.rows.get(REQUEST)?.recordedAt, 'and marked');
    await restarted.service.status(REQUEST);
    assert.equal(designator.asked.length, 2, 'and never again once marked');
  });

  it("whose batch has become the catalogue's stays confirmed and unrecorded, logged once", async (t) => {
    const lines: string[] = [];
    t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const designator = new FakeDesignator();
    designator.failure = new ArchiveBatchRefusedError('Batch 0x… holds the catalogue.');
    const { journal, service } = setup({ designator });
    assert.equal((await service.purchase(request())).state, 'confirmed');
    await service.status(REQUEST);
    await service.status(REQUEST);
    assert.equal(designator.asked.length, 3, 'asked again on each call');
    assert.equal(journal.rows.get(REQUEST)?.state, 'confirmed');
    assert.equal(journal.rows.get(REQUEST)?.recordedAt, null);
    const logged = lines.filter((line) => line.includes('is not made an archive batch'));
    assert.equal(logged.length, 1);
    assert.ok(logged[0]?.includes(REQUEST) && logged[0].includes(BOUGHT), logged[0]);
  });
});

describe('what the node answers a purchase', () => {
  const answers: Array<[string, () => Promise<{ batchID: string }>, 'failed' | 'unknown', RegExp]> = [
    [
      'a refusal, failed with Bee’s words',
      async () => {
        throw new BeeHttpError(402, 'bee POST /stamps/x/20 → 402: {"code":402,"message":"out of funds"}');
      },
      'failed',
      /^The node refused it \(402, “out of funds”\)\.$/,
    ],
    [
      'a 429 for another on-chain operation of the node’s, failed',
      async () => {
        throw new BeeHttpError(
          429,
          'bee POST /stamps/x/20 → 429: {"code":429,"message":"simultaneous on-chain operations not supported"}',
        );
      },
      'failed',
      /^The node refused it \(429, “simultaneous on-chain operations not supported”\)\.$/,
    ],
    [
      'a node still syncing, failed',
      async () => {
        throw new BeeHttpError(503, 'bee POST /stamps/x/20 → 503: {"code":503,"message":"syncing in progress"}');
      },
      'failed',
      /^The node refused it \(503/,
    ],
    [
      'a 500, unknown, since Bee answers one for a purchase it sent and lost sight of too',
      async () => {
        throw new BeeHttpError(500, 'bee POST /stamps/x/20 → 500: {"code":500,"message":"cannot create batch"}');
      },
      'unknown',
      /500, “cannot create batch”.*looked for among the node’s batches/,
    ],
    [
      'an answer that never came, unknown',
      async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      'unknown',
      /^The node’s answer was lost/,
    ],
    ['an answer with no batch id, unknown', async () => ({ batchID: 'not a batch' }), 'unknown', /no batch id/],
  ];

  for (const [what, answer, state, error] of answers) {
    it(`takes ${what}`, async () => {
      const { advanced, bee, designator, journal, service } = setup();
      bee.answer = answer;
      const answered = await service.purchase(request());
      assert.deepEqual(answered, { requestId: REQUEST, purpose: 'archive', state, batchId: null, txHash: null });
      const row = journal.rows.get(REQUEST)!;
      assert.match(row.error ?? '', error);
      assert.equal(row.step, state === 'failed' ? 'failed' : 'buying');
      assert.deepEqual(designator.asked, []);
      assert.deepEqual(advanced, [], 'nothing to follow up before it is bought');
    });
  }

  it('answers a node it could not connect to as node_unreachable, and journals the purchase failed', async () => {
    const { bee, journal, service } = setup();
    bee.answer = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' }),
      });
    };
    await refusedWith(service.purchase(request()), 'node_unreachable', /could not be reached/);
    assert.deepEqual([journal.rows.get(REQUEST)?.state, journal.rows.get(REQUEST)?.step], ['failed', 'failed']);
  });

  it('frees the node for the next purchase once one failed', async () => {
    const { bee, journal, service } = setup();
    bee.answer = async () => {
      throw new BeeHttpError(402, 'bee POST /stamps/x/20 → 402: {"code":402,"message":"out of funds"}');
    };
    await service.purchase(request());
    bee.answer = async () => ({ batchID: BOUGHT, txHash: TX }) as { batchID: string };
    assert.equal((await service.purchase(request({ requestId: OTHER_REQUEST }))).state, 'confirmed');
    assert.equal(journal.rows.get(OTHER_REQUEST)?.nodeLabel, OTHER_LABEL);
  });
});

describe('a purchase through the real BeeClient', () => {
  function fakeFetch(t: TestContext, status: number, body: unknown) {
    const sent: Array<{ url: string; method: string | undefined; immutable: string | null }> = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method, immutable: new Headers(init?.headers).get('immutable') });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    });
    return sent;
  }

  function realService() {
    const journal = new InMemoryFundingStampPurchaseJournal();
    const unreachable = (): Promise<never> => Promise.reject(new Error('not asked here'));
    const followUp = new FundingPurchaseFollowUp({
      journal,
      deployment: async (nodeId) => PROFILES[nodeId] ?? null,
      uploaderApiUrl: () => API,
      reads: (apiUrl) => new BeeClient(apiUrl),
      archiveBatches: { list: async () => [] },
      catalogue: { read: async () => emptyCatalogueDesignationRow() },
      designator: new FakeDesignator(),
      rungs: { current: unreachable, set: unreachable },
      stages: { look: unreachable },
      catalogueBatches: { current: unreachable, designate: unreachable, release: unreachable },
      now: () => START,
    });
    return new FundingBatchPurchaseService({
      journal,
      inventory: { inventory: async () => inventory() },
      deployment: async (nodeId) => PROFILES[nodeId] ?? null,
      uploaderApiUrl: () => API,
      node: (apiUrl) => new BeeClient(apiUrl),
      followUp: {
        settle: (row, apiUrl) => followUp.settle(row, apiUrl),
        usable: (batchId, apiUrl) => followUp.usable(batchId, apiUrl),
        designateArchive: (row, profileName) => followUp.designateArchive(row, profileName),
        advance: async () => undefined,
        restart: unreachable,
        check: unreachable,
        release: unreachable,
      },
      rungs: { current: async () => ({ batchId: REPLACED, state: 'expired' }) },
      catalogueBatches: { current: async () => ({ batchId: CATALOGUE_BATCH, state: 'gone' }) },
      now: () => START,
    });
  }

  it('sends a POST to the node’s /stamps with the amount, the depth, the label and immutable: true', async (t) => {
    const sent = fakeFetch(t, 201, { batchID: BOUGHT.toUpperCase(), txHash: TX });
    assert.deepEqual(await realService().purchase(request()), {
      requestId: REQUEST,
      purpose: 'archive',
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: TX,
    });
    assert.deepEqual(sent, [
      { url: `${API}/stamps/${AMOUNT}/${DEPTH}?label=${NODE_LABEL}`, method: 'POST', immutable: 'true' },
    ]);
  });

  it('sends immutable: false for a rung’s mutable batch, under the rung purchase’s label', async (t) => {
    const sent = fakeFetch(t, 201, { batchID: BOUGHT, txHash: TX });
    await realService().purchase(rungRequest());
    assert.deepEqual(sent, [
      { url: `${API}/stamps/${AMOUNT}/${DEPTH}?label=rung-7d1e2f3a4b5c`, method: 'POST', immutable: 'false' },
    ]);
  });
});

describe('GET /api/admin-funding/batch-purchases/:requestId', () => {
  it('answers 404 unknown_request for a request id never journalled', async () => {
    await refusedWith(setup().service.status(REQUEST), 'unknown_request', /safe/);
  });

  it('answers a bought batch with the node’s word on whether it can stamp yet, read on every call', async () => {
    const { bee, service } = setup();
    await service.purchase(request());
    bee.stamp = beeStamp(BOUGHT, { usable: false });
    const waiting = await service.status(REQUEST);
    assert.deepEqual(waiting, {
      requestId: REQUEST,
      purpose: 'archive',
      nodeId: CATALOGUE,
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: TX,
      usable: false,
      step: 'waiting_usable',
      error: null,
      stages: [],
      catalogue: null,
    });
    fundingBatchPurchaseStatusSchema.parse(waiting);
    bee.stamp = beeStamp(BOUGHT, { usable: true });
    assert.equal((await service.status(REQUEST)).usable, true);
    assert.equal(bee.stampReads, 2);
    assert.equal(bee.listReads, 0, 'a bought batch is never looked for');
  });

  it('answers usable as not known when the node could not be read, or answered about another batch', async () => {
    const { bee, service } = setup();
    await service.purchase(request());
    bee.stamp = new BeeHttpError(503, 'bee GET /stamps/x → 503: syncing');
    assert.equal((await service.status(REQUEST)).usable, null);
    bee.stamp = beeStamp(ANOTHERS);
    assert.equal((await service.status(REQUEST)).usable, null);
  });

  it('answers a failed purchase with no word on usability', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled({ state: 'failed', step: 'failed', error: 'The node refused it (402).' }));
    const { bee, service } = setup({ journal });
    const status = await service.status(REQUEST);
    assert.deepEqual(
      [status.state, status.step, status.batchId, status.usable, status.error],
      ['failed', 'failed', null, null, 'The node refused it (402).'],
    );
    assert.equal(bee.stampReads + bee.listReads, 0);
  });

  it('answers a rung purchase’s stages, and a catalogue purchase’s previous batch once designated', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    const set = {
      state: 'confirmed' as const,
      batchId: `0x${BOUGHT}`,
      boughtAt: new Date(START),
      setAt: new Date(START),
    };
    journal.rows.set(REQUEST, journalled({ ...set, purpose: 'rung', nodeId: RUNG, immutable: false, step: 'set' }));
    journal.stages.set(REQUEST, [
      {
        stageId: ABR_STAGE,
        name: 'stage-abr',
        position: 0,
        apply: 'waiting_live',
        message: null,
        forcedAt: null,
        updatedAt: new Date(START),
      },
    ]);
    journal.rows.set(
      OTHER_REQUEST,
      journalled({
        ...set,
        requestId: OTHER_REQUEST,
        nodeLabel: purchaseNodeLabel('catalogue', OTHER_REQUEST),
        purpose: 'catalogue',
        step: 'set',
        previousBatchId: `0x${CATALOGUE_BATCH}`,
      }),
    );
    const { service } = setup({ journal });
    const rung = await service.status(REQUEST);
    assert.deepEqual(rung.stages, [{ stageId: ABR_STAGE, name: 'stage-abr', apply: 'waiting_live', message: null }]);
    assert.equal(rung.catalogue, null);
    const catalogue = await service.status(OTHER_REQUEST);
    assert.deepEqual(catalogue.catalogue, { previousBatchId: `0x${CATALOGUE_BATCH}`, released: false });
    assert.deepEqual(catalogue.stages, []);
    fundingBatchPurchaseStatusSchema.parse(rung);
    fundingBatchPurchaseStatusSchema.parse(catalogue);
  });

  it('settles an unknown purchase by its exact label, depth and immutability, and makes its batch an archive batch', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { advanced, bee, designator, service } = setup({ journal });
    bee.stamps = [
      beeStamp('a1'.repeat(32), { label: 'recordings' }),
      beeStamp('a2'.repeat(32), { label: `${NODE_LABEL}0` }),
      beeStamp('a3'.repeat(32), { depth: DEPTH + 1 }),
      beeStamp('a4'.repeat(32), { immutableFlag: false }),
      beeStamp(BOUGHT, { usable: true }),
    ];
    const status = await service.status(REQUEST);
    assert.deepEqual(
      [status.state, status.batchId, status.txHash, status.usable, status.step],
      ['confirmed', `0x${BOUGHT}`, null, true, 'waiting_usable'],
    );
    assert.equal(bee.stampReads, 0, 'the usability is the one the list answered');
    assert.deepEqual(designator.asked, [
      {
        batchId: BOUGHT,
        profileName: 'catalogue',
        depth: DEPTH,
        label: 'Autumn event',
        designatedBy: null,
        purchaseRequestId: REQUEST,
      },
    ]);
    assert.ok(journal.rows.get(REQUEST)?.recordedAt);
    assert.deepEqual(advanced, [REQUEST], 'the follow-up takes it from there');
  });

  it('never takes the catalogue’s batch or an archive batch under the label, and fails after thirty minutes', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { later, bee, service } = setup({
      journal,
      archived: [archived(ANOTHERS), archived(BOUGHT, { source: 'purchase', purchaseRequestId: REQUEST })],
    });
    bee.stamps = [beeStamp(CATALOGUE_BATCH), beeStamp(ANOTHERS), beeStamp(BOUGHT)];
    assert.equal((await service.status(REQUEST)).state, 'unknown');
    later(ARCHIVE_PURCHASE_SETTLE_MS + 1);
    const failed = await service.status(REQUEST);
    assert.deepEqual([failed.state, failed.step, failed.batchId], ['failed', 'failed', null]);
    assert.match(failed.error ?? '', /lists no batch under this purchase’s label thirty minutes after/);
  });

  it('never takes the batch a pending catalogue move left, and takes the one that is neither', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { bee, designation, service } = setup({ journal });
    Object.assign(designation, {
      movingFromProfileName: 'catalogue',
      movingFromBatchId: ANOTHERS,
      movingFromBatchDepth: DEPTH,
      moveStartedAt: new Date(START),
    });
    bee.stamps = [beeStamp(ANOTHERS), beeStamp(BOUGHT)];
    const settled = await service.status(REQUEST);
    assert.deepEqual([settled.state, settled.batchId], ['confirmed', `0x${BOUGHT}`]);
  });

  it('fails an unknown purchase the node lists no batch for thirty minutes after it was journalled, not before', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { later, service } = setup({ journal });
    later(ARCHIVE_PURCHASE_SETTLE_MS);
    assert.equal((await service.status(REQUEST)).state, 'unknown');
    later(FUNDING_STATUS_READ_MS);
    assert.equal((await service.status(REQUEST)).state, 'failed');
    assert.equal(journal.rows.get(REQUEST)?.state, 'failed', 'and the node is free for another purchase');
  });

  it('keeps an unknown purchase unknown while the node cannot be read or its deployment is gone, past the half hour', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { later, bee, service } = setup({ journal });
    bee.stamps = new Error('connect ECONNREFUSED');
    later(ARCHIVE_PURCHASE_SETTLE_MS + 1);
    assert.equal((await service.status(REQUEST)).state, 'unknown');
    const gone = setup({ journal, gone: true });
    gone.later(ARCHIVE_PURCHASE_SETTLE_MS + 1);
    assert.equal((await gone.service.status(REQUEST)).state, 'unknown');
    assert.equal(gone.bee.listReads, 0);
  });

  it('reads the node’s batches for a request id at most once every five seconds, answering the journal in between', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { later, bee, service } = setup({ journal });
    await service.status(REQUEST);
    await service.status(REQUEST);
    assert.equal(bee.listReads, 1);
    later(FUNDING_STATUS_READ_MS);
    bee.stamps = [beeStamp(BOUGHT)];
    assert.equal((await service.status(REQUEST)).state, 'confirmed');
    assert.equal(bee.listReads, 2);
  });
});

describe('the node’s answer and a status call, settling one row', () => {
  it('writes the node’s hash onto a row a status call confirmed from the node’s batches while the node was asked', async () => {
    const { bee, journal, service } = setup();
    bee.onBuy = async () => {
      bee.stamps = [beeStamp(BOUGHT)];
      assert.equal((await service.status(REQUEST)).state, 'confirmed');
    };
    assert.deepEqual(await service.purchase(request()), {
      requestId: REQUEST,
      purpose: 'archive',
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: TX,
    });
    const row = journal.rows.get(REQUEST);
    assert.deepEqual([row?.state, row?.txHash, row?.step], ['confirmed', TX, 'waiting_usable']);
  });

  it('keeps a row a status call confirmed when the node then answers a 500', async () => {
    const { bee, journal, service } = setup();
    bee.onBuy = async () => {
      bee.stamps = [beeStamp(BOUGHT)];
      await service.status(REQUEST);
    };
    bee.answer = async () => {
      throw new BeeHttpError(500, 'bee POST /stamps/x/20 → 500: {"code":500,"message":"cannot create batch"}');
    };
    assert.equal((await service.purchase(request())).state, 'confirmed');
    assert.deepEqual([journal.rows.get(REQUEST)?.state, journal.rows.get(REQUEST)?.error], ['confirmed', null]);
  });

  it('keeps the step the follow-up reached when the node’s hash comes after it', async () => {
    const { bee, journal, service } = setup();
    bee.onBuy = async () => {
      bee.stamps = [beeStamp(BOUGHT)];
      await service.status(REQUEST);
      const row = journal.rows.get(REQUEST)!;
      journal.rows.set(REQUEST, { ...row, step: 'done' });
    };
    await service.purchase(request());
    assert.deepEqual([journal.rows.get(REQUEST)?.txHash, journal.rows.get(REQUEST)?.step], [TX, 'done']);
  });
});

describe('the three calls under a purchase', () => {
  it('hand each to the follow-up and answer the purchase’s status after', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled({ state: 'confirmed', step: 'done', batchId: `0x${BOUGHT}` }));
    const { calls, service } = setup({ journal });
    assert.equal((await service.restart(REQUEST, ABR_STAGE)).requestId, REQUEST);
    assert.equal((await service.check(REQUEST)).step, 'done');
    assert.equal((await service.release(REQUEST)).requestId, REQUEST);
    assert.deepEqual(calls, [`restart ${REQUEST} ${ABR_STAGE}`, `check ${REQUEST}`, `release ${REQUEST}`]);
  });
});

describe('the archive-only route of an older admin', () => {
  it('buys an archive stamp as a batch purchase of purpose archive, answered in its own shape', async () => {
    const { bee, journal, service } = setup();
    const answer = await service.purchaseArchive({
      requestId: REQUEST,
      nodeId: CATALOGUE,
      depth: DEPTH,
      amountPerChunkPlur: AMOUNT,
      label: 'Autumn event',
    });
    assert.deepEqual(answer, { requestId: REQUEST, state: 'confirmed', batchId: `0x${BOUGHT}`, txHash: TX });
    fundingStampPurchaseAnswerSchema.parse(answer);
    const row = journal.rows.get(REQUEST);
    assert.deepEqual([row?.purpose, row?.immutable, row?.replacesBatchId], ['archive', true, null]);
    assert.equal(bee.bought[0]?.immutable, true);
    assert.deepEqual(
      await service.purchase(request()),
      { requestId: REQUEST, purpose: 'archive', state: 'confirmed', batchId: `0x${BOUGHT}`, txHash: TX },
      'the same purchase on the batch route',
    );
  });

  it('answers a purchase’s state in its own shape, with no error for a confirmed one whatever its step', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(
      REQUEST,
      journalled({
        state: 'confirmed',
        step: 'failed',
        batchId: `0x${BOUGHT}`,
        error: 'The batch holds the catalogue.',
      }),
    );
    const { service } = setup({ journal });
    const status = await service.archiveStatus(REQUEST);
    assert.deepEqual(status, {
      requestId: REQUEST,
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: null,
      usable: false,
      error: null,
    });
    fundingStampPurchaseStatusSchema.parse(status);
  });

  it('answers 404 unknown_request for a rung’s or the catalogue’s purchase, which only the batch route reads', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(
      REQUEST,
      journalled({ purpose: 'rung', nodeId: RUNG, immutable: false, nodeLabel: purchaseNodeLabel('rung', REQUEST) }),
    );
    journal.rows.set(
      OTHER_REQUEST,
      journalled({
        requestId: OTHER_REQUEST,
        purpose: 'catalogue',
        nodeLabel: purchaseNodeLabel('catalogue', OTHER_REQUEST),
      }),
    );
    const { bee, service } = setup({ journal });
    for (const requestId of [REQUEST, OTHER_REQUEST]) {
      await refusedWith(service.archiveStatus(requestId), 'unknown_request', /No archive stamp purchase/);
    }
    assert.equal(bee.listReads + bee.stampReads, 0, 'nothing is read for it on the older route');
    assert.equal((await service.status(REQUEST)).purpose, 'rung', 'the batch route reads it');
  });
});
