/**
 * The Notifications page's routes over HTTP: the real router, session gate, cross-site check, admin check, password
 * check and error mapping on a random port, mounted as `src/api/server.ts` mounts them, with the service over the
 * in-memory store, the real sealing, a fake channel factory and fake Telegram lookups, and the users and sessions in
 * memory. `pnpm test`.
 *
 * Pinned here: every route needs a session and every write the same-site header; the services' routes answer 403 to a
 * user without the admin role before anything else; a save of a service or of a destination asks for the password;
 * the routes under /me read and write the session's own user, whatever the request names; the answers and the
 * refusals as `notices.ts` of web2-admin-common names them; and no answer, nor any audit row, carries the password or
 * a service's secret. Every secret and address here is made up for the test.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { DestinationChannelConfig, DestinationChannelFactory } from '@streaming-monorepo/notifications';
import {
  MY_NOTICE_TOPICS_PATH,
  MY_TELEGRAM_CHAT_PATH,
  MY_TELEGRAM_CODE_PATH,
  myDestinationEnabledPath,
  myDestinationPath,
  myDestinationTestPath,
  type MyNoticeTestResponse,
  noticeServiceEnabledPath,
  noticeServicePath,
  type NoticesView,
  NOTIFICATIONS_PATH,
  type TelegramChat,
  type TelegramChatResponse,
  type TelegramCodeResponse,
} from '@streaming-monorepo/web2-admin-common';
import { LoginLimiter } from '@streaming-monorepo/web-auth';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createNoticesRouter } from '../../src/api/routes/notifications.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { channelSecretKeyFrom } from '../../src/domain/notifications/channelSecrets.js';
import { NoticeService } from '../../src/domain/notifications/NoticeService.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { type AuthTestApp, call, signIn } from './support/authTestApp.js';
import { InMemoryAuditLog } from './support/fakes.js';
import { InMemoryNoticeStore } from './support/notificationFakes.js';

const ADMIN_NAME = 'alice';
const OPERATOR_NAME = 'bob';
const PASSWORD = 'a-long-enough-password';
const WRONG = 'not-the-password';

const KEY = channelSecretKeyFrom('ab'.repeat(32));
const EMAIL_KEY = `test-key-${'k'.repeat(40)}`;
const TELEGRAM_TOKEN = `1234567890:${'A'.repeat(35)}`;
const EMAIL_SETTINGS = { provider: 'brevo', senderAddress: 'alerts@example.org', senderName: '' };
const ADMIN_MAIL = 'alice@example.org';
const OPERATOR_MAIL = 'bob@example.org';
const CHAT: TelegramChat = { id: '987654321', kind: 'private', name: 'Bob' };

interface NoticeTestApp extends AuthTestApp {
  store: InMemoryNoticeStore;
  configs: DestinationChannelConfig[];
  clock: { now: number };
}

async function startNoticeTestApp(options: { secretKey?: Buffer | null } = {}): Promise<NoticeTestApp> {
  const clock = { now: Date.parse('2026-11-25T10:00:00.000Z') };
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
  const store = new InMemoryNoticeStore();
  const configs: DestinationChannelConfig[] = [];
  const channelFrom: DestinationChannelFactory = (config) => {
    configs.push(structuredClone(config));
    return { kind: config.kind, send: async () => undefined };
  };
  const notices = new NoticeService({
    store,
    secretKey: options.secretKey === undefined ? KEY : options.secretKey,
    channelFrom,
    lookUpTelegramBot: async () => ({ username: 'example_alerts_bot', name: 'Example alerts' }),
    findTelegramChat: async () => CHAT,
    audit,
    now: () => clock.now,
    drawCode: () => 'ABCDEFGH23',
  });
  const requireAuth = createRequireAuth(authService);

  const app = express();
  app.use(requireSameSite);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/auth', createAuthRouter(authService, requireAuth));
  app.use(NOTIFICATIONS_PATH, createNoticesRouter({ notices, authService, requireAuth }));
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
    store,
    configs,
    clock,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let app: NoticeTestApp;
/** The first user, who has the admin role. */
let adminCookie: string;
/** A second user, without it. */
let operatorCookie: string;

/** Every body answered during a test, so a test can prove none carried the password or a secret. */
const answered: unknown[] = [];

async function as(cookie: string, method: string, path: string, body?: unknown) {
  const res = await call(app, method, path, { cookie, body });
  answered.push(res.body);
  return res;
}

const saveService = (cookie: string, password = PASSWORD) =>
  as(cookie, 'PUT', noticeServicePath('email'), { password, settings: EMAIL_SETTINGS, secret: EMAIL_KEY });

const saveTelegram = () =>
  as(adminCookie, 'PUT', noticeServicePath('telegram'), { password: PASSWORD, settings: {}, secret: TELEGRAM_TOKEN });

async function useApp(options: { secretKey?: Buffer | null } = {}): Promise<void> {
  app = await startNoticeTestApp(options);
  await app.authService.addUser(TEST_SETUP, ADMIN_NAME, PASSWORD);
  await app.authService.addUser(TEST_SETUP, OPERATOR_NAME, PASSWORD);
  adminCookie = (await signIn(app, ADMIN_NAME, PASSWORD)).cookie;
  operatorCookie = (await signIn(app, OPERATOR_NAME, PASSWORD)).cookie;
}

beforeEach(async () => {
  answered.length = 0;
  await useApp();
});

afterEach(async () => {
  await app.close();
  // Whatever the test did, no answer and no audit row carried the password or a service's secret.
  for (const text of [JSON.stringify(answered), JSON.stringify(app.audit.entries)]) {
    for (const secret of [PASSWORD, EMAIL_KEY, TELEGRAM_TOKEN]) assert.ok(!text.includes(secret));
  }
  assert.ok(!JSON.stringify(app.audit.entries).includes(OPERATOR_MAIL), 'no audit row holds an address');
});

describe('the routes', () => {
  it('need a session, and a write needs the same-site header', async () => {
    const paths: [string, string][] = [
      ['GET', NOTIFICATIONS_PATH],
      ['PUT', noticeServicePath('email')],
      ['PUT', noticeServiceEnabledPath('email')],
      ['DELETE', noticeServicePath('email')],
      ['PUT', myDestinationPath('email')],
      ['PUT', myDestinationEnabledPath('email')],
      ['POST', myDestinationTestPath('email')],
      ['DELETE', myDestinationPath('email')],
      ['PUT', MY_NOTICE_TOPICS_PATH],
      ['POST', MY_TELEGRAM_CODE_PATH],
      ['POST', MY_TELEGRAM_CHAT_PATH],
    ];
    for (const [method, path] of paths) {
      const res = await call(app, method, path, { body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    const crossSite = await call(app, 'PUT', myDestinationPath('email'), {
      cookie: operatorCookie,
      requestedWith: false,
      body: { password: PASSWORD, address: OPERATOR_MAIL },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(app.store.destinationRows.size, 0);
  });

  it('refuse a kind that is not a service with 400', async () => {
    for (const [method, path, body] of [
      ['PUT', `${NOTIFICATIONS_PATH}/services/slack`, { password: PASSWORD, settings: {}, secret: null }],
      ['PUT', `${NOTIFICATIONS_PATH}/me/destinations/slack`, { password: PASSWORD, address: 'x' }],
      ['POST', `${NOTIFICATIONS_PATH}/me/destinations/slack/test`, undefined],
      ['DELETE', `${NOTIFICATIONS_PATH}/me/destinations/slack`, undefined],
    ] as const) {
      const res = await as(adminCookie, method, path, body);
      assert.equal(res.status, 400, `${method} ${path}`);
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
  });
});

describe('the shared services', () => {
  it('answer 403 to a user without the admin role, before the password is looked at', async () => {
    for (const [method, path, body] of [
      ['PUT', noticeServicePath('email'), { password: WRONG, settings: EMAIL_SETTINGS, secret: EMAIL_KEY }],
      ['PUT', noticeServiceEnabledPath('email'), { enabled: false }],
      ['DELETE', noticeServicePath('email'), undefined],
    ] as const) {
      const res = await as(operatorCookie, method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal((res.body as { error: string }).error, 'admin_required');
    }
    assert.equal(app.store.serviceRows.size, 0);
  });

  it('are saved behind the password, switched and removed by an admin', async () => {
    assert.equal((await saveService(adminCookie, WRONG)).status, 401);
    assert.equal(app.store.serviceRows.size, 0);

    const saved = await saveService(adminCookie);
    assert.equal(saved.status, 200);
    const view = saved.body as NoticesView;
    assert.equal(view.managesServices, true);
    assert.deepEqual(view.services[0]?.settings, EMAIL_SETTINGS);

    const off = await as(adminCookie, 'PUT', noticeServiceEnabledPath('email'), { enabled: false });
    assert.equal((off.body as NoticesView).services[0]?.enabled, false);
    const notSaved = await as(adminCookie, 'PUT', noticeServiceEnabledPath('telegram'), { enabled: true });
    assert.equal(notSaved.status, 409);
    assert.equal((notSaved.body as { error: string }).error, 'service_not_saved');

    const removed = await as(adminCookie, 'DELETE', noticeServicePath('email'));
    assert.equal((removed.body as NoticesView).services[0]?.saved, false);
  });

  it('answer 409 notifications_unavailable to a save without BRAND_WALLET_SECRET', async () => {
    await app.close();
    await useApp({ secretKey: null });
    const res = await saveService(adminCookie);
    assert.equal(res.status, 409);
    assert.equal((res.body as { error: string }).error, 'notifications_unavailable');
  });

  it('show their settings to an admin alone', async () => {
    await saveService(adminCookie);
    const view = (await as(operatorCookie, 'GET', NOTIFICATIONS_PATH)).body as NoticesView;
    assert.equal(view.managesServices, false);
    assert.equal(view.services[0]?.saved, true);
    assert.equal(view.services[0]?.settings, null);
    assert.equal(view.services[0]?.savedBy, null);
  });
});

describe('my notifications', () => {
  it("save a destination behind the session's own user's password, and answer it to that user alone", async () => {
    const wrong = await as(operatorCookie, 'PUT', myDestinationPath('email'), {
      password: WRONG,
      address: OPERATOR_MAIL,
    });
    assert.equal(wrong.status, 401);
    const refused = await as(operatorCookie, 'PUT', myDestinationPath('email'), { password: PASSWORD, address: 'no' });
    assert.equal(refused.status, 400);

    const saved = await as(operatorCookie, 'PUT', myDestinationPath('email'), {
      password: PASSWORD,
      address: OPERATOR_MAIL,
    });
    assert.equal(saved.status, 200);
    assert.equal((saved.body as NoticesView).destinations[0]?.address, OPERATOR_MAIL);
    await as(adminCookie, 'PUT', myDestinationPath('email'), { password: PASSWORD, address: ADMIN_MAIL });

    const theirs = (await as(adminCookie, 'GET', NOTIFICATIONS_PATH)).body as NoticesView;
    assert.equal(theirs.destinations[0]?.address, ADMIN_MAIL);
    assert.ok(!JSON.stringify(theirs).includes(OPERATOR_MAIL));
  });

  it("take no user from the request: what a body names is dropped, and the session's own user is written", async () => {
    await as(adminCookie, 'PUT', MY_NOTICE_TOPICS_PATH, { topics: [] });
    const adminId = [...app.store.topicRows.keys()][0]!;
    const res = await as(operatorCookie, 'PUT', MY_NOTICE_TOPICS_PATH, { topics: ['wallet_low'], userId: adminId });
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as NoticesView).topics, ['wallet_low']);
    assert.deepEqual(app.store.topicRows.get(adminId), [], "the admin's topics are as they were");
    assert.equal(app.store.topicRows.size, 2);
  });

  it('switch, remove and test a destination, and save the topics, with no password', async () => {
    await saveService(adminCookie);
    const notSaved = await as(operatorCookie, 'PUT', myDestinationEnabledPath('email'), { enabled: false });
    assert.equal((notSaved.body as { error: string }).error, 'destination_not_saved');
    await as(operatorCookie, 'PUT', myDestinationPath('email'), { password: PASSWORD, address: OPERATOR_MAIL });

    const topics = await as(operatorCookie, 'PUT', MY_NOTICE_TOPICS_PATH, { topics: ['unmarked_stage'] });
    assert.deepEqual((topics.body as NoticesView).topics, ['unmarked_stage']);
    const off = await as(operatorCookie, 'PUT', myDestinationEnabledPath('email'), { enabled: false });
    assert.equal((off.body as NoticesView).destinations[0]?.enabled, false);

    const test = await as(operatorCookie, 'POST', myDestinationTestPath('email'));
    assert.equal(test.status, 200);
    assert.equal((test.body as MyNoticeTestResponse).sent, true);
    assert.equal(app.configs[0]?.address, OPERATOR_MAIL);

    const again = await as(operatorCookie, 'POST', myDestinationTestPath('email'));
    assert.equal(again.status, 429);
    assert.equal((again.body as { error: string }).error, 'test_too_soon');
    assert.equal((again.body as { retryAfterSeconds: number }).retryAfterSeconds, 60);

    const removed = await as(operatorCookie, 'DELETE', myDestinationPath('email'));
    assert.equal((removed.body as NoticesView).destinations[0]?.address, null);
  });

  it('answer 409 service_not_saved to a test through a service never saved', async () => {
    await as(operatorCookie, 'PUT', myDestinationPath('telegram'), { password: PASSWORD, address: CHAT.id });
    const res = await as(operatorCookie, 'POST', myDestinationTestPath('telegram'));
    assert.equal(res.status, 409);
    assert.equal((res.body as { error: string }).error, 'service_not_saved');
  });

  it('find my Telegram chat by a code, and answer 409 code_not_started without one', async () => {
    await saveTelegram();
    const early = await as(operatorCookie, 'POST', MY_TELEGRAM_CHAT_PATH);
    assert.equal(early.status, 409);
    assert.equal((early.body as { error: string }).error, 'code_not_started');

    const code = (await as(operatorCookie, 'POST', MY_TELEGRAM_CODE_PATH)).body as TelegramCodeResponse;
    assert.equal(code.code, 'ABCDEFGH23');
    assert.equal(code.bot?.username, 'example_alerts_bot');

    const chat = (await as(operatorCookie, 'POST', MY_TELEGRAM_CHAT_PATH)).body as TelegramChatResponse;
    assert.deepEqual(chat, { chat: CHAT, error: null });
    const adminChat = await as(adminCookie, 'POST', MY_TELEGRAM_CHAT_PATH);
    assert.equal(adminChat.status, 409, "one user's code finds nothing for another");
  });
});
