/**
 * `GET /api/config` and `PUT /api/config/default-theme` over HTTP: the real routers, session gate, cross-site check and
 * error mapping on a random port, mounted as `src/api/server.ts` mounts them, with the console's settings, the users
 * and the sessions in memory. `pnpm test`.
 *
 * Pinned here: the public config names the host's default look, Default with no row and for a stored look the console
 * no longer carries; the change is refused without a session, for a user who is not an admin, from another site and
 * for a name the console does not carry, and an admin's change is stored, answered and audited with the look it
 * replaced.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  CONSOLE_DEFAULT_THEME_PATH,
  type PublicConfig,
  type SetDefaultThemeResponse,
} from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createConfigRouter } from '../../src/api/routes/config.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { ConsoleSettingsService } from '../../src/domain/ConsoleSettingsService.js';
import { feedIdentityFrom } from '../../src/domain/feedIdentity.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { type AuthTestApp, call, signIn } from './support/authTestApp.js';
import { InMemoryConsoleSettingsStore } from './support/consoleSettingsFakes.js';
import { InMemoryAuditLog } from './support/fakes.js';

const ADMIN = 'alice';
const PLAIN = 'bob';
const PASSWORD = 'a-long-enough-password';

const FEED = feedIdentityFrom(`0x${'11'.repeat(32)}`, 'test-catalogue');
const VIEWER = 'https://viewer.example.com';

interface ConfigTestApp extends AuthTestApp {
  store: InMemoryConsoleSettingsStore;
}

async function startConfigTestApp(): Promise<ConfigTestApp> {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const audit = new InMemoryAuditLog();
  const authService = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  const store = new InMemoryConsoleSettingsStore();
  const consoleSettings = new ConsoleSettingsService(store, audit);
  const requireAuth = createRequireAuth(authService);

  const app = express();
  app.use(requireSameSite);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/config', createConfigRouter({ feed: FEED, viewerBaseUrl: VIEWER, consoleSettings, requireAuth }));
  app.use('/api/auth', createAuthRouter(authService, requireAuth));
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let app: ConfigTestApp;
let adminCookie: string;
let plainCookie: string;

before(async () => {
  app = await startConfigTestApp();
  await app.authService.addUser(TEST_SETUP, ADMIN, PASSWORD);
  await app.authService.addUser(TEST_SETUP, PLAIN, PASSWORD, { admin: false });
  adminCookie = (await signIn(app, ADMIN, PASSWORD)).cookie;
  plainCookie = (await signIn(app, PLAIN, PASSWORD)).cookie;
});

after(() => app.close());

beforeEach(() => {
  app.store.stored = null;
  app.store.updatedBy = null;
  app.audit.entries.length = 0;
});

const config = async () => {
  const res = await call(app, 'GET', '/api/config');
  assert.equal(res.status, 200);
  return res.body as PublicConfig;
};

describe('GET /api/config', () => {
  it('answers anyone, without a session, with the feed, the viewer and the host default look', async () => {
    assert.deepEqual(await config(), {
      feed: { owner: FEED.owner, topic: FEED.topic, topicHex: FEED.topicHex },
      viewerBaseUrl: VIEWER,
      defaultTheme: 'default',
    });
  });

  it('names the look an admin stored', async () => {
    app.store.stored = 'swarm';

    assert.equal((await config()).defaultTheme, 'swarm');
  });

  it('answers Default for a stored look the console no longer carries', async () => {
    app.store.stored = 'retired-look';

    assert.equal((await config()).defaultTheme, 'default');
  });
});

describe('PUT /api/config/default-theme', () => {
  it('refuses a request with no session, and stores nothing', async () => {
    const res = await call(app, 'PUT', CONSOLE_DEFAULT_THEME_PATH, { body: { defaultTheme: 'swarm' } });

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthenticated' });
    assert.equal(app.store.stored, null);
  });

  it('refuses a signed-in user who is not an admin', async () => {
    const res = await call(app, 'PUT', CONSOLE_DEFAULT_THEME_PATH, {
      cookie: plainCookie,
      body: { defaultTheme: 'swarm' },
    });

    assert.equal(res.status, 403);
    assert.equal((res.body as { error: string }).error, 'admin_required');
    assert.equal(app.store.stored, null);
    assert.deepEqual(app.audit.withAction('console.theme.set'), []);
  });

  it('refuses a write without the header no other site can send', async () => {
    const res = await call(app, 'PUT', CONSOLE_DEFAULT_THEME_PATH, {
      cookie: adminCookie,
      body: { defaultTheme: 'swarm' },
      requestedWith: false,
    });

    assert.equal(res.status, 403);
    assert.equal((res.body as { error: string }).error, 'cross_site_request');
    assert.equal(app.store.stored, null);
  });

  it('refuses a look the console does not carry, and a body without one', async () => {
    for (const body of [{ defaultTheme: 'neon' }, { defaultTheme: 'Swarm' }, { defaultTheme: 3 }, {}]) {
      const res = await call(app, 'PUT', CONSOLE_DEFAULT_THEME_PATH, { cookie: adminCookie, body });

      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
    assert.equal(app.store.stored, null);
    assert.deepEqual(app.audit.withAction('console.theme.set'), []);
  });

  it("stores an admin's pick, answers it, and the public config follows", async () => {
    const res = await call(app, 'PUT', CONSOLE_DEFAULT_THEME_PATH, {
      cookie: adminCookie,
      body: { defaultTheme: 'web3privacy' },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body as SetDefaultThemeResponse, { defaultTheme: 'web3privacy' });
    assert.equal(app.store.stored, 'web3privacy');
    assert.equal(app.store.updatedBy, ADMIN);
    assert.equal((await config()).defaultTheme, 'web3privacy');
  });

  it('audits the change with the look the console wore before and the one it wears now', async () => {
    await call(app, 'PUT', CONSOLE_DEFAULT_THEME_PATH, { cookie: adminCookie, body: { defaultTheme: 'swarm' } });
    await call(app, 'PUT', CONSOLE_DEFAULT_THEME_PATH, { cookie: adminCookie, body: { defaultTheme: 'default' } });

    const rows = app.audit.withAction('console.theme.set');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]?.details, { from: 'default', to: 'swarm' });
    assert.deepEqual(rows[1]?.details, { from: 'swarm', to: 'default' });
    assert.equal(rows[0]?.actor.kind, 'operator');
    assert.equal(rows[0]?.actor.kind === 'operator' ? rows[0].actor.username : null, ADMIN);
  });

  it('records a stored look the console no longer carries as the Default it was worn as', async () => {
    app.store.stored = 'retired-look';

    await call(app, 'PUT', CONSOLE_DEFAULT_THEME_PATH, { cookie: adminCookie, body: { defaultTheme: 'swarm' } });

    assert.deepEqual(app.audit.withAction('console.theme.set')[0]?.details, { from: 'default', to: 'swarm' });
  });
});
