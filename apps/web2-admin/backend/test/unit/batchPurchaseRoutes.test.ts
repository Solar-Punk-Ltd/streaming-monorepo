/**
 * The batch purchase routes of the Funding page over HTTP: the real router, session gate, cross-site check and error
 * mapping on a random port, mounted as `src/api/server.ts` mounts them, with the purchase service over its fakes and
 * the users and sessions in memory. `pnpm test`.
 *
 * Pinned here: a start answers 202 with the purchase and takes no password; a body that is not a purchase is 400, and
 * nothing is asked of the manager; a refusal is 409 with its problem; an id never written is 404 and one that is not a
 * UUID is 400; Restart now and Check again answer the purchase or the refusal; and every route wants a session.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  type BatchPurchase,
  type BatchPurchasesResponse,
  FUNDING_BATCH_PURCHASES_ADMIN_PATH,
  FUNDING_PATH,
  fundingBatchPurchaseAdminPath,
  fundingBatchPurchaseCheckAdminPath,
  fundingBatchPurchaseRestartAdminPath,
} from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createFundingRouter } from '../../src/api/routes/funding.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { BatchPurchaseService } from '../../src/domain/funding/BatchPurchaseService.js';
import { FundingChequebookService } from '../../src/domain/funding/FundingChequebookService.js';
import { FundingService } from '../../src/domain/funding/FundingService.js';
import { FundingStampService } from '../../src/domain/funding/FundingStampService.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { type AuthTestApp, call, signIn } from './support/authTestApp.js';
import {
  BOUGHT,
  costOf,
  FakeCatalogueMove,
  FakePurchaseManager,
  FOLLOWING_STAGE,
  InMemoryBatchPurchaseStore,
  purchaseStatus,
} from './support/batchPurchaseFakes.js';
import { InMemoryAuditLog } from './support/fakes.js';
import {
  BATCH_RUNG,
  FakeFundingManager,
  FakeFundingWallet,
  InMemoryFundingChequebookStore,
  InMemoryFundingPinStore,
  InMemoryFundingStampStore,
  InMemoryFundingTransferStore,
  NODE_RUNG,
} from './support/fundingFakes.js';

const USERNAME = 'alice';
const PASSWORD = 'a-long-enough-password';

interface PurchaseTestApp extends AuthTestApp {
  manager: FakePurchaseManager;
  store: InMemoryBatchPurchaseStore;
}

async function startPurchaseTestApp(): Promise<PurchaseTestApp> {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const audit = new InMemoryAuditLog();
  const authService = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  const store = new InMemoryBatchPurchaseStore();
  const manager = new FakePurchaseManager(store);
  const fundingManager = new FakeFundingManager();
  const fundingService = new FundingService({
    wallet: new FakeFundingWallet(),
    manager: fundingManager,
    transfers: new InMemoryFundingTransferStore(),
    pins: new InMemoryFundingPinStore(),
    stamps: new FundingStampService({ manager: fundingManager, journal: new InMemoryFundingStampStore(), audit }),
    chequebooks: new FundingChequebookService({
      manager: fundingManager,
      journal: new InMemoryFundingChequebookStore(),
      audit,
    }),
    purchases: new BatchPurchaseService({ manager, store, move: new FakeCatalogueMove(), audit, waitMs: 1_000 }),
    audit,
  });
  const requireAuth = createRequireAuth(authService);

  const app = express();
  app.use(requireSameSite);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/auth', createAuthRouter(authService, requireAuth));
  app.use(FUNDING_PATH, createFundingRouter({ fundingService, authService, requireAuth }));
  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not report a port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    authService,
    users,
    sessions,
    audit,
    manager,
    store,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let app: PurchaseTestApp;
let cookie: string;

const purchaseCall = (method: string, path: string, body?: unknown) => call(app, method, path, { cookie, body });

const rung = (over: Record<string, unknown> = {}) => ({
  purpose: 'rung',
  nodeId: NODE_RUNG,
  depth: 22,
  immutable: false,
  days: 10,
  costPlur: costOf(22, 10),
  replacesBatchId: BATCH_RUNG,
  ...over,
});

beforeEach(async () => {
  app = await startPurchaseTestApp();
  await app.authService.addUser(TEST_SETUP, USERNAME, PASSWORD);
  cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/funding/batch-purchases', () => {
  it('starts a purchase and answers it with 202, asking for no password', async () => {
    const res = await purchaseCall('POST', FUNDING_BATCH_PURCHASES_ADMIN_PATH, rung());

    assert.equal(res.status, 202, JSON.stringify(res.body));
    const purchase = res.body as BatchPurchase;
    assert.deepEqual([purchase.purpose, purchase.nodeId, purchase.state], ['rung', NODE_RUNG, 'buying']);
    assert.equal(app.manager.requests.length, 1);
    assert.equal(app.manager.requests[0]?.requestId, purchase.id);
  });

  it('refuses a body that is not a purchase with 400, asking nothing of the manager', async () => {
    for (const body of [
      rung({ purpose: 'archive' }),
      rung({ depth: '22' }),
      rung({ days: 2.5 }),
      rung({ costPlur: '-1' }),
      rung({ replacesBatchId: 'b1'.repeat(32) }),
      rung({ replacesBatchId: undefined }),
      rung({ immutable: 'no' }),
      rung({ nodeId: 'a node' }),
    ]) {
      const res = await purchaseCall('POST', FUNDING_BATCH_PURCHASES_ADMIN_PATH, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(app.manager.requests, []);
    assert.equal(app.store.rows.size, 0);
  });

  it('answers a refusal with 409 and its problem', async () => {
    const res = await purchaseCall('POST', FUNDING_BATCH_PURCHASES_ADMIN_PATH, rung({ costPlur: '1' }));

    assert.equal(res.status, 409);
    const body = res.body as { error: string; problem: string; message: string };
    assert.deepEqual([body.error, body.problem], ['funding_refused', 'price']);
    assert.match(body.message, /now costs/);
  });

  it('wants a session, and the cross-site header on a write', async () => {
    assert.equal((await call(app, 'POST', FUNDING_BATCH_PURCHASES_ADMIN_PATH, { body: rung() })).status, 401);
    const crossSite = await call(app, 'POST', FUNDING_BATCH_PURCHASES_ADMIN_PATH, {
      cookie,
      body: rung(),
      requestedWith: false,
    });
    assert.equal(crossSite.status, 403);
    assert.deepEqual(app.manager.requests, []);
  });
});

describe('GET /api/funding/batch-purchases', () => {
  it('lists the purchases, and answers one by its id', async () => {
    const started = (await purchaseCall('POST', FUNDING_BATCH_PURCHASES_ADMIN_PATH, rung())).body as BatchPurchase;

    const list = await purchaseCall('GET', FUNDING_BATCH_PURCHASES_ADMIN_PATH);
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body as BatchPurchasesResponse).purchases.map((purchase) => purchase.id),
      [started.id],
    );

    const one = await purchaseCall('GET', fundingBatchPurchaseAdminPath(started.id.toUpperCase()));
    assert.equal(one.status, 200);
    assert.equal((one.body as BatchPurchase).id, started.id);
  });

  it('answers 404 for an id never written, and 400 for one that is not a UUID', async () => {
    const never = '99999999-0000-4000-8000-000000000000';
    const read = await purchaseCall('GET', fundingBatchPurchaseAdminPath(never));
    assert.equal(read.status, 404);
    assert.deepEqual(read.body, { error: 'purchase_not_found', id: never });
    const check = await purchaseCall('POST', fundingBatchPurchaseCheckAdminPath(never));
    assert.equal(check.status, 404);

    assert.equal((await purchaseCall('GET', fundingBatchPurchaseAdminPath('not-a-uuid'))).status, 400);
  });
});

describe('POST /api/funding/batch-purchases/:id/restart and /check', () => {
  it('restarts a waiting stage and answers the purchase, and refuses a check when nothing stopped with 409', async () => {
    const started = (await purchaseCall('POST', FUNDING_BATCH_PURCHASES_ADMIN_PATH, rung())).body as BatchPurchase;
    const stages = [{ stageId: FOLLOWING_STAGE, name: 'Main stage', apply: 'waiting_live' as const, message: null }];
    app.manager.statuses.set(
      started.id,
      purchaseStatus(
        { requestId: started.id, purpose: 'rung', nodeId: NODE_RUNG },
        { step: 'set', usable: true, stages },
      ),
    );
    assert.equal(
      ((await purchaseCall('GET', fundingBatchPurchaseAdminPath(started.id))).body as BatchPurchase).state,
      'restarting',
    );

    const bad = await purchaseCall('POST', fundingBatchPurchaseRestartAdminPath(started.id), { stageId: 'stage-1' });
    assert.equal(bad.status, 400);

    const restarted = await purchaseCall('POST', fundingBatchPurchaseRestartAdminPath(started.id), {
      stageId: FOLLOWING_STAGE,
    });
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
    assert.equal((restarted.body as BatchPurchase).batchId, BOUGHT);
    assert.deepEqual(app.manager.restarts, [{ requestId: started.id, stageId: FOLLOWING_STAGE }]);

    const check = await purchaseCall('POST', fundingBatchPurchaseCheckAdminPath(started.id));
    assert.equal(check.status, 409);
    assert.equal((check.body as { problem: string }).problem, 'batch');
  });
});
