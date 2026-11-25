/**
 * Stamp auto top-up's routes as the console calls them: the real router and session gate on a random port, the
 * service over the in-memory store and the fake manager. Unit test — no database. `pnpm test`.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AUTO_TOPUP_DEFAULTS,
  AUTO_TOPUP_NOT_MARKABLE_ERROR,
  type AutoTopUpView,
  FUNDING_AUTO_TOPUP_MARKS_PATH,
  FUNDING_AUTO_TOPUP_PATH,
  FUNDING_AUTO_TOPUP_SETTINGS_PATH,
  fundingAutoTopUpJobPath,
  SESSION_COOKIE_NAME,
} from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { createAutoTopUpRouter } from '../../src/api/routes/autoTopUp.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { StampAutoTopUpService } from '../../src/domain/funding/StampAutoTopUpService.js';

import { InMemoryStampAutoTopUpStore } from './support/autoTopUpFakes.js';
import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { InMemoryAuditLog } from './support/fakes.js';
import { BATCH_STAGE, FakeFundingManager, NODE_A, NODE_B, stampInventory } from './support/fundingFakes.js';
import { InMemoryNotificationStore } from './support/notificationFakes.js';

const PASSWORD = 'a-long-enough-password';

let server: http.Server;
let url: string;
let cookie: string;
let store: InMemoryStampAutoTopUpStore;
let audit: InMemoryAuditLog;

before(async () => {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  audit = new InMemoryAuditLog();
  const auth = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  await auth.addUser(TEST_SETUP, 'owner', PASSWORD);
  const { token } = await auth.signIn({ username: 'owner', password: PASSWORD, ip: '127.0.0.1', userAgent: null });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;

  store = new InMemoryStampAutoTopUpStore();
  const manager = new FakeFundingManager();
  manager.inventoryAnswer = stampInventory();
  const notifications = new InMemoryNotificationStore();
  const autoTopUp = new StampAutoTopUpService({ store, manager, audit, notifications });

  const app = express();
  app.use(express.json());
  app.use(
    FUNDING_AUTO_TOPUP_PATH,
    createAutoTopUpRouter({ autoTopUp, authService: auth, requireAuth: createRequireAuth(auth) }),
  );
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not report a port');
  url = `http://127.0.0.1:${address.port}`;
});

after(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

async function send(method: string, path: string, body?: unknown, signedIn = true): Promise<Response> {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      ...(signedIn ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('the auto top-up routes', () => {
  it('answer the view to a session, and 401 without one', async () => {
    const res = await send('GET', FUNDING_AUTO_TOPUP_PATH);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as AutoTopUpView).settings, AUTO_TOPUP_DEFAULTS);

    assert.equal((await send('GET', FUNDING_AUTO_TOPUP_PATH, undefined, false)).status, 401);
    assert.equal((await send('PUT', FUNDING_AUTO_TOPUP_MARKS_PATH, { marked: false, items: [] }, false)).status, 401);
  });

  it('save the settings behind the password, refusing a wrong one and numbers with a problem', async () => {
    const settings = { ...AUTO_TOPUP_DEFAULTS, marginPercent: 15 };

    const wrong = await send('PUT', FUNDING_AUTO_TOPUP_SETTINGS_PATH, { password: 'not it', settings });
    assert.equal(wrong.status, 401);
    assert.equal(store.settingsRow, null);

    const refused = await send('PUT', FUNDING_AUTO_TOPUP_SETTINGS_PATH, {
      password: PASSWORD,
      settings: { ...settings, lookAheadDays: 5 },
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(((await refused.json()) as { errors: string[] }).errors, [
      'Look ahead is at most half of Top up when under.',
    ]);

    const saved = await send('PUT', FUNDING_AUTO_TOPUP_SETTINGS_PATH, { password: PASSWORD, settings });
    assert.equal(saved.status, 200);
    const view = (await saved.json()) as AutoTopUpView;
    assert.deepEqual(view.settings, settings);
    assert.equal(view.settingsSavedBy, 'owner');
  });

  it('mark a stamp, and answer 409 not_markable with a sentence for one the admin cannot top up', async () => {
    const marked = await send('PUT', FUNDING_AUTO_TOPUP_MARKS_PATH, {
      marked: true,
      items: [{ nodeId: NODE_A, batchId: BATCH_STAGE }],
    });
    assert.equal(marked.status, 200);
    assert.deepEqual(
      ((await marked.json()) as AutoTopUpView).stamps.map((stamp) => stamp.batchId),
      [BATCH_STAGE],
    );

    const refused = await send('PUT', FUNDING_AUTO_TOPUP_MARKS_PATH, {
      marked: true,
      items: [{ nodeId: NODE_B, batchId: `0x${'ff'.repeat(32)}` }],
    });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string; problems: string[] };
    assert.equal(body.error, AUTO_TOPUP_NOT_MARKABLE_ERROR);
    assert.equal(body.problems.length, 1);
    assert.equal(store.markRows.size, 1);

    const shape = await send('PUT', FUNDING_AUTO_TOPUP_MARKS_PATH, {
      marked: true,
      items: [{ nodeId: NODE_A, batchId: BATCH_STAGE.toUpperCase() }],
    });
    assert.equal(shape.status, 400);
  });

  it('have no route for an email list', async () => {
    assert.equal((await send('PUT', `${FUNDING_AUTO_TOPUP_PATH}/emails`, { emails: [] })).status, 404);
  });

  it('pause and resume a job, and refuse a job that is not one', async () => {
    const paused = await send('PUT', fundingAutoTopUpJobPath('stamp'), { paused: true });
    assert.equal(paused.status, 200);
    assert.equal(((await paused.json()) as AutoTopUpView).jobs[2]?.pausedBy, 'owner');

    assert.equal((await send('PUT', `${FUNDING_AUTO_TOPUP_PATH}/jobs/other`, { paused: true })).status, 400);
    assert.ok(audit.withAction('funding.auto_topup.job').every((entry) => entry.actor.kind === 'operator'));
  });
});
