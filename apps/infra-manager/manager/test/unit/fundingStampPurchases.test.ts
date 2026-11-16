/**
 * The funding API's stamp purchases: an archive stamp, a new immutable batch on the catalogue node, checked against
 * the inventory, journalled, then asked of the node once under the purchase's own label; and its state, settled from
 * the node's own list of batches when the node's answer was lost, with the node's word on whether the batch is usable.
 *
 * Unit test, no database, no chain and no Bee node: a fake inventory, an in-memory journal, a fake node that buys and
 * is read, fakes of the archive batches' two ports, and the real BeeClient over a faked fetch where the request it
 * sends matters. Nothing reaches a network and no money moves. `pnpm test` in manager/.
 *
 * Every refusal is answered before anything is journalled or asked: 422 `stamp_refused` with a sentence for a check
 * that failed, 404 `unknown_node` for a node the manager does not run, 409 `conflict` for a node with another purchase
 * still being settled on it.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import {
  ARCHIVE_PURCHASE_SETTLE_MS,
  type ArchiveBatchDesignation,
  archivePurchaseNodeLabel,
  plurToBzzExact,
} from '@streaming-infra-manager/common';
import {
  type FundingInventory,
  type FundingNode,
  type FundingNodeRole,
  type FundingStampPurchaseRequest,
  fundingStampPurchaseAnswerSchema,
  fundingStampPurchaseStatusSchema,
} from '@streaming-monorepo/contracts';

import { BeeClient, type BeeStamp, type BuyStampInput } from '../../src/domain/BeeClient.js';
import { BeeHttpError } from '../../src/domain/errors/BeeHttpError.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';
import { FUNDING_STATUS_READ_MS } from '../../src/domain/funding/FundingChainService.js';
import { FUNDING_BZZ_TOKEN } from '../../src/domain/funding/FundingInventoryService.js';
import type { FundingStampPurchaseRow } from '../../src/domain/funding/FundingStampPurchaseJournal.js';
import {
  type FundingStampPurchaseNode,
  type FundingStampPurchaseReads,
  FundingStampPurchaseService,
} from '../../src/domain/funding/FundingStampPurchaseService.js';
import type { ArchiveBatchToDesignate } from '../../src/domain/stages/archiveBatchPorts.js';
import type { Profile } from '../../src/types/index.js';
import { emptyCatalogueDesignationRow } from '../support/InMemoryCatalogueDesignation.js';
import { InMemoryFundingStampPurchaseJournal } from '../support/InMemoryFundingStampPurchaseJournal.js';
import { makeProfile } from '../support/profileFixtures.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const STAGE = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const CATALOGUE_ID = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf';
const NODE = `${STAGE}:bee-uploader`;
const CATALOGUE = `${CATALOGUE_ID}:bee-uploader`;
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const OTHER_REQUEST = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
/** Another request id that begins with the same twelve hex digits as REQUEST. */
const LOOKALIKE_REQUEST = '7d1e2f3a-4b5c-4fff-8aaa-bbbbbbbbbbbb';
const NODE_LABEL = archivePurchaseNodeLabel(REQUEST);
const OTHER_LABEL = archivePurchaseNodeLabel(OTHER_REQUEST);
/** The catalogue's own batch, as the designation keeps it, and the batch a purchase buys, as Bee spells them. */
const CATALOGUE_BATCH = 'ef'.repeat(32);
const BOUGHT = 'c5'.repeat(32);
const ANOTHERS = 'd6'.repeat(32);
const TX = `0x${'9a'.repeat(32)}`;
/** Thirty days at 24000 PLUR a chunk a block: 518400 blocks of it. */
const AMOUNT = '12441600000';
/** The postage contract's floor at that price: a day, 17280 blocks. */
const FLOOR = '414720000';
const DEPTH = 20;
/** That amount for each of a depth 20 batch's 2^20 chunks, in PLUR: 1.30459631616 xBZZ. */
const COST = (BigInt(AMOUNT) << BigInt(DEPTH)).toString();
const START = Date.parse('2026-11-13T10:00:00.000Z');
const API = 'http://catalogue.invalid:1633';
const BUSY =
  'Another archive stamp purchase on this node is still being settled, and both would spend the same wallet. Try again once it is.';

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

/** One stage and the catalogue node, at 24000 PLUR a chunk a block. */
function inventory(): FundingInventory {
  return {
    observedAt: '2026-11-13T10:00:00.000Z',
    chain: {
      chainId: 100,
      bzzToken: FUNDING_BZZ_TOKEN,
      postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
    },
    stages: [{ stageId: STAGE, name: 'stage-one', nodes: [node(NODE, 'stage-one Bee node', 'uploader')] }],
    catalogue: node(CATALOGUE, 'catalogue catalogue node', 'uploader'),
    archiveBatches: [],
  };
}

/** A batch as Bee lists it in `GET /stamps`, under the purchase's label by default. */
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

/** The catalogue node's Bee API: what it was asked to buy, and what it answers when read. */
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

  at(apiUrl: string): FundingStampPurchaseNode {
    return {
      buyStamp: async (input) => {
        this.bought.push({ ...input, apiUrl });
        await this.onBuy();
        return this.answer();
      },
    };
  }

  reads(): FundingStampPurchaseReads {
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

const CATALOGUE_PROFILE: Profile = makeProfile({
  name: 'catalogue',
  kind: 'custom',
  instance_id: CATALOGUE_ID,
  components: ['bee-uploader'],
  port_slot: 5,
});

interface SetupOptions {
  edit?: (inventory: FundingInventory) => void;
  journal?: InMemoryFundingStampPurchaseJournal;
  designator?: FakeDesignator;
  /** The archive batches the manager keeps. */
  archived?: ArchiveBatchDesignation[];
  /** The catalogue node's deployment gone. */
  gone?: boolean;
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
  const service = new FundingStampPurchaseService({
    journal,
    inventory: {
      inventory: async () => {
        inventoryReads += 1;
        const answer = inventory();
        options.edit?.(answer);
        return answer;
      },
    },
    deployment: async (nodeId) => (nodeId === CATALOGUE && !options.gone ? CATALOGUE_PROFILE : null),
    uploaderApiUrl: (profile) => {
      assert.equal(profile.name, 'catalogue');
      return API;
    },
    node: (apiUrl) => bee.at(apiUrl),
    reads: () => bee.reads(),
    archiveBatches: { list: async () => options.archived ?? [] },
    catalogue: { read: async () => designation },
    designator,
    now: () => now,
  });
  return {
    service,
    journal,
    bee,
    designator,
    designation,
    inventoryReads: () => inventoryReads,
    advance: (ms: number) => void (now += ms),
  };
}

function request(over: Partial<FundingStampPurchaseRequest> = {}): FundingStampPurchaseRequest {
  return {
    requestId: REQUEST,
    nodeId: CATALOGUE,
    depth: DEPTH,
    amountPerChunkPlur: AMOUNT,
    label: 'Autumn event',
    ...over,
  };
}

/** A row as a manager that stopped between the journal and the node's answer leaves it. */
function journalled(over: Partial<FundingStampPurchaseRow> = {}): FundingStampPurchaseRow {
  return {
    requestId: REQUEST,
    nodeId: CATALOGUE,
    depth: DEPTH,
    amountPerChunkPlur: AMOUNT,
    costPlur: COST,
    label: 'Autumn event',
    nodeLabel: NODE_LABEL,
    batchId: null,
    txHash: null,
    state: 'unknown',
    error: null,
    createdAt: new Date(START),
    updatedAt: new Date(START),
    recordedAt: null,
    ...over,
  };
}

/** The other purchase, left open on the catalogue node. */
const otherOpen = () => journalled({ requestId: OTHER_REQUEST, nodeLabel: OTHER_LABEL });

async function refusedWith(promise: Promise<unknown>, code: string, expected?: RegExp | string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof FundingApiError, String(err));
    assert.equal(err.code, code);
    if (typeof expected === 'string') assert.equal(err.message, expected);
    else if (expected) assert.match(err.message, expected);
    return true;
  });
}

describe('POST /api/admin-funding/stamp-purchases', () => {
  it('journals the purchase before it asks the node, buys an immutable batch under its own label, and confirms it', async () => {
    const { bee, journal, service } = setup();
    const atBuy: { row: FundingStampPurchaseRow | null } = { row: null };
    bee.onBuy = async () => void (atBuy.row = await journal.find(REQUEST));

    const answer = await service.purchase(request());
    assert.deepEqual(answer, { requestId: REQUEST, state: 'confirmed', batchId: `0x${BOUGHT}`, txHash: TX });
    fundingStampPurchaseAnswerSchema.parse(answer);

    assert.equal(NODE_LABEL, 'archive-7d1e2f3a4b5c', 'the first twelve hex digits of the request id');
    assert.deepEqual([atBuy.row?.state, atBuy.row?.nodeLabel], ['unknown', NODE_LABEL], 'journalled before the node');
    assert.deepEqual(bee.bought, [{ apiUrl: API, amount: AMOUNT, depth: DEPTH, label: NODE_LABEL, immutable: true }]);
    const row = journal.rows.get(REQUEST)!;
    assert.deepEqual(
      [row.costPlur, row.label, row.batchId, row.txHash, row.state, row.error],
      [COST, 'Autumn event', `0x${BOUGHT}`, TX, 'confirmed', null],
    );
  });

  it('makes the bought batch an archive batch on the catalogue node, and marks the purchase recorded', async () => {
    const { designator, journal, service } = setup();
    await service.purchase(request());
    assert.deepEqual(designator.asked, [
      {
        batchId: BOUGHT,
        profileName: 'catalogue',
        depth: request().depth,
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
    for (const other of [{ depth: 21 }, { amountPerChunkPlur: FLOOR }, { label: 'Winter' }, { label: null }]) {
      await refusedWith(service.purchase(request(other)), 'conflict', 'This request id names another stamp purchase.');
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

  it('answers 409 conflict while another purchase on the node is still being settled, asking the node nothing', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(OTHER_REQUEST, otherOpen());
    const { bee, service } = setup({ journal });
    await refusedWith(service.purchase(request()), 'conflict', BUSY);
    assert.equal(bee.bought.length, 0);
    assert.equal(journal.rows.has(REQUEST), false);
    assert.equal(bee.listReads, 1, 'the open purchase was looked for on the node first');
  });

  it('settles an open purchase the node lists as bought first, makes its batch an archive batch, then buys', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(OTHER_REQUEST, otherOpen());
    const { bee, designator, service } = setup({ journal });
    bee.stamps = [beeStamp(ANOTHERS, { label: OTHER_LABEL })];
    assert.equal((await service.purchase(request())).state, 'confirmed');
    assert.deepEqual(
      [journal.rows.get(OTHER_REQUEST)?.state, journal.rows.get(OTHER_REQUEST)?.batchId],
      ['confirmed', `0x${ANOTHERS}`],
    );
    assert.deepEqual(
      designator.asked.map((batch) => [batch.purchaseRequestId, batch.batchId]),
      [
        [OTHER_REQUEST, ANOTHERS],
        [REQUEST, BOUGHT],
      ],
    );
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
    journal.rows.set(REQUEST, journalled({ state: 'failed', error: 'The node refused it (402).' }));
    const { bee, service } = setup({ journal });
    await refusedWith(service.purchase(request({ requestId: LOOKALIKE_REQUEST })), 'conflict', /new request id/);
    assert.equal(bee.bought.length, 0);
    assert.equal(journal.rows.has(LOOKALIKE_REQUEST), false);
  });
});

describe('a confirmed purchase made an archive batch', () => {
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
      const { bee, designator, journal, service } = setup();
      bee.answer = answer;
      const answered = await service.purchase(request());
      assert.deepEqual(answered, { requestId: REQUEST, state, batchId: null, txHash: null });
      assert.match(journal.rows.get(REQUEST)?.error ?? '', error);
      assert.deepEqual(designator.asked, []);
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
    assert.equal(journal.rows.get(REQUEST)?.state, 'failed');
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

  it('sends a POST to the node’s /stamps with the amount, the depth, the label and immutable: true', async (t) => {
    const sent = fakeFetch(t, 201, { batchID: BOUGHT.toUpperCase(), txHash: TX });
    const { designator, journal } = setup();
    const service = new FundingStampPurchaseService({
      journal,
      inventory: { inventory: async () => inventory() },
      deployment: async () => CATALOGUE_PROFILE,
      uploaderApiUrl: () => API,
      node: (apiUrl) => new BeeClient(apiUrl),
      reads: (apiUrl) => new BeeClient(apiUrl),
      archiveBatches: { list: async () => [] },
      catalogue: { read: async () => emptyCatalogueDesignationRow() },
      designator,
      now: () => START,
    });
    assert.deepEqual(await service.purchase(request()), {
      requestId: REQUEST,
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: TX,
    });
    assert.deepEqual(sent, [
      { url: `${API}/stamps/${AMOUNT}/${DEPTH}?label=${NODE_LABEL}`, method: 'POST', immutable: 'true' },
    ]);
  });
});

describe('GET /api/admin-funding/stamp-purchases/:requestId', () => {
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
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: TX,
      usable: false,
      error: null,
    });
    fundingStampPurchaseStatusSchema.parse(waiting);
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
    journal.rows.set(REQUEST, journalled({ state: 'failed', error: 'The node refused it (402).' }));
    const { bee, service } = setup({ journal });
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      state: 'failed',
      batchId: null,
      txHash: null,
      usable: null,
      error: 'The node refused it (402).',
    });
    assert.equal(bee.stampReads + bee.listReads, 0);
  });

  it('settles an unknown purchase by its exact label, depth and immutability, and makes its batch an archive batch', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { bee, designator, service } = setup({ journal });
    bee.stamps = [
      beeStamp('a1'.repeat(32), { label: 'recordings' }),
      beeStamp('a2'.repeat(32), { label: `${NODE_LABEL}0` }),
      beeStamp('a3'.repeat(32), { depth: DEPTH + 1 }),
      beeStamp('a4'.repeat(32), { immutableFlag: false }),
      beeStamp(BOUGHT, { usable: true }),
    ];
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: null,
      usable: true,
      error: null,
    });
    assert.equal(bee.stampReads, 0, 'the usability is the one the list answered');
    assert.deepEqual(designator.asked, [
      {
        batchId: BOUGHT,
        profileName: 'catalogue',
        depth: request().depth,
        label: 'Autumn event',
        designatedBy: null,
        purchaseRequestId: REQUEST,
      },
    ]);
    assert.ok(journal.rows.get(REQUEST)?.recordedAt);
  });

  it('never takes the catalogue’s batch or an archive batch under the label, and fails after thirty minutes', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { advance, bee, service } = setup({
      journal,
      archived: [archived(ANOTHERS), archived(BOUGHT, { source: 'purchase', purchaseRequestId: REQUEST })],
    });
    bee.stamps = [beeStamp(CATALOGUE_BATCH), beeStamp(ANOTHERS), beeStamp(BOUGHT)];
    assert.equal((await service.status(REQUEST)).state, 'unknown');
    advance(ARCHIVE_PURCHASE_SETTLE_MS + 1);
    const failed = await service.status(REQUEST);
    assert.deepEqual([failed.state, failed.batchId], ['failed', null]);
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
    const { advance, service } = setup({ journal });
    advance(ARCHIVE_PURCHASE_SETTLE_MS);
    assert.equal((await service.status(REQUEST)).state, 'unknown');
    advance(FUNDING_STATUS_READ_MS);
    assert.equal((await service.status(REQUEST)).state, 'failed');
    assert.equal(journal.rows.get(REQUEST)?.state, 'failed', 'and the node is free for another purchase');
  });

  it('keeps an unknown purchase unknown while the node cannot be read or its deployment is gone, past the half hour', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { advance, bee, service } = setup({ journal });
    bee.stamps = new Error('connect ECONNREFUSED');
    advance(ARCHIVE_PURCHASE_SETTLE_MS + 1);
    assert.equal((await service.status(REQUEST)).state, 'unknown');
    const gone = setup({ journal, gone: true });
    gone.advance(ARCHIVE_PURCHASE_SETTLE_MS + 1);
    assert.equal((await gone.service.status(REQUEST)).state, 'unknown');
    assert.equal(gone.bee.listReads, 0);
  });

  it('reads the node’s batches for a request id at most once every five seconds, answering the journal in between', async () => {
    const journal = new InMemoryFundingStampPurchaseJournal();
    journal.rows.set(REQUEST, journalled());
    const { advance, bee, service } = setup({ journal });
    await service.status(REQUEST);
    await service.status(REQUEST);
    assert.equal(bee.listReads, 1);
    advance(FUNDING_STATUS_READ_MS);
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
      state: 'confirmed',
      batchId: `0x${BOUGHT}`,
      txHash: TX,
    });
    assert.deepEqual([journal.rows.get(REQUEST)?.state, journal.rows.get(REQUEST)?.txHash], ['confirmed', TX]);
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
});
