/**
 * What `GET /api/admin-funding/inventory` answers: every stage's nodes and the brand's catalogue node, each with its
 * wallet and its batch as the node reports them, or the reason they could not be read, and the price of postage.
 *
 * Unit test, no database, no Docker and no Bee node: fake deployments, a fake designation, and fake wallets, batches
 * and chain states. `pnpm test` in manager/.
 *
 * A stage's nodes are its own Bee node, its gateway when that runs light (an ultra-light gateway has no wallet), and
 * the rungs of its pool, each found among this manager's deployments by the batch it stamps with. Each node's batch
 * is the one the manager uploads with through it: the stage's own, the rung's, or the designated catalogue batch. A
 * node is named by an opaque id and a label, never by its Bee API address, and nothing else that would reach a node
 * or the chain is answered either.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beePublishersValue } from '@streaming-infra-manager/common';
import { type FundingInventory, type FundingNode, fundingInventorySchema } from '@streaming-monorepo/contracts';

import type { BeeChainState, BeeStamp, BeeWallet } from '../../src/domain/BeeClient.js';
import { BeeHttpError } from '../../src/domain/errors/index.js';
import {
  FUNDING_BLOCK_SECONDS,
  FUNDING_BZZ_TOKEN,
  FUNDING_CHAIN_ID,
  FUNDING_MINIMUM_VALIDITY_BLOCKS,
  FundingInventoryService,
} from '../../src/domain/funding/FundingInventoryService.js';
import { emptyCatalogueDesignationRow } from '../support/InMemoryCatalogueDesignation.js';
import { makeProfile } from '../support/profileFixtures.js';
import type { Profile } from '../../src/types/index.js';

const STREAMER_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const LIGHT_ID = '5addbf83-7192-43a4-bf40-6b7c8d9eafb0';
const ABR_ID = '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c';
const ABR_TWO_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const RUNG_360_ID = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d';
const RUNG_720_ID = '3ebc9d61-5f70-4182-9d2e-4f5a6b7c8d9e';
const CATALOGUE_ID = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf';
const BATCH_OWN = 'e5'.repeat(32);
const BATCH_360 = 'a1'.repeat(32);
const BATCH_720 = 'b2'.repeat(32);
const BATCH_ELSEWHERE = 'c3'.repeat(32);
const BATCH_CATALOGUE = 'd4'.repeat(32);
const BATCH_MOVED_FROM = 'f6'.repeat(32);
const WALLET = '0x1111111111111111111111111111111111111111';
const RPC = 'https://rpc.example.org/secret-path';
const OBSERVED = new Date('2026-10-05T10:00:00.000Z');

/** Each node's Bee API in these tests, by the port its deployment's slot gives it. */
const OWN_URL = 'http://bee.internal:10015';
const GATEWAY_URL = 'http://bee.internal:10067';
const RUNG_720_URL = 'http://bee.internal:10035';
const RUNG_360_URL = 'http://bee.internal:10045';
const CATALOGUE_URL = 'http://bee.internal:10055';

const POOL = beePublishersValue([
  { rungName: '720p', url: 'http://192.0.2.10:10035', batchId: BATCH_720 },
  { rungName: '360p', url: 'http://192.0.2.10:10045', batchId: BATCH_360 },
  { rungName: '1080p', url: 'http://198.51.100.7:10055', batchId: BATCH_ELSEWHERE },
]);

function profiles(): Profile[] {
  return [
    makeProfile({
      name: 'stage-one',
      kind: 'streamer',
      instance_id: STREAMER_ID,
      components: ['stream-uploader', 'srs', 'bee-uploader'],
      rpc_endpoint: RPC,
      stamp_id: `0x${BATCH_OWN.toUpperCase()}`,
    }),
    makeProfile({
      name: 'stage-light',
      kind: 'streamer',
      instance_id: LIGHT_ID,
      components: ['stream-uploader', 'srs', 'bee-gateway'],
      node_mode: 'light',
      port_slot: 6,
    }),
    makeProfile({
      name: 'stage-abr',
      kind: 'abr-uploader',
      instance_id: ABR_ID,
      components: ['stream-uploader', 'srs'],
      port_slot: 2,
      bee_publishers: POOL,
    }),
    makeProfile({
      name: 'pool-720p',
      kind: 'custom',
      instance_id: RUNG_720_ID,
      components: ['bee-uploader'],
      port_slot: 3,
      stamp_id: `0x${BATCH_720.toUpperCase()}`,
      group_id: 4,
    }),
    makeProfile({
      name: 'pool-360p',
      kind: 'custom',
      instance_id: RUNG_360_ID,
      components: ['bee-uploader'],
      port_slot: 4,
      stamp_id: BATCH_360,
      group_id: 4,
    }),
    makeProfile({
      name: 'catalogue',
      kind: 'custom',
      instance_id: CATALOGUE_ID,
      components: ['bee-uploader'],
      port_slot: 5,
      host: 'deploy@bee-1',
    }),
    makeProfile({ name: 'viewer', kind: 'viewer', instance_id: '6beec094-82a3-44b5-a051-7c8d9eafb0c1' }),
  ];
}

const wallet = (over: Partial<BeeWallet> = {}): BeeWallet => ({
  walletAddress: WALLET.toUpperCase().replace('0X', '0x'),
  nativeTokenBalance: '250000000000000000',
  bzzBalance: '10000000000000000',
  chainID: 100,
  chequebookContractAddress: '0x2222222222222222222222222222222222222222',
  ...over,
});

/** A batch as Bee answers `GET /stamps/{id}`: depth 22 in 2^16 buckets, its fullest holding 16 of their 64 chunks. */
const stamp = (batchId: string, over: Partial<BeeStamp> = {}): BeeStamp => ({
  batchID: batchId,
  utilization: 16,
  usable: true,
  label: 'recordings',
  depth: 22,
  amount: '1000000000',
  bucketDepth: 16,
  blockNumber: 39_000_000,
  immutableFlag: true,
  exists: true,
  batchTTL: 1_296_000,
  ...over,
});

const chainState = (over: Partial<BeeChainState> = {}): BeeChainState => ({
  chainTip: 39_000_100,
  block: 39_000_100,
  totalAmount: '123456789',
  currentPrice: '24000',
  ...over,
});

interface Setup {
  designated?: string | null;
  /** A pending move: the batch the catalogue moved from, on the catalogue node. */
  movingFrom?: string;
  profiles?: (list: Profile[]) => Profile[];
  walletAt?: (url: string) => Promise<BeeWallet>;
  stampAt?: (url: string, batchId: string) => Promise<BeeStamp>;
  chainStateAt?: (url: string) => Promise<BeeChainState>;
  uploaderApiUrl?: (profile: Profile) => string;
  gatewayApiUrl?: (profile: Profile) => Promise<string>;
}

function service(setup: Setup = {}) {
  const asked: string[] = [];
  const stampsAsked: string[] = [];
  const chainAsked: string[] = [];
  const row = emptyCatalogueDesignationRow();
  const designated = setup.designated === undefined ? 'catalogue' : setup.designated;
  if (designated) {
    Object.assign(row, { profileName: designated, batchId: BATCH_CATALOGUE, batchDepth: 20, designatedAt: OBSERVED });
  }
  if (setup.movingFrom) {
    Object.assign(row, {
      movingFromProfileName: 'catalogue',
      movingFromBatchId: setup.movingFrom,
      movingFromBatchDepth: 20,
      moveStartedAt: OBSERVED,
    });
  }
  const inventory = new FundingInventoryService({
    profiles: { list: async () => (setup.profiles ? setup.profiles(profiles()) : profiles()) },
    catalogue: { read: async () => row },
    uploaderApiUrl: setup.uploaderApiUrl ?? ((profile) => `http://bee.internal:${10005 + profile.port_slot * 10}`),
    gatewayApiUrl: setup.gatewayApiUrl ?? (async (profile) => `http://bee.internal:${10007 + profile.port_slot * 10}`),
    wallet: async (url) => {
      asked.push(url);
      return setup.walletAt ? setup.walletAt(url) : wallet();
    },
    stamp: async (url, batchId) => {
      stampsAsked.push(`${url} ${batchId}`);
      return setup.stampAt ? setup.stampAt(url, batchId) : stamp(batchId);
    },
    chainState: async (url) => {
      chainAsked.push(url);
      return setup.chainStateAt ? setup.chainStateAt(url) : chainState();
    },
    now: () => OBSERVED,
  });
  return { inventory, asked, stampsAsked, chainAsked };
}

/** Every node the answer lists, the catalogue node included, by its id. */
function nodesById(answer: FundingInventory): Map<string, FundingNode> {
  const nodes = [...answer.stages.flatMap((stage) => stage.nodes), ...(answer.catalogue ? [answer.catalogue] : [])];
  return new Map(nodes.map((node) => [node.nodeId, node]));
}

const unreadBatch = (batchId: string, readError: string) => ({
  batchId: `0x${batchId}`,
  depth: null,
  immutable: null,
  usable: null,
  ttlSeconds: null,
  fillRatio: null,
  readError,
});

describe('the funding inventory', () => {
  it('lists each stage with its own node, its light gateway and its pool’s rungs, lowest rung first', async () => {
    const { inventory } = service();
    const answer = await inventory.inventory();
    assert.equal(answer.observedAt, OBSERVED.toISOString());
    assert.deepEqual(
      answer.stages.map((stage) => [stage.name, stage.nodes.map((node) => [node.nodeId, node.role, node.label])]),
      [
        ['stage-one', [[`${STREAMER_ID}:bee-uploader`, 'uploader', 'stage-one Bee node']]],
        ['stage-light', [[`${LIGHT_ID}:bee-gateway`, 'gateway', 'stage-light gateway']]],
        [
          'stage-abr',
          [
            [`${RUNG_360_ID}:bee-uploader`, 'rung', 'stage-abr 360p rung, pool-360p'],
            [`${RUNG_720_ID}:bee-uploader`, 'rung', 'stage-abr 720p rung, pool-720p'],
          ],
        ],
      ],
    );
    assert.equal(answer.stages[0]!.stageId, STREAMER_ID);
  });

  it('reads each node’s wallet: its address in lower case and its balances in base units', async () => {
    const { inventory } = service();
    const { batch: _batch, ...node } = (await inventory.inventory()).stages[0]!.nodes[0]!;
    assert.deepEqual(node, {
      nodeId: `${STREAMER_ID}:bee-uploader`,
      label: 'stage-one Bee node',
      role: 'uploader',
      walletAddress: WALLET,
      xdaiWei: '250000000000000000',
      xbzzPlur: '10000000000000000',
      readError: null,
    });
  });

  it('answers the designated catalogue node, and none when nothing is designated', async () => {
    const designated = await service().inventory.inventory();
    assert.equal(designated.catalogue?.nodeId, `${CATALOGUE_ID}:bee-uploader`);
    assert.equal(designated.catalogue?.label, 'catalogue catalogue node');
    assert.equal(designated.catalogue?.role, 'uploader');
    assert.equal((await service({ designated: null }).inventory.inventory()).catalogue, null);
  });

  it('answers Gnosis Chain and its BZZ token', async () => {
    const { chain } = await service().inventory.inventory();
    assert.equal(FUNDING_CHAIN_ID, 100);
    assert.equal(FUNDING_BZZ_TOKEN, '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da');
    assert.deepEqual(
      { chainId: chain.chainId, bzzToken: chain.bzzToken },
      { chainId: FUNDING_CHAIN_ID, bzzToken: FUNDING_BZZ_TOKEN },
    );
  });

  it('gives a node it could not read a reason in a sentence, with no wallet, and never the node’s address', async () => {
    const { inventory } = service({
      walletAt: async (url) => {
        if (url === OWN_URL) throw new Error(`bee request GET /wallet failed: connect ECONNREFUSED ${url}`);
        if (url === RUNG_360_URL) throw new BeeHttpError(503, `bee GET /wallet → 503: ${url} syncing`);
        if (url === RUNG_720_URL)
          throw new Error('bee request GET /wallet failed: The operation was aborted due to timeout');
        return wallet();
      },
    });
    const answer = await inventory.inventory();
    const byId = nodesById(answer);
    const own = byId.get(`${STREAMER_ID}:bee-uploader`)!;
    assert.equal(own.walletAddress, null);
    assert.equal(own.xdaiWei, null);
    assert.equal(own.xbzzPlur, null);
    assert.match(own.readError ?? '', /could not be reached/);
    assert.match(byId.get(`${RUNG_360_ID}:bee-uploader`)!.readError ?? '', /refused/);
    assert.match(byId.get(`${RUNG_720_ID}:bee-uploader`)!.readError ?? '', /in time/);
    assert.equal(answer.catalogue?.readError, null, 'the other nodes are read regardless');
    assert.ok(!JSON.stringify(answer).includes('bee.internal'), 'a node address is in the answer');
  });

  it('says in a sentence of its own when a gateway’s address could not be worked out, and asks it nothing', async () => {
    const { inventory, asked, chainAsked } = service({
      gatewayApiUrl: async () => {
        throw new Error('The stack version v3 is not ready to deploy from: its settings are not captured');
      },
    });
    const gateway = (await inventory.inventory()).stages[1]!.nodes[0]!;
    assert.equal(gateway.role, 'gateway');
    assert.equal(gateway.walletAddress, null);
    assert.equal(gateway.readError, 'The gateway’s address could not be worked out on this manager.');
    assert.equal(gateway.batch, null, 'a gateway uploads with no batch');
    assert.ok(![...asked, ...chainAsked].includes(GATEWAY_URL), 'a gateway with no address was asked');
  });

  it('refuses the wallet of a node on another chain, and one that names no address', async () => {
    const { inventory } = service({
      walletAt: async (url) =>
        url === OWN_URL
          ? wallet({ chainID: 11155111 })
          : url === RUNG_360_URL
            ? wallet({ walletAddress: undefined })
            : wallet(),
    });
    const answer = await inventory.inventory();
    const own = answer.stages[0]!.nodes[0]!;
    assert.equal(own.walletAddress, null);
    assert.match(own.readError ?? '', /chain 11155111/);
    const rung = answer.stages[2]!.nodes[0]!;
    assert.equal(rung.walletAddress, null);
    assert.match(rung.readError ?? '', /no wallet address/);
  });

  it('reads each node once, however many stages name it', async () => {
    const { inventory, asked } = service();
    await inventory.inventory();
    assert.equal(new Set(asked).size, asked.length);
  });

  it('answers what the contract takes, with no address, RPC endpoint or key of any node in it', async () => {
    const answer = await service().inventory.inventory();
    assert.deepEqual(fundingInventorySchema.parse(answer), answer);
    const text = JSON.stringify(answer);
    for (const secret of [RPC, 'bee.internal', '192.0.2.10', '198.51.100.7', 'deploy@bee-1']) {
      assert.ok(!text.includes(secret), `the answer carries ${secret}`);
    }
  });
});

describe('each node’s batch in the funding inventory', () => {
  it('answers the stage’s own batch, each rung’s, the designated catalogue batch, and none for a gateway', async () => {
    const answer = await service().inventory.inventory();
    const byId = nodesById(answer);
    assert.deepEqual(
      [...byId.values()].map((node) => [node.nodeId, node.batch?.batchId ?? null]),
      [
        [`${STREAMER_ID}:bee-uploader`, `0x${BATCH_OWN}`],
        [`${LIGHT_ID}:bee-gateway`, null],
        [`${RUNG_360_ID}:bee-uploader`, `0x${BATCH_360}`],
        [`${RUNG_720_ID}:bee-uploader`, `0x${BATCH_720}`],
        [`${CATALOGUE_ID}:bee-uploader`, `0x${BATCH_CATALOGUE}`],
      ],
    );
  });

  it('reads each batch from its own node, by its id without 0x and in lower case', async () => {
    const { inventory, stampsAsked } = service();
    await inventory.inventory();
    assert.deepEqual(
      stampsAsked.sort(),
      [
        `${RUNG_720_URL} ${BATCH_720}`,
        `${RUNG_360_URL} ${BATCH_360}`,
        `${CATALOGUE_URL} ${BATCH_CATALOGUE}`,
        `${OWN_URL} ${BATCH_OWN}`,
      ].sort(),
    );
  });

  it('answers what the node reports: depth, kind, usable, time left and the fullest bucket’s fill', async () => {
    const { inventory } = service({
      stampAt: async (url, batchId) =>
        url === RUNG_360_URL
          ? stamp(batchId, { depth: 20, utilization: 15, immutableFlag: false, usable: false, batchTTL: 86_400 })
          : stamp(batchId),
    });
    const byId = nodesById(await inventory.inventory());
    assert.deepEqual(byId.get(`${STREAMER_ID}:bee-uploader`)!.batch, {
      batchId: `0x${BATCH_OWN}`,
      depth: 22,
      immutable: true,
      usable: true,
      ttlSeconds: 1_296_000,
      fillRatio: 0.25,
      readError: null,
    });
    assert.deepEqual(byId.get(`${RUNG_360_ID}:bee-uploader`)!.batch, {
      batchId: `0x${BATCH_360}`,
      depth: 20,
      immutable: false,
      usable: false,
      ttlSeconds: 86_400,
      fillRatio: 15 / 16,
      readError: null,
    });
  });

  it('answers no batch for a stage’s own node with none set, and asks its node about none', async () => {
    const { inventory, stampsAsked } = service({
      profiles: (list) =>
        list.map((profile) => (profile.name === 'stage-one' ? { ...profile, stamp_id: null } : profile)),
    });
    const own = (await inventory.inventory()).stages[0]!.nodes[0]!;
    assert.equal(own.batch, null);
    assert.equal(own.walletAddress, WALLET, 'its wallet is read all the same');
    assert.ok(!stampsAsked.some((read) => read.startsWith(OWN_URL)));
  });

  it('never reads or answers the batch a pending catalogue move left', async () => {
    const { inventory, stampsAsked } = service({ movingFrom: BATCH_MOVED_FROM });
    const answer = await inventory.inventory();
    assert.equal(answer.catalogue?.batch?.batchId, `0x${BATCH_CATALOGUE}`);
    assert.ok(!stampsAsked.some((read) => read.includes(BATCH_MOVED_FROM)), 'the batch moved from was read');
    assert.ok(!JSON.stringify(answer).includes(BATCH_MOVED_FROM), 'the batch moved from is answered');
  });

  it('says in a sentence why a batch could not be read, with no reading, and reads the wallet regardless', async () => {
    const { inventory } = service({
      stampAt: async (url, batchId) => {
        if (url === OWN_URL)
          throw new Error(`bee request GET /stamps/${batchId} failed: The operation was aborted due to timeout`);
        if (url === RUNG_360_URL)
          throw new BeeHttpError(404, `bee GET /stamps/${batchId} → 404: issuer does not exist`);
        if (url === RUNG_720_URL) throw new BeeHttpError(503, `bee GET /stamps/${batchId} → 503: syncing`);
        return stamp(BATCH_ELSEWHERE);
      },
    });
    const byId = nodesById(await inventory.inventory());
    assert.deepEqual(
      byId.get(`${STREAMER_ID}:bee-uploader`)!.batch,
      unreadBatch(BATCH_OWN, 'The node did not answer in time.'),
    );
    assert.deepEqual(
      byId.get(`${RUNG_360_ID}:bee-uploader`)!.batch,
      unreadBatch(BATCH_360, 'The node does not hold this batch: it expired and was dropped, or it is another node’s.'),
    );
    assert.deepEqual(
      byId.get(`${RUNG_720_ID}:bee-uploader`)!.batch,
      unreadBatch(BATCH_720, 'The node refused to say how this batch stands.'),
    );
    assert.deepEqual(
      byId.get(`${CATALOGUE_ID}:bee-uploader`)!.batch,
      unreadBatch(BATCH_CATALOGUE, 'The node answered something that is not this batch.'),
      'an answer about another batch',
    );
    for (const node of byId.values()) {
      if (node.role !== 'gateway') assert.equal(node.walletAddress, WALLET, `${node.label}'s wallet was not read`);
    }
  });

  it('calls a batch gone from the chain, and an answer missing what a batch has, unread', async () => {
    const { inventory } = service({
      stampAt: async (url, batchId) => {
        if (url === OWN_URL) return stamp(batchId, { exists: false });
        if (url === RUNG_360_URL) return { ...stamp(batchId), depth: 22.5 };
        if (url === RUNG_720_URL) return { ...stamp(batchId), usable: undefined } as unknown as BeeStamp;
        return null as unknown as BeeStamp;
      },
    });
    const byId = nodesById(await inventory.inventory());
    assert.deepEqual(
      byId.get(`${STREAMER_ID}:bee-uploader`)!.batch,
      unreadBatch(BATCH_OWN, 'The batch is gone from the chain: it expired.'),
    );
    for (const [id, batchId] of [
      [RUNG_360_ID, BATCH_360],
      [RUNG_720_ID, BATCH_720],
      [CATALOGUE_ID, BATCH_CATALOGUE],
    ] as const) {
      assert.deepEqual(
        byId.get(`${id}:bee-uploader`)!.batch,
        unreadBatch(batchId, 'The node answered something that is not this batch.'),
      );
    }
  });

  it('answers an expired batch with 0 left, and a time left or fill Bee could not work out as not known', async () => {
    const { inventory } = service({
      stampAt: async (url, batchId) => {
        if (url === OWN_URL) return stamp(batchId, { batchTTL: -1 });
        if (url === RUNG_360_URL) return stamp(batchId, { batchTTL: 0, usable: false });
        if (url === RUNG_720_URL) return stamp(batchId, { utilization: 65 });
        return { ...stamp(batchId), bucketDepth: undefined } as unknown as BeeStamp;
      },
    });
    const byId = nodesById(await inventory.inventory());
    const own = byId.get(`${STREAMER_ID}:bee-uploader`)!.batch!;
    assert.deepEqual([own.ttlSeconds, own.readError], [null, null], 'a negative time left is not expired');
    const expired = byId.get(`${RUNG_360_ID}:bee-uploader`)!.batch!;
    assert.deepEqual([expired.ttlSeconds, expired.usable, expired.readError], [0, false, null]);
    const overfull = byId.get(`${RUNG_720_ID}:bee-uploader`)!.batch!;
    assert.deepEqual([overfull.fillRatio, overfull.depth], [null, 22], '65 chunks where a bucket holds 64');
    assert.equal(byId.get(`${CATALOGUE_ID}:bee-uploader`)!.batch!.fillRatio, null, 'no bucket depth');
  });

  it('answers a node whose address could not be worked out with its batch unread for the same reason', async () => {
    const { inventory, stampsAsked } = service({
      uploaderApiUrl: (profile) => {
        if (profile.name === 'stage-one') throw new Error('no address for this deployment');
        return `http://bee.internal:${10005 + profile.port_slot * 10}`;
      },
    });
    const own = (await inventory.inventory()).stages[0]!.nodes[0]!;
    assert.equal(own.readError, 'The node’s address could not be worked out on this manager.');
    assert.deepEqual(own.batch, unreadBatch(BATCH_OWN, 'The node’s address could not be worked out on this manager.'));
    assert.ok(!stampsAsked.some((read) => read.includes(BATCH_OWN)), 'a node with no address was asked');
  });

  it('reads each node’s wallet, batch and chain state once when two stages share a pool', async () => {
    const { inventory, asked, stampsAsked, chainAsked } = service({
      profiles: (list) => [
        ...list,
        makeProfile({
          name: 'stage-abr-two',
          kind: 'abr-uploader',
          instance_id: ABR_TWO_ID,
          components: ['stream-uploader', 'srs'],
          port_slot: 7,
          bee_publishers: POOL,
        }),
      ],
    });
    const answer = await inventory.inventory();
    const shared = answer.stages.filter((stage) => stage.name.startsWith('stage-abr'));
    assert.equal(shared.length, 2);
    assert.deepEqual(
      shared[0]!.nodes,
      shared[1]!.nodes.map((node) => ({ ...node, label: node.label.replace('stage-abr-two', 'stage-abr') })),
    );
    for (const reads of [asked, stampsAsked, chainAsked]) assert.equal(new Set(reads).size, reads.length);
  });
});

describe('the price of postage in the funding inventory', () => {
  it('answers the price of the first node listed on Gnosis Chain, its block time and the contract’s floor', async () => {
    const { inventory } = service({
      walletAt: async (url) => (url === OWN_URL ? wallet({ chainID: 11155111 }) : wallet()),
      chainStateAt: async (url) =>
        chainState({ currentPrice: url === OWN_URL ? '99999' : url === GATEWAY_URL ? '24000' : '30000' }),
    });
    const { chain } = await inventory.inventory();
    assert.equal(FUNDING_BLOCK_SECONDS, 5);
    assert.equal(FUNDING_MINIMUM_VALIDITY_BLOCKS, 17280, 'a day of five-second blocks');
    assert.deepEqual(chain.postage, {
      pricePerChunkPerBlockPlur: '24000',
      blockSeconds: 5,
      minimumValidityBlocks: 17280,
    });
  });

  it('skips a chain state that did not answer or names no price, and takes a price written as a number', async () => {
    const { inventory } = service({
      chainStateAt: async (url) => {
        if (url === OWN_URL)
          throw new Error('bee request GET /chainstate failed: The operation was aborted due to timeout');
        if (url === GATEWAY_URL) return chainState({ currentPrice: '0' });
        if (url === RUNG_360_URL) return chainState({ currentPrice: '1.5' });
        return chainState({ currentPrice: 26000 as unknown as string });
      },
    });
    const { chain } = await inventory.inventory();
    assert.equal(chain.postage?.pricePerChunkPerBlockPlur, '26000');
  });

  it('answers no price when no node’s chain state names one', async () => {
    const { inventory } = service({
      chainStateAt: async (url) => {
        if (url === CATALOGUE_URL) return { chainTip: 1, block: 1, totalAmount: '0' } as unknown as BeeChainState;
        throw new BeeHttpError(503, 'bee GET /chainstate → 503: syncing');
      },
    });
    const answer = await inventory.inventory();
    assert.equal(answer.chain.postage, null);
    assert.deepEqual(fundingInventorySchema.parse(answer), answer);
  });

  it('answers no price when every node with a chain state is on another chain', async () => {
    const { inventory } = service({ walletAt: async () => wallet({ chainID: 11155111 }) });
    assert.equal((await inventory.inventory()).chain.postage, null);
  });
});
