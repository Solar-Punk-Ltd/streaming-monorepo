/**
 * The archive's purchase confirm as the console calls it, over HTTP: POST /api/archive/:id/confirm-purchase for an
 * archive waiting for a stamp. A confirm that names another archive is refused with nothing recorded, a price that moved is refused with the new cost and nothing recorded, a manager with no
 * purchase route is answered as such, and a confirm the manager takes records the purchase and takes the place. Sign-in
 * is stood in for by a middleware that signs every request in as the test operator; the node, the store and the
 * manager are in memory.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  archiveBatchCostPlur,
  smallestArchiveDepthFor,
  type FundingInventory,
  type FundingStampPurchaseAnswer,
  type FundingStampPurchaseRequest,
  type FundingStampPurchaseStatus,
} from '@streaming-monorepo/contracts';
import {
  ARCHIVE_PATH,
  ARCHIVE_PURCHASES_NOT_OFFERED,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  archiveConfirmPurchasePath,
  type ArchiveCurrentResponse,
} from '@streaming-monorepo/web2-admin-common';
import express, { type RequestHandler } from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createArchiveRouter } from '../../src/api/routes/archive.js';
import { ArchiveService } from '../../src/domain/archive/ArchiveService.js';
import { ChunkCopier } from '../../src/domain/archive/ChunkCopier.js';
import { ManagerFundingError } from '../../src/domain/funding/ManagerFundingClient.js';
import { userRow } from './support/authFixtures.js';
import {
  buildFile,
  FakeArchiveNode,
  FakeCatalogue,
  InMemoryArchiveStore,
  playlistText,
  slotFor,
} from './support/archiveFakes.js';
import { FakeRenditions, FakeStreams } from './support/exportFakes.js';
import { InMemoryAuditLog, streamRow, TEST_OPERATOR } from './support/fakes.js';

const OWNER = '1234567890abcdef1234567890abcdef12345678';
const TOPIC = '0b7c3a1e-2f44-5d66-8a77-99aabbccddee';
/** 30 days of postage for a chunk at a price per chunk per block: 518,400 five-second blocks. */
const thirtyDays = (price: bigint) => (518_400n * price).toString();

class FakeManager {
  readonly requests: FundingStampPurchaseRequest[] = [];
  refusal: ManagerFundingError | null = null;
  readonly inventoryValue = {
    observedAt: new Date().toISOString(),
    chain: {
      chainId: 100,
      bzzToken: `0x${'1'.repeat(40)}`,
      postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
    },
    stages: [],
    catalogue: {
      nodeId: 'catalogue-node',
      label: 'catalogue',
      role: 'uploader',
      walletAddress: `0x${'2'.repeat(40)}`,
      xdaiWei: '1000000000000000000',
      xbzzPlur: '10000000000000000000',
      readError: null,
      chequebook: null,
    },
  } as unknown as FundingInventory;

  async inventory(): Promise<FundingInventory> {
    return this.inventoryValue;
  }

  async stampPurchase(request: FundingStampPurchaseRequest): Promise<FundingStampPurchaseAnswer> {
    this.requests.push(request);
    if (this.refusal) throw this.refusal;
    return { requestId: request.requestId, state: 'unknown', batchId: null, txHash: null };
  }

  async stampPurchaseStatus(requestId: string): Promise<FundingStampPurchaseStatus> {
    return { requestId, state: 'unknown', batchId: null, txHash: null, usable: null, error: null };
  }

  setPrice(price: string): void {
    this.inventoryValue.chain.postage!.pricePerChunkPerBlockPlur = price;
  }
}

const streams = new FakeStreams();
const store = new InMemoryArchiveStore((id) => streams.rows.get(id)?.title ?? null);
const node = new FakeArchiveNode();
const manager = new FakeManager();
let service: ArchiveService;
let server: http.Server;
let url: string;
let depth: number;

const signedIn: RequestHandler = (req, _res, next) => {
  req.user = userRow({ id: TEST_OPERATOR.userId, username: TEST_OPERATOR.username });
  req.sessionTokenHash = 'test-session';
  next();
};

/** Confirms for the archive waiting for a stamp, or for the job named. */
function confirm(body: unknown, jobId: string = store.job!.id): Promise<Response> {
  return fetch(`${url}${archiveConfirmPurchasePath(jobId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE },
    body: JSON.stringify(body),
  });
}

before(async () => {
  // A finished single-quality recording of three segments, its playlist on the node.
  const stream = streamRow({
    id: 'stream-1',
    title: 'Alps',
    owner: OWNER,
    topic: TOPIC,
    status: 'vod',
    manifest_index: 5,
    duration_seconds: 6,
  });
  streams.rows.set(stream.id, stream);
  const files = [0, 1, 2].map((at) => buildFile(new Uint8Array(Buffer.alloc(40 * 1024, `seg${at}`)), 1));
  for (const file of files) for (const [address, chunk] of file.chunks) node.network.set(address, chunk);
  slotFor(OWNER, TOPIC, 5, playlistText(files.map((file) => file.root)), node.network);

  service = new ArchiveService(
    store,
    streams,
    new FakeRenditions(),
    new FakeCatalogue(),
    node,
    new ChunkCopier(node, { retryDelaysMs: [1] }),
    manager,
    { republishWithState: async () => undefined },
    { exportHoldingPlace: async () => null },
    new InMemoryAuditLog(),
    {
      settings: {
        parallelChunks: 4,
        pushWindowChunks: 100,
        chequebookFloorPlur: '0',
        ttlWarningDays: 30,
        buyDefaultDays: 30,
      },
      watchIntervalMs: 60_000,
      pollMs: 1,
      purchaseAnswerWaitMs: 50,
    },
  );
  await service.start(TEST_OPERATOR, stream.id, { renditions: ['source'], target: { buyNew: true } });
  await service.settled();
  assert.equal(store.job?.state, 'awaiting_purchase');
  depth = smallestArchiveDepthFor(store.job!.chunks_total!)!;

  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(ARCHIVE_PATH, createArchiveRouter({ archiveService: service, requireAuth: signedIn }));
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not report a port');
  url = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await service.shutdown();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('POST /api/archive/:id/confirm-purchase', () => {
  it('refuses a confirm that names another archive, recording nothing and asking nothing of the manager', async () => {
    const costPlur = archiveBatchCostPlur(depth, thirtyDays(24_000n));
    const res = await confirm({ depth, days: 30, label: null, costPlur }, '0f1e2d3c-4b5a-4968-8776-655443322110');

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: 'archive_refused',
      problem: 'not_now',
      message: 'The archive moved on, so it cannot buy a stamp now.',
    });
    assert.equal(store.purchases.size, 0, 'nothing recorded');
    assert.equal(manager.requests.length, 0, 'nothing asked of the manager');
    assert.equal(store.job?.state, 'awaiting_purchase');
  });

  it('refuses a path whose id is no job id', async () => {
    const costPlur = archiveBatchCostPlur(depth, thirtyDays(24_000n));
    const res = await confirm({ depth, days: 30, label: null, costPlur }, 'current');

    assert.equal(res.status, 400);
    assert.equal(store.purchases.size, 0, 'nothing recorded');
    assert.equal(manager.requests.length, 0, 'nothing asked of the manager');
  });

  it('refuses a cost the price no longer gives, with the new cost, recording nothing', async () => {
    const oldCost = archiveBatchCostPlur(depth, thirtyDays(24_000n));
    const newCost = archiveBatchCostPlur(depth, thirtyDays(25_000n));
    manager.setPrice('25000');
    const res = await confirm({ depth, days: 30, label: null, costPlur: oldCost });
    manager.setPrice('24000');

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; problem: string; message: string };
    assert.equal(body.error, 'archive_refused');
    assert.equal(body.problem, 'price_moved');
    assert.ok(body.message.includes(newCost), body.message);
    assert.equal(store.purchases.size, 0, 'nothing recorded');
    assert.equal(manager.requests.length, 0, 'nothing asked of the manager');
    assert.equal(store.job?.state, 'awaiting_purchase');
  });

  it('answers a manager that offers no purchases, and leaves the archive waiting for a confirm', async () => {
    manager.refusal = new ManagerFundingError('bad_answer', 404, 'The manager answered with status 404.');
    const res = await confirm({
      depth,
      days: 30,
      label: null,
      costPlur: archiveBatchCostPlur(depth, thirtyDays(24_000n)),
    });
    manager.refusal = null;

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: 'archive_refused',
      problem: 'purchases_not_offered',
      message: ARCHIVE_PURCHASES_NOT_OFFERED,
    });
    assert.equal(store.job?.state, 'awaiting_purchase');
    assert.equal(store.job?.purchase_id, null);
    assert.ok(
      [...store.purchases.values()].every((row) => row.state === 'failed'),
      'nothing left under way',
    );
  });

  it('records the purchase, asks the manager once, and takes the place, answering the archive buying', async () => {
    const asked = manager.requests.length;
    const costPlur = archiveBatchCostPlur(depth, thirtyDays(24_000n));
    const res = await confirm({ depth, days: 30, label: 'Alps archive', costPlur });

    assert.equal(res.status, 200);
    const { archive } = (await res.json()) as ArchiveCurrentResponse;
    assert.equal(archive?.state, 'buying');
    assert.equal(archive?.holdsPlace, true);
    const purchase = [...store.purchases.values()].find((row) => row.state === 'buying')!;
    assert.deepEqual(
      [purchase.depth, purchase.days, purchase.cost_plur, purchase.label],
      [depth, 30, costPlur, 'Alps archive'],
    );
    assert.equal(store.job?.purchase_id, purchase.id);
    assert.equal(manager.requests.length, asked + 1, 'the manager asked once');
    assert.deepEqual(manager.requests.at(-1), {
      requestId: purchase.id,
      nodeId: 'catalogue-node',
      depth,
      amountPerChunkPlur: thirtyDays(24_000n),
      label: 'Alps archive',
    });
    assert.notEqual(await service.archiveHoldingPlace(), null, 'an export cannot start meanwhile');
  });
});
