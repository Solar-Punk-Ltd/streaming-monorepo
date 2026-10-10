/**
 * The Funding page's routes over HTTP: the real router, session gate, cross-site check, password check and error
 * mapping on a random port, mounted as `src/api/server.ts` mounts them, with the funding services over fakes and the
 * users and sessions in memory. `pnpm test`.
 *
 * Pinned here: a wrong password on a pin or a send answers as the password change does, 401 and then 429, on the same
 * count as the password change; the password is checked before anything else of a send; a node named twice is 400;
 * the 202 answer's shape; one of two sends at once is 409 `{ error: 'conflict' }`; a stamp request takes no password,
 * answers 202 at once with every item queued, refuses a body that is not one with 400, a failed check with 409 and its
 * problem, and an earlier stamp bulk not settled with 409 `{ error: 'conflict' }`; a chequebook request likewise, with
 * a target under 1 xBZZ and a node named twice refused with 400, and the open chequebook bulk named in the view; and no
 * answer, nor any audit row, carries a signed transaction or the password.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import {
  FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH,
  FUNDING_PATH,
  FUNDING_PINS_PATH,
  FUNDING_STAMP_OPERATIONS_ADMIN_PATH,
  FUNDING_TRANSFERS_ADMIN_PATH,
  type FundingChequebookBulkAnswer,
  type FundingChequebookOperationsAnswer,
  type FundingStampBulkAnswer,
  type FundingStampOperationsAnswer,
  type FundingTransfersAnswer,
  type FundingView,
  fundingBulkPath,
  fundingChequebookBulkPath,
  fundingStampBulkPath,
} from '@streaming-monorepo/web2-admin-common';
import { LoginLimiter } from '@streaming-monorepo/web-auth';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createFundingRouter } from '../../src/api/routes/funding.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
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
import { InMemoryAuditLog } from './support/fakes.js';
import {
  BATCH_CATALOGUE,
  BATCH_STAGE,
  chequebookInventory,
  FakeFundingManager,
  FakeFundingWallet,
  fundingChequebook,
  InMemoryFundingChequebookStore,
  InMemoryFundingPinStore,
  InMemoryFundingStampStore,
  InMemoryFundingTransferStore,
  managerFailure,
  NODE_A,
  NODE_B,
  NODE_CATALOGUE,
  NODE_RUNG,
  ONE_XBZZ,
  POSTAGE,
  stampInventory,
  WALLET_A,
  WALLET_B,
} from './support/fundingFakes.js';

const USERNAME = 'alice';
const PASSWORD = 'a-long-enough-password';
const WRONG = 'not-the-password';

interface FundingTestApp extends AuthTestApp {
  manager: FakeFundingManager;
  wallet: FakeFundingWallet;
  transfers: InMemoryFundingTransferStore;
  pins: InMemoryFundingPinStore;
  stampJournal: InMemoryFundingStampStore;
  stamps: FundingStampService;
  chequebookJournal: InMemoryFundingChequebookStore;
  chequebooks: FundingChequebookService;
  clock: { now: number };
}

async function startFundingTestApp(options: { configured?: boolean } = {}): Promise<FundingTestApp> {
  const clock = { now: 1_700_000_000_000 };
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const audit = new InMemoryAuditLog();
  const authService = new AuthService(
    users,
    sessions,
    new InMemoryCredentialRepository(users, sessions),
    audit,
    new LoginLimiter(() => clock.now),
  );
  const manager = new FakeFundingManager();
  const wallet = new FakeFundingWallet();
  const transfers = new InMemoryFundingTransferStore();
  const pins = new InMemoryFundingPinStore();
  const stampJournal = new InMemoryFundingStampStore();
  const stamps = new FundingStampService({
    manager: options.configured === false ? null : manager,
    journal: stampJournal,
    audit,
  });
  const chequebookJournal = new InMemoryFundingChequebookStore();
  const chequebooks = new FundingChequebookService({
    manager: options.configured === false ? null : manager,
    journal: chequebookJournal,
    audit,
  });
  const fundingService = new FundingService({
    wallet,
    manager: options.configured === false ? null : manager,
    transfers,
    pins,
    stamps,
    chequebooks,
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
    wallet,
    transfers,
    pins,
    stampJournal,
    stamps,
    chequebookJournal,
    chequebooks,
    clock,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let app: FundingTestApp;
let cookie: string;

/** Every body answered during a test, so a test can prove none carried a signed transaction. */
const answered: unknown[] = [];

async function fundingCall(method: string, path: string, body?: unknown) {
  const res = await call(app, method, path, { cookie, body });
  answered.push(res.body);
  return res;
}

const send = (items: unknown[], password = PASSWORD) =>
  fundingCall('POST', FUNDING_TRANSFERS_ADMIN_PATH, { password, items });

beforeEach(async () => {
  app = await startFundingTestApp();
  await app.authService.addUser(TEST_SETUP, USERNAME, PASSWORD);
  cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
  app.pins.set(NODE_A, WALLET_A);
  app.pins.set(NODE_B, WALLET_B);
  answered.length = 0;
});

afterEach(async () => {
  // Whatever the test did, no answer carried a signed transaction or the password.
  const text = JSON.stringify(answered).toLowerCase();
  assert.doesNotMatch(text, /rawtransaction|raw_transaction/);
  assert.ok(!text.includes(PASSWORD));
  for (const row of app.transfers.rows.values()) assert.ok(!text.includes(row.rawTransaction.slice(2)));
  const audited = JSON.stringify(app.audit.entries).toLowerCase();
  assert.ok(!audited.includes(PASSWORD));
  assert.doesNotMatch(audited, /rawtransaction|raw_transaction/);
  for (const row of app.transfers.rows.values()) assert.ok(!audited.includes(row.rawTransaction.slice(2)));
  await app.close();
});

describe('a wrong password on a pin or a send', () => {
  it('answers 401 invalid_credentials, as the password change does, and changes nothing', async () => {
    const sent = await send([{ nodeId: NODE_A, kind: 'xdai', amount: '1' }], WRONG);
    const pinned = await fundingCall('POST', FUNDING_PINS_PATH, { password: WRONG, nodeIds: [NODE_A] });

    for (const res of [sent, pinned]) {
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: 'invalid_credentials' });
    }
    assert.equal(app.manager.calls.inventory, 0);
    assert.equal(app.transfers.rows.size, 0);
  });

  it('locks out after the fifth, on the same count as the password change', async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.equal((await send([{ nodeId: NODE_A, kind: 'xdai', amount: '1' }], WRONG)).status, 401);
    }
    for (let attempt = 4; attempt <= 5; attempt += 1) {
      const res = await fundingCall('POST', FUNDING_PINS_PATH, { password: WRONG, nodeIds: [NODE_A] });
      assert.equal(res.status, 401, `attempt ${attempt}`);
    }

    const locked = await send([{ nodeId: NODE_A, kind: 'xdai', amount: '1' }], PASSWORD);
    assert.equal(locked.status, 429);
    assert.equal(locked.retryAfter, '60');
    assert.deepEqual(locked.body, { error: 'too_many_attempts', retryAfterSeconds: 60 });

    const change = await call(app, 'POST', '/api/auth/password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: 'a-fine-new-password' },
    });
    assert.equal(change.status, 429, 'the password change shares the count');

    app.clock.now += 60_000;
    assert.equal((await send([{ nodeId: NODE_A, kind: 'xdai', amount: '1' }])).status, 202);
  });

  it('is refused before a node named twice', async () => {
    const res = await send(
      [
        { nodeId: NODE_A, kind: 'xdai', amount: '1' },
        { nodeId: NODE_A, kind: 'xdai', amount: '2' },
      ],
      WRONG,
    );

    assert.equal(res.status, 401);
  });
});

describe('a send', () => {
  it('refuses a node named twice for one kind with 400 and a sentence', async () => {
    const res = await send([
      { nodeId: NODE_A, kind: 'xdai', amount: '1' },
      { nodeId: NODE_A, kind: 'xdai', amount: '2' },
    ]);

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: 'validation_error',
      errors: ['stage-1:uploader is named twice for xDAI: a send takes one transfer of each kind to a node.'],
    });
  });

  it('refuses a body that is not a send with 400', async () => {
    const bodies: unknown[] = [
      { password: PASSWORD, items: [] },
      { password: PASSWORD, items: [{ nodeId: NODE_A, kind: 'xdai', amount: '0' }] },
      { password: PASSWORD, items: [{ nodeId: NODE_A, kind: 'xdai', amount: (2n ** 256n).toString() }] },
      { password: PASSWORD, items: [{ nodeId: NODE_A, kind: 'xdai', amount: 1 }] },
      { password: PASSWORD, items: [{ nodeId: NODE_A, kind: 'xdai', amount: '01' }] },
      { password: PASSWORD, items: [{ nodeId: NODE_A, kind: 'eth', amount: '1' }] },
      { password: PASSWORD, items: [{ nodeId: 'a/b', kind: 'xdai', amount: '1' }] },
      { items: [{ nodeId: NODE_A, kind: 'xdai', amount: '1' }] },
    ];
    for (const body of bodies) {
      const res = await fundingCall('POST', FUNDING_TRANSFERS_ADMIN_PATH, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
    assert.equal(app.transfers.rows.size, 0);
  });

  it('takes the most a transfer carries, 2^256 - 1, as far as the balance check', async () => {
    const res = await send([{ nodeId: NODE_A, kind: 'xbzz', amount: (2n ** 256n - 1n).toString() }]);

    assert.equal(res.status, 409);
    assert.equal((res.body as { problem: string }).problem, 'insufficient_funds');
  });

  it('answers 202 with the bulk id and each item', async () => {
    const res = await send([
      { nodeId: NODE_A, kind: 'xdai', amount: '1000' },
      { nodeId: NODE_B, kind: 'xbzz', amount: '2000' },
    ]);

    assert.equal(res.status, 202);
    const answer = res.body as FundingTransfersAnswer;
    assert.deepEqual(Object.keys(answer).sort(), ['bulkId', 'items']);
    assert.deepEqual(
      answer.items.map((item) => [item.nodeId, item.kind, item.amount, item.state, item.error]),
      [
        [NODE_A, 'xdai', '1000', 'submitted', null],
        [NODE_B, 'xbzz', '2000', 'submitted', null],
      ],
    );
    for (const item of answer.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        'amount',
        'blockNumber',
        'error',
        'kind',
        'nodeId',
        'requestId',
        'settled',
        'state',
        'txHash',
        'watched',
      ]);
      assert.match(item.txHash ?? '', /^0x[0-9a-f]{64}$/);
      assert.equal(item.blockNumber, null);
    }

    const bulk = await fundingCall('GET', fundingBulkPath(answer.bulkId));
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.body, { items: answer.items });
  });

  it('refuses a node not pinned with 409 and a sentence', async () => {
    app.pins.rows.delete(NODE_B);
    const res = await send([{ nodeId: NODE_B, kind: 'xdai', amount: '1' }]);

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: 'funding_refused',
      problem: 'node',
      message:
        'Main stage gateway (stage-1:gateway) is not pinned: confirm its wallet before sending to it. Nothing was sent.',
    });
  });

  it('refuses a send while an earlier one is not settled with 409 conflict', async () => {
    assert.equal((await send([{ nodeId: NODE_A, kind: 'xdai', amount: '1' }])).status, 202);
    const res = await send([{ nodeId: NODE_B, kind: 'xdai', amount: '1' }]);

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'conflict' });
  });

  it('lets one of two sends at once through, and answers the other 409 conflict', async () => {
    const [first, second] = await Promise.all([
      send([{ nodeId: NODE_A, kind: 'xdai', amount: '1' }]),
      send([{ nodeId: NODE_B, kind: 'xdai', amount: '1' }]),
    ]);

    assert.deepEqual([first.status, second.status].sort(), [202, 409]);
    assert.deepEqual([first, second].find((res) => res.status === 409)?.body, { error: 'conflict' });
    assert.equal(app.transfers.rows.size, 1);
  });

  it('answers 502 with a sentence when the manager cannot be read', async () => {
    app.manager.inventoryError = managerFailure('unreachable', null, 'GET http://manager.example failed');
    const res = await send([{ nodeId: NODE_A, kind: 'xdai', amount: '1' }]);

    assert.equal(res.status, 502);
    assert.deepEqual(res.body, {
      error: 'manager_unavailable',
      message: 'The manager could not be reached. Nothing was changed.',
    });
  });

  it('refuses a write without the cross-site header', async () => {
    const res = await call(app, 'POST', FUNDING_TRANSFERS_ADMIN_PATH, {
      cookie,
      requestedWith: false,
      body: { password: PASSWORD, items: [{ nodeId: NODE_A, kind: 'xdai', amount: '1' }] },
    });

    assert.equal(res.status, 403);
  });

  it('refuses without a session', async () => {
    const res = await call(app, 'GET', FUNDING_PATH);

    assert.equal(res.status, 401);
  });
});

describe('reading a send back', () => {
  it('needs a bulk id, and answers 404 for one never sent', async () => {
    const missing = await fundingCall('GET', FUNDING_TRANSFERS_ADMIN_PATH);
    assert.equal(missing.status, 400);

    const bad = await fundingCall('GET', `${FUNDING_TRANSFERS_ADMIN_PATH}?bulkId=not-a-uuid`);
    assert.equal(bad.status, 400);

    const unknown = await fundingCall('GET', fundingBulkPath('00000000-0000-4000-8000-00000000000a'));
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'bulk_not_found', bulkId: '00000000-0000-4000-8000-00000000000a' });
  });
});

describe('pins', () => {
  it('pins the current addresses and answers the nodes pinned', async () => {
    app.pins.rows.clear();
    const res = await fundingCall('POST', FUNDING_PINS_PATH, { password: PASSWORD, nodeIds: [NODE_A, NODE_B] });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { pinned: [NODE_A, NODE_B] });
    const view = (await fundingCall('GET', FUNDING_PATH)).body as FundingView;
    assert.deepEqual(
      view.stages[0]?.nodes.map((node) => node.pin),
      ['pinned', 'pinned'],
    );
  });

  it('refuses a node the manager does not hold with 409 and a sentence', async () => {
    const res = await fundingCall('POST', FUNDING_PINS_PATH, { password: PASSWORD, nodeIds: ['stage-9:gone'] });

    assert.equal(res.status, 409);
    assert.equal((res.body as { problem: string }).problem, 'node');
  });

  it('refuses a node whose address could not be read with 400 and a sentence', async () => {
    const inventory = app.manager.inventoryAnswer;
    inventory.stages[0]!.nodes[0]!.walletAddress = null;
    const res = await fundingCall('POST', FUNDING_PINS_PATH, { password: PASSWORD, nodeIds: [NODE_A] });

    assert.equal(res.status, 400);
    assert.equal((res.body as { error: string }).error, 'validation_error');
    assert.match((res.body as { errors: string[] }).errors[0] ?? '', /could not be read/);
  });
});

describe('after a reload that lost the send', () => {
  it('names the open send on the Funding page, and takes a new send once it settled', async () => {
    const sent = (await send([{ nodeId: NODE_A, kind: 'xdai', amount: '1' }])).body as FundingTransfersAnswer;
    // The tab is gone, and the bulk id with it: the page reads the view again.
    const reloaded = (await fundingCall('GET', FUNDING_PATH)).body as FundingView;
    assert.equal(reloaded.openBulkId, sent.bulkId);

    assert.deepEqual((await send([{ nodeId: NODE_B, kind: 'xdai', amount: '1' }])).body, { error: 'conflict' });

    app.manager.statusAnswers.set(sent.items[0]!.requestId, { state: 'confirmed', blockNumber: 21 });
    const next = await send([{ nodeId: NODE_B, kind: 'xdai', amount: '1' }]);
    assert.equal(next.status, 202);

    const bulk = await fundingCall('GET', fundingBulkPath(sent.bulkId));
    assert.deepEqual(
      (bulk.body as FundingTransfersAnswer).items.map((item) => [item.state, item.blockNumber]),
      [['confirmed', 21]],
    );
    const view = (await fundingCall('GET', FUNDING_PATH)).body as FundingView;
    assert.equal(view.openBulkId, (next.body as FundingTransfersAnswer).bulkId);
  });
});

describe('the Funding page view', () => {
  it('answers the view', async () => {
    const res = await fundingCall('GET', FUNDING_PATH);

    assert.equal(res.status, 200);
    const view = res.body as FundingView;
    assert.equal(view.configured, true);
    assert.equal(view.chainId, 100);
    assert.equal(view.wallet?.address, app.wallet.address());
  });
});

describe('a stamp request', () => {
  const PRICE = POSTAGE.pricePerChunkPerBlockPlur;
  const TOP_UP = {
    kind: 'topup',
    nodeId: NODE_A,
    batchId: BATCH_STAGE,
    expectedDepth: 20,
    days: 30,
    pricePerChunkPerBlockPlur: PRICE,
  };
  const CATALOGUE_TOP_UP = {
    kind: 'topup',
    nodeId: NODE_CATALOGUE,
    batchId: BATCH_CATALOGUE,
    expectedDepth: 18,
    days: 7,
    pricePerChunkPerBlockPlur: PRICE,
  };
  const DILUTION = { kind: 'dilute', nodeId: NODE_CATALOGUE, batchId: BATCH_CATALOGUE, expectedDepth: 18, steps: 1 };

  const stampRequest = (body: unknown) => fundingCall('POST', FUNDING_STAMP_OPERATIONS_ADMIN_PATH, body);

  beforeEach(() => {
    app.manager.inventoryAnswer = stampInventory();
  });

  it('takes no password, and answers 202 at once with the bulk id and every item queued', async () => {
    const res = await stampRequest({ items: [TOP_UP, CATALOGUE_TOP_UP] });

    assert.equal(res.status, 202);
    const answer = res.body as FundingStampOperationsAnswer;
    assert.deepEqual(Object.keys(answer).sort(), ['bulkId', 'items']);
    assert.deepEqual(
      answer.items.map((item) => [
        item.nodeId,
        item.kind,
        item.batchId,
        item.days,
        item.steps,
        item.state,
        item.settled,
      ]),
      [
        [NODE_A, 'topup', BATCH_STAGE, 30, null, 'queued', false],
        [NODE_CATALOGUE, 'topup', BATCH_CATALOGUE, 7, null, 'queued', false],
      ],
    );
    for (const item of answer.items) {
      assert.match(item.costPlur ?? '', /^[1-9]\d*$/);
      assert.match(item.requestId, /^[0-9a-f-]{36}$/);
    }

    // The relays end behind the answer; the bulk reads back as the manager answered them.
    await app.stamps.idle();
    const bulk = await fundingCall('GET', fundingStampBulkPath(answer.bulkId));
    assert.equal(bulk.status, 200);
    assert.deepEqual(
      (bulk.body as FundingStampBulkAnswer).items.map((item) => [item.requestId, item.state, item.settled]),
      answer.items.map((item) => [item.requestId, 'confirmed', true]),
    );
  });

  it('takes a dilution in steps', async () => {
    const res = await stampRequest({ items: [DILUTION] });

    assert.equal(res.status, 202);
    assert.deepEqual(
      (res.body as FundingStampOperationsAnswer).items.map((item) => [item.kind, item.steps, item.days, item.costPlur]),
      [['dilute', 1, null, null]],
    );
    await app.stamps.idle();
  });

  it('refuses a body that is not a stamp request with 400', async () => {
    const bodies: unknown[] = [
      {},
      { items: [] },
      { items: [{ ...TOP_UP, kind: 'burn' }] },
      { items: [{ ...TOP_UP, days: 0 }] },
      { items: [{ ...TOP_UP, days: '30' }] },
      { items: [{ ...TOP_UP, days: 1.5 }] },
      { items: [{ ...TOP_UP, days: 2 ** 31 }] },
      {
        items: [
          { kind: 'topup', nodeId: NODE_A, batchId: BATCH_STAGE, expectedDepth: 20, pricePerChunkPerBlockPlur: PRICE },
        ],
      },
      { items: [{ kind: 'topup', nodeId: NODE_A, batchId: BATCH_STAGE, expectedDepth: 20, days: 30 }] },
      { items: [{ ...TOP_UP, pricePerChunkPerBlockPlur: 24000 }] },
      { items: [{ ...TOP_UP, pricePerChunkPerBlockPlur: '0' }] },
      { items: [{ ...TOP_UP, pricePerChunkPerBlockPlur: '024000' }] },
      { items: [{ ...TOP_UP, pricePerChunkPerBlockPlur: '-24000' }] },
      { items: [{ ...TOP_UP, pricePerChunkPerBlockPlur: '0x5dc0' }] },
      { items: [{ ...TOP_UP, pricePerChunkPerBlockPlur: '24000.5' }] },
      { items: [{ ...TOP_UP, pricePerChunkPerBlockPlur: (2n ** 256n).toString() }] },
      { items: [{ ...DILUTION, pricePerChunkPerBlockPlur: PRICE }] },
      { items: [{ ...TOP_UP, steps: 1 }] },
      { items: [{ ...DILUTION, steps: 3 }] },
      { items: [{ ...DILUTION, steps: '1' }] },
      { items: [{ ...DILUTION, days: 30 }] },
      { items: [{ kind: 'dilute', nodeId: NODE_CATALOGUE, batchId: BATCH_CATALOGUE, expectedDepth: 18 }] },
      { items: [{ ...TOP_UP, batchId: '0x1234' }] },
      { items: [{ ...TOP_UP, expectedDepth: 256 }] },
      { items: [{ ...TOP_UP, expectedDepth: '20' }] },
      { items: [{ ...TOP_UP, nodeId: 'a/b' }] },
    ];
    for (const body of bodies) {
      const res = await stampRequest(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
    assert.equal(app.stampJournal.rows.size, 0);
    assert.equal(app.manager.calls.inventory, 0);
  });

  it("bounds a dilution's depth at 40, the manager's ceiling, and a top-up's at a byte's, 255", async () => {
    const deep = await stampRequest({ items: [{ ...DILUTION, expectedDepth: 41 }] });
    assert.equal(deep.status, 400);
    assert.equal((deep.body as { error: string }).error, 'validation_error');

    // Past the schema, both are checked against the inventory, where the batch is at another depth.
    assert.equal((await stampRequest({ items: [{ ...DILUTION, expectedDepth: 40 }] })).status, 409);
    assert.equal((await stampRequest({ items: [{ ...TOP_UP, expectedDepth: 255 }] })).status, 409);
    assert.equal(app.stampJournal.rows.size, 0);
  });

  it('refuses both kinds in one request, and a batch named twice, with 400 and a sentence', async () => {
    const mixed = await stampRequest({ items: [TOP_UP, DILUTION] });
    assert.equal(mixed.status, 400);
    assert.deepEqual(mixed.body, {
      error: 'validation_error',
      errors: ['A request takes one kind of operation: top-ups or dilutions, not both.'],
    });

    const twice = await stampRequest({ items: [TOP_UP, { ...TOP_UP, days: 7 }] });
    assert.equal(twice.status, 400);
    assert.deepEqual(twice.body, {
      error: 'validation_error',
      errors: [`Batch ${BATCH_STAGE} is named twice: a request takes one operation on a batch.`],
    });
  });

  it('refuses a check that fails with 409 funding_refused, its problem and its sentence', async () => {
    const res = await stampRequest({ items: [{ ...TOP_UP, expectedDepth: 19 }] });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: 'funding_refused',
      problem: 'batch',
      message:
        'The batch of Main stage uploader (stage-1:uploader) is at depth 20 now, not the 19 the page showed: read the page again. Nothing was sent.',
    });
    assert.equal(app.stampJournal.rows.size, 0);
  });

  it('refuses a top-up quoted at a lower price than postage costs now with 409 and problem price', async () => {
    const res = await stampRequest({ items: [{ ...TOP_UP, pricePerChunkPerBlockPlur: '23999' }] });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: 'funding_refused',
      problem: 'price',
      message: 'The price of postage has risen since the page read it. Read the page again. Nothing was sent.',
    });
    assert.equal(app.stampJournal.rows.size, 0);
    assert.equal(app.manager.stampCalls.operation, 0);
  });

  it('refuses a request while an earlier stamp bulk is not settled with 409 conflict', async () => {
    app.manager.stampState = 'unknown';
    assert.equal((await stampRequest({ items: [TOP_UP] })).status, 202);
    await app.stamps.idle();

    const res = await stampRequest({ items: [CATALOGUE_TOP_UP] });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'conflict' });
  });

  it('answers 502 with a sentence when the manager cannot be read', async () => {
    app.manager.inventoryError = managerFailure('unreachable', null, 'GET http://manager.example failed');

    const res = await stampRequest({ items: [TOP_UP] });

    assert.equal(res.status, 502);
    assert.deepEqual(res.body, {
      error: 'manager_unavailable',
      message: 'The manager could not be reached. Nothing was sent.',
    });
  });

  it('refuses a write without the cross-site header, and any call without a session', async () => {
    const crossSite = await call(app, 'POST', FUNDING_STAMP_OPERATIONS_ADMIN_PATH, {
      cookie,
      requestedWith: false,
      body: { items: [TOP_UP] },
    });
    assert.equal(crossSite.status, 403);

    const anonymous = await call(app, 'POST', FUNDING_STAMP_OPERATIONS_ADMIN_PATH, { body: { items: [TOP_UP] } });
    assert.equal(anonymous.status, 401);
    const anonymousRead = await call(app, 'GET', fundingStampBulkPath('00000000-0000-4000-8000-00000000000a'));
    assert.equal(anonymousRead.status, 401);
    assert.equal(app.stampJournal.rows.size, 0);
  });

  it('reads a stamp bulk back by its id: 400 without a UUID, 404 for one never journalled', async () => {
    assert.equal((await fundingCall('GET', FUNDING_STAMP_OPERATIONS_ADMIN_PATH)).status, 400);
    assert.equal((await fundingCall('GET', `${FUNDING_STAMP_OPERATIONS_ADMIN_PATH}?bulkId=not-a-uuid`)).status, 400);

    const unknown = await fundingCall('GET', fundingStampBulkPath('00000000-0000-4000-8000-00000000000a'));
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'bulk_not_found', bulkId: '00000000-0000-4000-8000-00000000000a' });
  });

  it('is named on the Funding page while it is open, beside the batches and the price of postage', async () => {
    app.manager.stampState = 'unknown';
    const sent = (await stampRequest({ items: [TOP_UP] })).body as FundingStampOperationsAnswer;
    await app.stamps.idle();

    const view = (await fundingCall('GET', FUNDING_PATH)).body as FundingView;

    assert.equal(view.openStampBulkId, sent.bulkId);
    assert.equal(view.openBulkId, null);
    assert.deepEqual(view.postage, POSTAGE);
    assert.equal(view.stages[0]?.nodes[0]?.batch?.batchId, BATCH_STAGE);
    assert.equal(view.stages[0]?.nodes[1]?.batch, null);
  });
});

describe('a chequebook request', () => {
  const xbzz = (tenths: bigint) => ((tenths * ONE_XBZZ) / 10n).toString();
  const TARGET = xbzz(20n);
  /** The stage's own node, 1.5 xBZZ available: a deposit of 0.5. The rung, 3.25: a withdrawal of 1.25. */
  const STAGE_NODE = { nodeId: NODE_A, availablePlur: ((3n * ONE_XBZZ) / 2n).toString() };
  const RUNG_NODE = { nodeId: NODE_RUNG, availablePlur: ((13n * ONE_XBZZ) / 4n).toString() };

  const chequebookRequest = (body: unknown) => fundingCall('POST', FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH, body);

  beforeEach(() => {
    app.manager.inventoryAnswer = chequebookInventory();
  });

  it('takes no password, and answers 202 at once with the bulk id and every item queued', async () => {
    const res = await chequebookRequest({ targetPlur: TARGET, items: [STAGE_NODE, RUNG_NODE] });

    assert.equal(res.status, 202);
    const answer = res.body as FundingChequebookOperationsAnswer;
    assert.deepEqual(Object.keys(answer).sort(), ['bulkId', 'items']);
    assert.deepEqual(
      answer.items.map((item) => [
        item.nodeId,
        item.nodeLabel,
        item.direction,
        item.amountPlur,
        item.targetPlur,
        item.state,
        item.settled,
      ]),
      [
        [NODE_A, 'Main stage uploader', 'deposit', xbzz(5n), TARGET, 'queued', false],
        [NODE_RUNG, 'Main stage 720p rung', 'withdraw', ((5n * ONE_XBZZ) / 4n).toString(), TARGET, 'queued', false],
      ],
    );
    for (const item of answer.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        'amountPlur',
        'direction',
        'error',
        'mined',
        'nodeId',
        'nodeLabel',
        'requestId',
        'settled',
        'state',
        'targetPlur',
        'txHash',
        'watched',
      ]);
      assert.match(item.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(item.mined, false);
    }

    // The relays end behind the answer: the node sent each move, which holds up the next bulk until its block is final.
    await app.chequebooks.idle();
    const bulk = await fundingCall('GET', fundingChequebookBulkPath(answer.bulkId));
    assert.equal(bulk.status, 200);
    const items = (bulk.body as FundingChequebookBulkAnswer).items;
    assert.deepEqual(
      items.map((item) => [item.requestId, item.state, item.settled, item.watched]),
      answer.items.map((item) => [item.requestId, 'submitted', false, false]),
    );
    for (const item of items) assert.match(item.txHash ?? '', /^0x[0-9a-f]{64}$/);

    for (const item of answer.items) app.manager.chequebookJournalState.set(item.requestId, 'confirmed');
    const settled = await fundingCall('GET', fundingChequebookBulkPath(answer.bulkId));
    assert.deepEqual(
      (settled.body as FundingChequebookBulkAnswer).items.map((item) => [item.state, item.settled]),
      [
        ['confirmed', true],
        ['confirmed', true],
      ],
    );
  });

  it('refuses a body that is not a chequebook request with 400', async () => {
    const bodies: unknown[] = [
      {},
      { targetPlur: TARGET },
      { targetPlur: TARGET, items: [] },
      { items: [STAGE_NODE] },
      { targetPlur: 20_000_000_000_000_000, items: [STAGE_NODE] },
      { targetPlur: '0', items: [STAGE_NODE] },
      { targetPlur: `0${TARGET}`, items: [STAGE_NODE] },
      { targetPlur: '-20000000000000000', items: [STAGE_NODE] },
      { targetPlur: '2.5', items: [STAGE_NODE] },
      { targetPlur: '0x470de4df820000', items: [STAGE_NODE] },
      { targetPlur: '1'.repeat(31), items: [STAGE_NODE] },
      { targetPlur: TARGET, items: [{ nodeId: NODE_A }] },
      { targetPlur: TARGET, items: [{ ...STAGE_NODE, availablePlur: 15_000_000_000_000_000 }] },
      { targetPlur: TARGET, items: [{ ...STAGE_NODE, availablePlur: '-1' }] },
      { targetPlur: TARGET, items: [{ ...STAGE_NODE, availablePlur: '1.5' }] },
      { targetPlur: TARGET, items: [{ ...STAGE_NODE, availablePlur: '01' }] },
      { targetPlur: TARGET, items: [{ ...STAGE_NODE, availablePlur: '9'.repeat(31) }] },
      { targetPlur: TARGET, items: [{ availablePlur: STAGE_NODE.availablePlur }] },
      { targetPlur: TARGET, items: [{ ...STAGE_NODE, nodeId: 'a/b' }] },
    ];
    for (const body of bodies) {
      const res = await chequebookRequest(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
    assert.equal(app.chequebookJournal.rows.size, 0);
    assert.equal(app.manager.calls.inventory, 0);
  });

  it('refuses a target under 1 xBZZ, and a node named twice, with 400 and a sentence', async () => {
    const under = await chequebookRequest({ targetPlur: '9999999999999999', items: [STAGE_NODE] });
    assert.equal(under.status, 400);
    assert.deepEqual(under.body, {
      error: 'validation_error',
      errors: ['targetPlur must be at least 10000000000000000 PLUR, 1 xBZZ'],
    });

    const twice = await chequebookRequest({ targetPlur: TARGET, items: [STAGE_NODE, STAGE_NODE] });
    assert.equal(twice.status, 400);
    assert.deepEqual(twice.body, {
      error: 'validation_error',
      errors: [`${NODE_A} is named twice: a request brings a chequebook to the target once.`],
    });
    assert.equal(app.chequebookJournal.rows.size, 0);
    assert.equal(app.manager.calls.inventory, 0);

    // 1 xBZZ itself is the floor, and taken.
    assert.equal((await chequebookRequest({ targetPlur: xbzz(10n), items: [RUNG_NODE] })).status, 202);
    await app.chequebooks.idle();
  });

  it('refuses a check that fails with 409 funding_refused, its problem and its sentence', async () => {
    const gateway = await chequebookRequest({
      targetPlur: TARGET,
      items: [{ nodeId: NODE_B, availablePlur: (3n * ONE_XBZZ).toString() }],
    });
    assert.equal(gateway.status, 409);
    assert.deepEqual(gateway.body, {
      error: 'funding_refused',
      problem: 'node',
      message:
        "Main stage gateway (stage-1:gateway) is a gateway: the manager moves only the chequebook of a stage's own Bee node or of a rung. Nothing was sent.",
    });

    // The page showed 1 xBZZ available against a target of 1.5, and the chequebook holds 1.5 now: at the target.
    const moved = await chequebookRequest({
      targetPlur: xbzz(15n),
      items: [{ nodeId: NODE_A, availablePlur: xbzz(10n) }],
    });
    assert.equal(moved.status, 409);
    assert.deepEqual(moved.body, {
      error: 'funding_refused',
      problem: 'chequebook',
      message:
        'The chequebook of Main stage uploader (stage-1:uploader) holds 1.5 xBZZ available now, at the target or past it, so there is nothing to move. Read the page again. Nothing was sent.',
    });
    assert.equal(app.chequebookJournal.rows.size, 0);
    assert.equal(app.manager.chequebookCalls.operation, 0);
  });

  it('refuses a request while an earlier chequebook bulk is not settled with 409 conflict', async () => {
    assert.equal((await chequebookRequest({ targetPlur: TARGET, items: [STAGE_NODE] })).status, 202);
    await app.chequebooks.idle();

    const res = await chequebookRequest({ targetPlur: TARGET, items: [RUNG_NODE] });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'conflict' });
  });

  it('answers 502 with a sentence when the manager cannot be read', async () => {
    app.manager.inventoryError = managerFailure('unreachable', null, 'GET http://manager.example failed');

    const res = await chequebookRequest({ targetPlur: TARGET, items: [STAGE_NODE] });

    assert.equal(res.status, 502);
    assert.deepEqual(res.body, {
      error: 'manager_unavailable',
      message: 'The manager could not be reached. Nothing was sent.',
    });
  });

  it('refuses a write without the cross-site header, and any call without a session', async () => {
    const body = { targetPlur: TARGET, items: [STAGE_NODE] };
    const crossSite = await call(app, 'POST', FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH, {
      cookie,
      requestedWith: false,
      body,
    });
    assert.equal(crossSite.status, 403);

    const anonymous = await call(app, 'POST', FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH, { body });
    assert.equal(anonymous.status, 401);
    const anonymousRead = await call(app, 'GET', fundingChequebookBulkPath('00000000-0000-4000-8000-00000000000a'));
    assert.equal(anonymousRead.status, 401);
    assert.equal(app.chequebookJournal.rows.size, 0);
  });

  it('reads a chequebook bulk back by its id: 400 without a UUID, 404 for one never journalled', async () => {
    assert.equal((await fundingCall('GET', FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH)).status, 400);
    assert.equal(
      (await fundingCall('GET', `${FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH}?bulkId=not-a-uuid`)).status,
      400,
    );

    const unknown = await fundingCall('GET', fundingChequebookBulkPath('00000000-0000-4000-8000-00000000000a'));
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'bulk_not_found', bulkId: '00000000-0000-4000-8000-00000000000a' });
  });

  it("is named on the Funding page while it is open, beside each node's chequebook", async () => {
    const sent = (await chequebookRequest({ targetPlur: TARGET, items: [STAGE_NODE] }))
      .body as FundingChequebookOperationsAnswer;
    await app.chequebooks.idle();

    const view = (await fundingCall('GET', FUNDING_PATH)).body as FundingView;

    assert.equal(view.openChequebookBulkId, sent.bulkId);
    assert.equal(view.openStampBulkId, null);
    assert.equal(view.openBulkId, null);
    assert.deepEqual(view.stages[0]?.nodes[0]?.chequebook, fundingChequebook());
  });
});

describe('without manager funding settings', () => {
  let off: FundingTestApp;
  let offCookie: string;

  before(async () => {
    off = await startFundingTestApp({ configured: false });
    await off.authService.addUser(TEST_SETUP, USERNAME, PASSWORD);
    offCookie = (await signIn(off, USERNAME, PASSWORD)).cookie;
  });
  after(() => off.close());

  it('answers configured false, and refuses a send with 409 not_set_up', async () => {
    const view = await call(off, 'GET', FUNDING_PATH, { cookie: offCookie });
    assert.equal((view.body as FundingView).configured, false);

    const res = await call(off, 'POST', FUNDING_TRANSFERS_ADMIN_PATH, {
      cookie: offCookie,
      body: { password: PASSWORD, items: [{ nodeId: NODE_A, kind: 'xdai', amount: '1' }] },
    });
    assert.equal(res.status, 409);
    assert.equal((res.body as { problem: string }).problem, 'not_set_up');
    assert.equal(off.manager.calls.inventory, 0);

    const stamp = await call(off, 'POST', FUNDING_STAMP_OPERATIONS_ADMIN_PATH, {
      cookie: offCookie,
      body: { items: [{ kind: 'dilute', nodeId: NODE_A, batchId: BATCH_STAGE, expectedDepth: 20, steps: 1 }] },
    });
    assert.equal(stamp.status, 409);
    assert.equal((stamp.body as { problem: string }).problem, 'not_set_up');
    assert.equal(off.manager.calls.inventory, 0);

    const chequebook = await call(off, 'POST', FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH, {
      cookie: offCookie,
      body: { targetPlur: (2n * ONE_XBZZ).toString(), items: [{ nodeId: NODE_A, availablePlur: '0' }] },
    });
    assert.equal(chequebook.status, 409);
    assert.equal((chequebook.body as { problem: string }).problem, 'not_set_up');
    assert.equal(off.manager.calls.inventory, 0);
    assert.equal((view.body as FundingView).openChequebookBulkId, null);
  });
});
