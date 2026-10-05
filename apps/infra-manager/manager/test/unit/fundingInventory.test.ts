/**
 * What `GET /api/admin-funding/inventory` answers: every stage's nodes and the brand's catalogue node, each with its
 * wallet as the node reports it, or the reason it could not be read.
 *
 * Unit test, no database, no Docker and no Bee node: fake deployments, a fake designation and fake wallets.
 * `pnpm test` in manager/.
 *
 * A stage's nodes are its own Bee node, its gateway when that runs light (an ultra-light gateway has no wallet), and
 * the rungs of its pool, each found among this manager's deployments by the batch it stamps with. A node is named by
 * an opaque id and a label, never by its Bee API address, and nothing else that would reach a node or the chain is
 * answered either.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beePublishersValue } from '@streaming-infra-manager/common';
import { fundingInventorySchema } from '@streaming-monorepo/contracts';

import type { BeeWallet } from '../../src/domain/BeeClient.js';
import { BeeHttpError } from '../../src/domain/errors/index.js';
import {
  FUNDING_BZZ_TOKEN,
  FUNDING_CHAIN_ID,
  FundingInventoryService,
} from '../../src/domain/funding/FundingInventoryService.js';
import { emptyCatalogueDesignationRow } from '../support/InMemoryCatalogueDesignation.js';
import { makeProfile } from '../support/profileFixtures.js';
import type { Profile } from '../../src/types/index.js';

const STREAMER_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const LIGHT_ID = '5addbf83-7192-43a4-bf40-6b7c8d9eafb0';
const ABR_ID = '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c';
const RUNG_360_ID = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d';
const RUNG_720_ID = '3ebc9d61-5f70-4182-9d2e-4f5a6b7c8d9e';
const CATALOGUE_ID = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf';
const BATCH_360 = 'a1'.repeat(32);
const BATCH_720 = 'b2'.repeat(32);
const BATCH_ELSEWHERE = 'c3'.repeat(32);
const WALLET = '0x1111111111111111111111111111111111111111';
const RPC = 'https://rpc.example.org/secret-path';
const OBSERVED = new Date('2026-10-05T10:00:00.000Z');

function profiles(): Profile[] {
  return [
    makeProfile({
      name: 'stage-one',
      kind: 'streamer',
      instance_id: STREAMER_ID,
      components: ['stream-uploader', 'srs', 'bee-uploader'],
      rpc_endpoint: RPC,
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
      bee_publishers: beePublishersValue([
        { rungName: '720p', url: 'http://192.0.2.10:10035', batchId: BATCH_720 },
        { rungName: '360p', url: 'http://192.0.2.10:10045', batchId: BATCH_360 },
        { rungName: '1080p', url: 'http://198.51.100.7:10055', batchId: BATCH_ELSEWHERE },
      ]),
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

interface Setup {
  designated?: string | null;
  walletAt?: (url: string) => Promise<BeeWallet>;
  gatewayApiUrl?: (profile: Profile) => Promise<string>;
}

function service(setup: Setup = {}) {
  const asked: string[] = [];
  const row = emptyCatalogueDesignationRow();
  const designated = setup.designated === undefined ? 'catalogue' : setup.designated;
  if (designated) {
    Object.assign(row, { profileName: designated, batchId: 'd4'.repeat(32), batchDepth: 20, designatedAt: OBSERVED });
  }
  const inventory = new FundingInventoryService({
    profiles: { list: async () => profiles() },
    catalogue: { read: async () => row },
    uploaderApiUrl: (profile) => `http://bee.internal:${10005 + profile.port_slot * 10}`,
    gatewayApiUrl: setup.gatewayApiUrl ?? (async (profile) => `http://bee.internal:${10007 + profile.port_slot * 10}`),
    wallet: async (url) => {
      asked.push(url);
      return setup.walletAt ? setup.walletAt(url) : wallet();
    },
    now: () => OBSERVED,
  });
  return { inventory, asked };
}

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
    const node = (await inventory.inventory()).stages[0]!.nodes[0]!;
    assert.deepEqual(
      { ...node },
      {
        nodeId: `${STREAMER_ID}:bee-uploader`,
        label: 'stage-one Bee node',
        role: 'uploader',
        walletAddress: WALLET,
        xdaiWei: '250000000000000000',
        xbzzPlur: '10000000000000000',
        readError: null,
      },
    );
  });

  it('answers the designated catalogue node, and none when nothing is designated', async () => {
    const designated = await service().inventory.inventory();
    assert.equal(designated.catalogue?.nodeId, `${CATALOGUE_ID}:bee-uploader`);
    assert.equal(designated.catalogue?.label, 'catalogue catalogue node');
    assert.equal(designated.catalogue?.role, 'uploader');
    assert.equal((await service({ designated: null }).inventory.inventory()).catalogue, null);
  });

  it('answers Gnosis Chain and its BZZ token', async () => {
    const answer = await service().inventory.inventory();
    assert.equal(FUNDING_CHAIN_ID, 100);
    assert.equal(FUNDING_BZZ_TOKEN, '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da');
    assert.deepEqual(answer.chain, { chainId: FUNDING_CHAIN_ID, bzzToken: FUNDING_BZZ_TOKEN });
  });

  it('gives a node it could not read a reason in a sentence, with no wallet, and never the node’s address', async () => {
    const { inventory } = service({
      walletAt: async (url) => {
        if (url.endsWith(':10015')) throw new Error(`bee request GET /wallet failed: connect ECONNREFUSED ${url}`);
        if (url.endsWith(':10045')) throw new BeeHttpError(503, `bee GET /wallet → 503: ${url} syncing`);
        if (url.endsWith(':10035'))
          throw new Error('bee request GET /wallet failed: The operation was aborted due to timeout');
        return wallet();
      },
    });
    const answer = await inventory.inventory();
    const nodes = [...answer.stages.flatMap((stage) => stage.nodes), answer.catalogue!];
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
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
    const { inventory, asked } = service({
      gatewayApiUrl: async () => {
        throw new Error('The stack version v3 is not ready to deploy from: its settings are not captured');
      },
    });
    const gateway = (await inventory.inventory()).stages[1]!.nodes[0]!;
    assert.equal(gateway.role, 'gateway');
    assert.equal(gateway.walletAddress, null);
    assert.equal(gateway.readError, 'The gateway’s address could not be worked out on this manager.');
    assert.ok(!asked.some((url) => url.endsWith(':10067')), 'a gateway with no address was asked');
  });

  it('refuses the wallet of a node on another chain, and one that names no address', async () => {
    const { inventory } = service({
      walletAt: async (url) =>
        url.endsWith(':10015')
          ? wallet({ chainID: 11155111 })
          : url.endsWith(':10045')
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
