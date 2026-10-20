/**
 * `GET /api/config` over HTTP: the real routers, session gate, cross-site check and error mapping on a random port,
 * mounted as `src/api/server.ts` mounts them, with the console's settings, the users and the sessions in memory.
 * `pnpm test`.
 *
 * Pinned here: the public config names the host's default look, Swarm with no row and for a stored look the console
 * no longer carries. The route that once let an admin change it is gone and answers 404.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { PublicConfig } from '@streaming-monorepo/web2-admin-common';
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
  const consoleSettings = new ConsoleSettingsService(store);
  const requireAuth = createRequireAuth(authService);

  const app = express();
  app.use(requireSameSite);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/config', createConfigRouter({ feed: FEED, viewerBaseUrl: VIEWER, consoleSettings }));
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

before(async () => {
  app = await startConfigTestApp();
  await app.authService.addUser(TEST_SETUP, ADMIN, PASSWORD);
  adminCookie = (await signIn(app, ADMIN, PASSWORD)).cookie;
});

after(() => app.close());

beforeEach(() => {
  app.store.stored = null;
  app.store.failReads = false;
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
      defaultTheme: 'swarm',
    });
  });

  it('names the look an admin stored', async () => {
    app.store.stored = 'web3privacy';

    assert.equal((await config()).defaultTheme, 'web3privacy');
  });

  it('answers Swarm for a stored look the console no longer carries, the retired Default included', async () => {
    for (const retired of ['retired-look', 'default']) {
      app.store.stored = retired;

      assert.equal((await config()).defaultTheme, 'swarm', retired);
    }
  });

  it('still answers the feed and the viewer, in the Swarm look, when the look cannot be read', async () => {
    app.store.failReads = true;

    assert.deepEqual(await config(), {
      feed: { owner: FEED.owner, topic: FEED.topic, topicHex: FEED.topicHex },
      viewerBaseUrl: VIEWER,
      defaultTheme: 'swarm',
    });
  });
});

describe('the retired PUT /api/config/default-theme', () => {
  it('is no route, even for an admin, and stores nothing', async () => {
    const res = await call(app, 'PUT', '/api/config/default-theme', {
      cookie: adminCookie,
      body: { defaultTheme: 'web3privacy' },
    });

    assert.equal(res.status, 404);
    assert.equal((res.body as { error: string }).error, 'not_found');
    assert.equal(app.store.stored, null);
  });
});
