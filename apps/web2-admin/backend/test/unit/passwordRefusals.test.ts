/**
 * The routes that take a password, over HTTP: the real routers, session gate, cross-site check and error mapping on a
 * random port, mounted as `src/api/server.ts` mounts them, with the users and sessions in memory and services that no
 * request here reaches. `pnpm test`.
 *
 * Pinned here: signing in, the password change (its current and its new password), adding a user, a funding pin and
 * a send, stamp auto top-up's settings and a notification channel's save each refuse a password that is not a string,
 * missing, or over `PASSWORD_MAX_LENGTH` characters with 400 `validation_error`, in a sentence of the schema's own that
 * repeats no part of the value sent. yup's default sentence for a value that is not a string prints the value.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AUTO_TOPUP_DEFAULTS,
  FUNDING_AUTO_TOPUP_PATH,
  FUNDING_AUTO_TOPUP_SETTINGS_PATH,
  FUNDING_PATH,
  FUNDING_PINS_PATH,
  FUNDING_TRANSFERS_ADMIN_PATH,
  NOTIFICATIONS_PATH,
  notificationChannelPath,
  PASSWORD_MAX_LENGTH,
} from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { type AutoTopUpRoutesDeps, createAutoTopUpRouter } from '../../src/api/routes/autoTopUp.js';
import { createFundingRouter, type FundingRoutesDeps } from '../../src/api/routes/funding.js';
import { createNotificationsRouter, type NotificationRoutesDeps } from '../../src/api/routes/notifications.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { type AuthTestApp, call, signIn } from './support/authTestApp.js';
import { InMemoryAuditLog } from './support/fakes.js';

const USERNAME = 'alice';
const PASSWORD = 'a-long-enough-password';
const NEW_PASSWORD = 'another-long-enough-password';
const NODE_ID = 'node-a';

/** Every method of the services here: each body is refused by its schema, so no request reaches one. */
function notReached(): never {
  throw new Error('a body its schema should refuse reached the service');
}

const fundingService: FundingRoutesDeps['fundingService'] = {
  view: notReached,
  pin: notReached,
  send: notReached,
  bulk: notReached,
  stampOperations: notReached,
  stampBulk: notReached,
  chequebookOperations: notReached,
  chequebookBulk: notReached,
  batchPurchases: notReached,
  startBatchPurchase: notReached,
  batchPurchase: notReached,
  restartBatchPurchase: notReached,
  checkBatchPurchase: notReached,
};

const autoTopUp: AutoTopUpRoutesDeps['autoTopUp'] = {
  view: notReached,
  saveSettings: notReached,
  setMarks: notReached,
  setJobPaused: notReached,
};

const notifications: NotificationRoutesDeps['notifications'] = {
  view: notReached,
  save: notReached,
  setEnabled: notReached,
  remove: notReached,
  test: notReached,
};

async function startPasswordTestApp(): Promise<AuthTestApp> {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const audit = new InMemoryAuditLog();
  const authService = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  const requireAuth = createRequireAuth(authService);

  const app = express();
  app.use(requireSameSite);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/auth', createAuthRouter(authService, requireAuth));
  app.use(FUNDING_AUTO_TOPUP_PATH, createAutoTopUpRouter({ autoTopUp, authService, requireAuth }));
  app.use(FUNDING_PATH, createFundingRouter({ fundingService, authService, requireAuth }));
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

interface PasswordRoute {
  /** The route, as the tests name it. */
  name: string;
  method: 'POST' | 'PUT';
  path: string;
  /** The body's password field. */
  field: 'password' | 'currentPassword' | 'newPassword';
  /** The rest of a body the route's schema takes, so the password's sentence is the only one. */
  rest: Record<string, unknown>;
  /** Signing in is the one route here asked without a session. */
  session: boolean;
}

const ROUTES: PasswordRoute[] = [
  {
    name: 'signing in',
    method: 'POST',
    path: '/api/auth/login',
    field: 'password',
    rest: { username: USERNAME },
    session: false,
  },
  {
    name: "the password change's current password",
    method: 'POST',
    path: '/api/auth/password',
    field: 'currentPassword',
    rest: { newPassword: NEW_PASSWORD },
    session: true,
  },
  {
    name: "the password change's new password",
    method: 'POST',
    path: '/api/auth/password',
    field: 'newPassword',
    rest: { currentPassword: PASSWORD },
    session: true,
  },
  {
    name: 'adding a user',
    method: 'POST',
    path: '/api/auth/users',
    field: 'password',
    rest: { username: 'bob' },
    session: true,
  },
  {
    name: 'a funding pin',
    method: 'POST',
    path: FUNDING_PINS_PATH,
    field: 'password',
    rest: { nodeIds: [NODE_ID] },
    session: true,
  },
  {
    name: 'a funding send',
    method: 'POST',
    path: FUNDING_TRANSFERS_ADMIN_PATH,
    field: 'password',
    rest: { items: [{ nodeId: NODE_ID, kind: 'xdai', amount: '1' }] },
    session: true,
  },
  {
    name: "stamp auto top-up's settings",
    method: 'PUT',
    path: FUNDING_AUTO_TOPUP_SETTINGS_PATH,
    field: 'password',
    rest: { settings: AUTO_TOPUP_DEFAULTS },
    session: true,
  },
  {
    name: "a notification channel's save",
    method: 'PUT',
    path: notificationChannelPath('telegram'),
    field: 'password',
    rest: { settings: { chatId: '-1001234567890' }, secret: null },
    session: true,
  },
];

/**
 * Passwords that are not a string, each with its parts as a sentence that printed it would hold. A number is not one:
 * yup casts it to its digits, which the route checks as a password.
 */
const NOT_STRINGS: { value: unknown; parts: string[] }[] = [
  { value: { a: 1 }, parts: ['{', '}', '"a"', '1'] },
  { value: [1, 2], parts: ['[', ']', '1', '2'] },
];

let app: AuthTestApp;
let cookie: string;

before(async () => {
  app = await startPasswordTestApp();
  await app.authService.addUser(TEST_SETUP, USERNAME, PASSWORD);
  cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
});

after(() => app.close());

/** The route's answer to its body with this password, or with none when it is undefined. */
async function sendPassword(route: PasswordRoute, password: unknown) {
  const body = password === undefined ? route.rest : { ...route.rest, [route.field]: password };
  return call(app, route.method, route.path, { cookie: route.session ? cookie : null, body });
}

for (const route of ROUTES) {
  describe(route.name, () => {
    it(`refuses a ${route.field} that is not a string with "${route.field} is a string", repeating no part of it`, async () => {
      for (const { value, parts } of NOT_STRINGS) {
        const res = await sendPassword(route, value);

        const errors = (res.body as { errors?: string[] }).errors ?? [];
        for (const part of parts) {
          assert.ok(
            errors.every((sentence) => !sentence.includes(part)),
            `${JSON.stringify(value)} answered ${JSON.stringify(errors)}, which repeats ${part}`,
          );
        }
        assert.equal(res.status, 400, JSON.stringify(value));
        assert.deepEqual(res.body, { error: 'validation_error', errors: [`${route.field} is a string`] });
      }
    });

    it(`refuses a missing ${route.field} with "${route.field} is required"`, async () => {
      const res = await sendPassword(route, undefined);

      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'validation_error', errors: [`${route.field} is required`] });
    });

    it(`refuses a ${route.field} over ${PASSWORD_MAX_LENGTH} characters with a sentence that does not repeat it`, async () => {
      const res = await sendPassword(route, 'p'.repeat(PASSWORD_MAX_LENGTH + 1));

      assert.equal(res.status, 400);
      assert.deepEqual(res.body, {
        error: 'validation_error',
        errors: [`${route.field} must be at most ${PASSWORD_MAX_LENGTH} characters`],
      });
    });
  });
}
