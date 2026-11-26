/**
 * The Notifications page's routes over HTTP: the real router, session gate, cross-site check, password check and error
 * mapping on a random port, mounted as `src/api/server.ts` mounts them, with the service over the in-memory store, the
 * real sealing and a fake channel factory, and the users and sessions in memory. `pnpm test`.
 *
 * Pinned here: every route needs a session and every write the same-site header; a save asks for the password, on the
 * count a send's confirmation counts on, before anything of the body is looked at past its shape; the answers and the
 * refusals as `notifications.ts` of web2-admin-common names them; a switch, a test and a removal take no password; a
 * test goes out with the saved values whatever its body says; and no answer, nor any audit row, carries the password
 * or a channel's secret. Every secret here is made up for the test.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ChannelConfig, ChannelFactory } from '@streaming-monorepo/notifications';
import {
  NOTIFICATIONS_PATH,
  notificationChannelEnabledPath,
  notificationChannelPath,
  notificationChannelTestPath,
  type NotificationsView,
  type NotificationTestResponse,
  TELEGRAM_CHATS_PATH,
  type TelegramChat,
  type TelegramChatsResponse,
} from '@streaming-monorepo/web2-admin-common';
import { LoginLimiter } from '@streaming-monorepo/web-auth';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createNotificationsRouter } from '../../src/api/routes/notifications.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { channelSecretKeyFrom, openChannelSecret } from '../../src/domain/notifications/channelSecrets.js';
import { NotificationService } from '../../src/domain/notifications/NotificationService.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { type AuthTestApp, call, signIn } from './support/authTestApp.js';
import { InMemoryAuditLog } from './support/fakes.js';
import { InMemoryNotificationStore } from './support/notificationFakes.js';

const USERNAME = 'alice';
const PASSWORD = 'a-long-enough-password';
const WRONG = 'not-the-password';

const KEY = channelSecretKeyFrom('ab'.repeat(32));
const SLACK_URL = 'https://hooks.slack.com/services/T0001/B0001/abcdefABCDEF0123456789xy';
const TELEGRAM_TOKEN = `1234567890:${'A'.repeat(35)}`;
const TELEGRAM_SETTINGS = { chatId: '-1001234567890' };
const TELEGRAM_CHATS: TelegramChat[] = [{ id: '111111111', kind: 'private', name: 'Ada Lovelace (@ada)' }];

interface NotificationTestApp extends AuthTestApp {
  store: InMemoryNotificationStore;
  configs: ChannelConfig[];
  clock: { now: number };
  /** The tokens Find chat id's lookup was handed, in turn: no call leaves the test. */
  lookups: string[];
}

async function startNotificationTestApp(options: { secretKey?: Buffer | null } = {}): Promise<NotificationTestApp> {
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
  const store = new InMemoryNotificationStore();
  const configs: ChannelConfig[] = [];
  const channelFrom: ChannelFactory = (config) => {
    configs.push(structuredClone(config));
    return { kind: config.kind, send: async () => undefined };
  };
  const lookups: string[] = [];
  const notifications = new NotificationService({
    store,
    secretKey: options.secretKey === undefined ? KEY : options.secretKey,
    channelFrom,
    audit,
    now: () => clock.now,
    findTelegramChats: async (token) => {
      lookups.push(token);
      return TELEGRAM_CHATS;
    },
  });
  const requireAuth = createRequireAuth(authService);

  const app = express();
  app.use(requireSameSite);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/auth', createAuthRouter(authService, requireAuth));
  app.use(NOTIFICATIONS_PATH, createNotificationsRouter({ notifications, authService, requireAuth }));
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
    lookups,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let app: NotificationTestApp;
let cookie: string;

/** Every body answered during a test, so a test can prove none carried the password or a secret. */
const answered: unknown[] = [];

async function notificationsCall(method: string, path: string, body?: unknown) {
  const res = await call(app, method, path, { cookie, body });
  answered.push(res.body);
  return res;
}

const saveTelegram = (password = PASSWORD, secret: string | null = TELEGRAM_TOKEN) =>
  notificationsCall('PUT', notificationChannelPath('telegram'), { password, settings: TELEGRAM_SETTINGS, secret });

async function useApp(options: { secretKey?: Buffer | null } = {}): Promise<void> {
  app = await startNotificationTestApp(options);
  await app.authService.addUser(TEST_SETUP, USERNAME, PASSWORD);
  cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
}

beforeEach(async () => {
  answered.length = 0;
  await useApp();
});

afterEach(async () => {
  await app.close();
  // Whatever the test did, no answer and no audit row carried the password or a channel's secret.
  for (const text of [JSON.stringify(answered), JSON.stringify(app.audit.entries)]) {
    for (const secret of [PASSWORD, TELEGRAM_TOKEN, SLACK_URL]) assert.ok(!text.includes(secret));
  }
});

describe('the routes', () => {
  it('need a session, and a write needs the same-site header', async () => {
    const paths: [string, string][] = [
      ['GET', NOTIFICATIONS_PATH],
      ['PUT', notificationChannelPath('telegram')],
      ['PUT', notificationChannelEnabledPath('telegram')],
      ['POST', notificationChannelTestPath('telegram')],
      ['POST', TELEGRAM_CHATS_PATH],
      ['DELETE', notificationChannelPath('telegram')],
    ];
    for (const [method, path] of paths) {
      const res = await call(app, method, path, { body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    const crossSiteLookup = await call(app, 'POST', TELEGRAM_CHATS_PATH, {
      cookie,
      requestedWith: false,
      body: { secret: TELEGRAM_TOKEN },
    });
    assert.equal(crossSiteLookup.status, 403);
    assert.deepEqual(app.lookups, []);
    const crossSite = await call(app, 'PUT', notificationChannelPath('telegram'), {
      cookie,
      requestedWith: false,
      body: { password: PASSWORD, settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(app.store.channelRows.size, 0);
  });

  it('refuse a kind that is not a channel with 400', async () => {
    for (const [method, path] of [
      ['PUT', `${NOTIFICATIONS_PATH}/channels/mattermost`],
      ['PUT', `${NOTIFICATIONS_PATH}/channels/mattermost/enabled`],
      ['POST', `${NOTIFICATIONS_PATH}/channels/mattermost/test`],
      ['DELETE', `${NOTIFICATIONS_PATH}/channels/mattermost`],
    ] as const) {
      const res = await notificationsCall(method, path, {
        password: PASSWORD,
        settings: {},
        secret: null,
        enabled: true,
      });
      assert.equal(res.status, 400, `${method} ${path}`);
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
  });

  it('GET answers every channel, saved or not', async () => {
    const res = await notificationsCall('GET', NOTIFICATIONS_PATH);

    assert.equal(res.status, 200);
    const view = res.body as NotificationsView;
    assert.equal(view.available, true);
    assert.deepEqual(
      view.channels.map((channel) => [channel.kind, channel.saved]),
      [
        ['email', false],
        ['slack', false],
        ['telegram', false],
      ],
    );
  });
});

describe('saving a channel', () => {
  it('asks for the password: 401 when it is wrong, then 429 once locked out, and saves nothing', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await saveTelegram(WRONG);
      assert.equal(res.status, 401, `attempt ${attempt}`);
      assert.deepEqual(res.body, { error: 'invalid_credentials' });
    }

    const locked = await saveTelegram();
    assert.equal(locked.status, 429);
    assert.equal(locked.retryAfter, '60');
    assert.deepEqual(locked.body, { error: 'too_many_attempts', retryAfterSeconds: 60 });
    assert.equal(app.store.channelRows.size, 0);

    app.clock.now += 60_000;
    assert.equal((await saveTelegram()).status, 200);
  });

  it('checks the password before the settings and the secret', async () => {
    const res = await notificationsCall('PUT', notificationChannelPath('telegram'), {
      password: WRONG,
      settings: { chatId: 'not a chat' },
      secret: 'not a token',
    });

    assert.equal(res.status, 401);
  });

  it('answers the view with the channel saved and on, its secret in no answer', async () => {
    const res = await saveTelegram();

    assert.equal(res.status, 200);
    const telegram = (res.body as NotificationsView).channels[2]!;
    assert.equal(telegram.saved, true);
    assert.equal(telegram.enabled, true);
    assert.deepEqual(telegram.settings, TELEGRAM_SETTINGS);
    assert.equal(telegram.savedBy, USERNAME);
    assert.equal(openChannelSecret('telegram', app.store.channelRows.get('telegram')!.secret, KEY), TELEGRAM_TOKEN);
  });

  it('keeps the saved secret when the body leaves it null, empty or out', async () => {
    await saveTelegram();

    for (const body of [
      { password: PASSWORD, settings: { chatId: '@streamalerts' }, secret: null },
      { password: PASSWORD, settings: { chatId: '@streamalerts' }, secret: '' },
      { password: PASSWORD, settings: { chatId: '@streamalerts' } },
    ]) {
      const res = await notificationsCall('PUT', notificationChannelPath('telegram'), body);
      assert.equal(res.status, 200, JSON.stringify(body));
    }

    const row = app.store.channelRows.get('telegram')!;
    assert.deepEqual(row.settings, { chatId: '@streamalerts' });
    assert.equal(openChannelSecret('telegram', row.secret, KEY), TELEGRAM_TOKEN);
  });

  it('answers the problems of the settings and the secret with 400 validation_error, a sentence each', async () => {
    const res = await notificationsCall('PUT', notificationChannelPath('telegram'), {
      password: PASSWORD,
      settings: { chatId: 'not a chat' },
      secret: 'not a token',
    });

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: 'validation_error',
      errors: [
        "The chat id is a whole number, such as -1001234567890 for a group, or a public channel's name, such as @channelname.",
        "Enter the bot's token as BotFather gave it: the bot's number, a colon, and its key.",
      ],
    });
    assert.equal(app.store.channelRows.size, 0);
  });

  it('refuses a body that is not a save with 400, in sentences that repeat no value', async () => {
    const refused: [Record<string, unknown>, string][] = [
      [{ settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN }, 'password is required'],
      [{ password: PASSWORD, secret: TELEGRAM_TOKEN }, 'settings are required'],
      [{ password: { value: PASSWORD }, settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN }, 'password is a string'],
      [
        { password: 'p'.repeat(129), settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN },
        'password must be at most 128 characters',
      ],
      [
        { password: PASSWORD, settings: TELEGRAM_SETTINGS, secret: { token: TELEGRAM_TOKEN } },
        'secret is a string, or null to keep the saved one',
      ],
    ];
    for (const [body, sentence] of refused) {
      const res = await notificationsCall('PUT', notificationChannelPath('telegram'), body);
      assert.equal(res.status, 400, sentence);
      assert.deepEqual(res.body, { error: 'validation_error', errors: [sentence] });
    }
    assert.equal(app.store.channelRows.size, 0);
  });

  it('is 409 notifications_unavailable without BRAND_WALLET_SECRET, after the password', async () => {
    await app.close();
    await useApp({ secretKey: null });

    const view = await notificationsCall('GET', NOTIFICATIONS_PATH);
    assert.equal((view.body as NotificationsView).available, false);
    assert.equal((await saveTelegram(WRONG)).status, 401);
    const res = await saveTelegram();

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: 'notifications_unavailable',
      message:
        "The admin has no BRAND_WALLET_SECRET, which the channels' secrets are kept under, so no channel can be saved or tested.",
    });
    assert.equal(app.store.channelRows.size, 0);
  });
});

describe('switching, testing and removing a channel', () => {
  it('switches a saved channel off and on with no password', async () => {
    await saveTelegram();

    const off = await notificationsCall('PUT', notificationChannelEnabledPath('telegram'), { enabled: false });
    assert.equal(off.status, 200);
    assert.equal((off.body as NotificationsView).channels[2]!.enabled, false);
    const on = await notificationsCall('PUT', notificationChannelEnabledPath('telegram'), { enabled: true });
    assert.equal((on.body as NotificationsView).channels[2]!.enabled, true);

    const bad = await notificationsCall('PUT', notificationChannelEnabledPath('telegram'), { enabled: 'maybe' });
    assert.equal(bad.status, 400);
  });

  it('answers 409 channel_not_saved for a switch or a test of a channel never saved', async () => {
    const switched = await notificationsCall('PUT', notificationChannelEnabledPath('slack'), { enabled: true });
    const tested = await notificationsCall('POST', notificationChannelTestPath('slack'));

    for (const res of [switched, tested]) {
      assert.equal(res.status, 409);
      assert.deepEqual(res.body, {
        error: 'channel_not_saved',
        kind: 'slack',
        message: 'The Slack channel is not saved. Save it first.',
      });
    }
  });

  it('sends a test with the saved values whatever the body says, and a second within a minute is 429', async () => {
    await saveTelegram();

    const res = await notificationsCall('POST', notificationChannelTestPath('telegram'), {
      settings: { chatId: '@elsewhere' },
      secret: `9876543210:${'B'.repeat(35)}`,
    });

    assert.equal(res.status, 200);
    const answer = res.body as NotificationTestResponse;
    assert.equal(answer.sent, true);
    assert.equal(answer.error, null);
    assert.equal(answer.view.channels[2]!.lastTestAt, '2026-11-25T10:00:00.000Z');
    assert.deepEqual(app.configs, [{ kind: 'telegram', settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN }]);

    app.clock.now += 15_000;
    const again = await notificationsCall('POST', notificationChannelTestPath('telegram'));
    assert.equal(again.status, 429);
    assert.equal(again.retryAfter, '45');
    assert.deepEqual(again.body, {
      error: 'test_too_soon',
      kind: 'telegram',
      retryAfterSeconds: 45,
      message:
        'A test notice went out on the Telegram channel less than a minute ago. Send the next one in 45 seconds.',
    });
    assert.equal(app.configs.length, 1);
  });

  it('removes a channel with its secret, with no password', async () => {
    await saveTelegram();

    const res = await notificationsCall('DELETE', notificationChannelPath('telegram'));

    assert.equal(res.status, 200);
    assert.equal((res.body as NotificationsView).channels[2]!.saved, false);
    assert.equal(app.store.channelRows.has('telegram'), false);
    assert.deepEqual(
      app.audit.entries.filter((entry) => entry.action.startsWith('notification.')).map((entry) => entry.action),
      ['notification.channel.save', 'notification.channel.remove'],
    );
  });
});

describe('Find chat id', () => {
  it('answers the chats read with the token typed, with no password, and saves nothing', async () => {
    const res = await notificationsCall('POST', TELEGRAM_CHATS_PATH, { secret: TELEGRAM_TOKEN });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body as TelegramChatsResponse, { chats: TELEGRAM_CHATS, error: null });
    assert.deepEqual(app.lookups, [TELEGRAM_TOKEN]);
    assert.equal(app.store.channelRows.size, 0);
  });

  it("reads with the saved channel's token when the body names none", async () => {
    await saveTelegram();

    for (const body of [{ secret: null }, { secret: '' }, {}]) {
      const res = await notificationsCall('POST', TELEGRAM_CHATS_PATH, body);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.deepEqual((res.body as TelegramChatsResponse).chats, TELEGRAM_CHATS);
    }
    assert.deepEqual(app.lookups, [TELEGRAM_TOKEN, TELEGRAM_TOKEN, TELEGRAM_TOKEN]);
  });

  it('answers 400 validation_error for a token the rules refuse, and for a body that is not a lookup', async () => {
    const refused = await notificationsCall('POST', TELEGRAM_CHATS_PATH, { secret: 'not a token' });
    assert.equal(refused.status, 400);
    assert.equal((refused.body as { error: string }).error, 'validation_error');
    assert.deepEqual((refused.body as { errors: string[] }).errors, [
      "Enter the bot's token as BotFather gave it: the bot's number, a colon, and its key.",
    ]);

    const shapes: [Record<string, unknown>, string][] = [
      [{ secret: 1234567890 }, "Enter the bot's token as BotFather gave it: the bot's number, a colon, and its key."],
      [{ secret: { token: TELEGRAM_TOKEN } }, "secret is the bot's token, or null for the saved one"],
    ];
    for (const [body, sentence] of shapes) {
      const res = await notificationsCall('POST', TELEGRAM_CHATS_PATH, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.body, { error: 'validation_error', errors: [sentence] });
    }
    assert.deepEqual(app.lookups, []);
  });

  it('answers 409 channel_not_saved with no token typed and none saved, and 409 notifications_unavailable without BRAND_WALLET_SECRET', async () => {
    const notSaved = await notificationsCall('POST', TELEGRAM_CHATS_PATH, { secret: null });
    assert.equal(notSaved.status, 409);
    assert.equal((notSaved.body as { error: string }).error, 'channel_not_saved');

    await app.close();
    await useApp({ secretKey: null });
    const unavailable = await notificationsCall('POST', TELEGRAM_CHATS_PATH, { secret: null });
    assert.equal(unavailable.status, 409);
    assert.equal((unavailable.body as { error: string }).error, 'notifications_unavailable');
    assert.deepEqual(app.lookups, []);
  });
});
