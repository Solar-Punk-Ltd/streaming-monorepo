/**
 * The list of the stamps not on auto top-up as the console reads it: the real router and session gate on a random
 * port, over the store in memory. Unit test — no database. `pnpm test`.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  FUNDING_AUTO_TOPUP_UNMARKED_PATH,
  SESSION_COOKIE_NAME,
  type AutoTopUpUnmarkedView,
} from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { createAutoTopUpUnmarkedRouter } from '../../src/api/routes/autoTopUpUnmarked.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { InMemoryAuditLog } from './support/fakes.js';
import { BATCH_CATALOGUE, BATCH_STAGE, NODE_A, NODE_CATALOGUE } from './support/fundingFakes.js';
import { InMemoryUnmarkedStampStore } from './support/unmarkedStampFakes.js';

const PASSWORD = 'a-long-enough-password';
const T0 = new Date('2026-11-24T12:00:00.000Z');
const LATER = new Date('2026-11-24T13:00:00.000Z');

let server: http.Server;
let url: string;
let cookie: string;
let store: InMemoryUnmarkedStampStore;
let failing: Error | null;

before(async () => {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const audit = new InMemoryAuditLog();
  const auth = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  await auth.addUser(TEST_SETUP, 'owner', PASSWORD);
  const { token } = await auth.signIn({ username: 'owner', password: PASSWORD, ip: '127.0.0.1', userAgent: null });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;

  const app = express();
  app.use(express.json());
  app.use(
    FUNDING_AUTO_TOPUP_UNMARKED_PATH,
    createAutoTopUpUnmarkedRouter({
      unmarkedStamps: {
        rows: () => (failing === null ? store.rows() : Promise.reject(failing)),
      },
      requireAuth: createRequireAuth(auth),
    }),
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

beforeEach(() => {
  store = new InMemoryUnmarkedStampStore();
  failing = null;
});

function read(signedIn = true): Promise<Response> {
  return fetch(`${url}${FUNDING_AUTO_TOPUP_UNMARKED_PATH}`, { headers: signedIn ? { cookie } : {} });
}

describe('the list of the stamps not on auto top-up', () => {
  it('answers 401 without a session, and an empty list while none is listed', async () => {
    assert.equal((await read(false)).status, 401);

    const res = await read();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stamps: [] });
  });

  it('answers the listed stamps, the least time left first, with their moments in ISO 8601', async () => {
    await store.record(
      { batchId: BATCH_STAGE, nodeId: NODE_A, holder: 'stage', level: 'low', message: 'The stage batch is low.' },
      T0,
    );
    await store.record(
      {
        batchId: BATCH_CATALOGUE,
        nodeId: NODE_CATALOGUE,
        holder: 'catalogue',
        level: 'low',
        message: 'The catalogue batch is low.',
      },
      T0,
    );
    await store.record(
      {
        batchId: BATCH_CATALOGUE,
        nodeId: NODE_CATALOGUE,
        holder: 'catalogue',
        level: 'last',
        message: 'The catalogue batch has under 2 days.',
      },
      LATER,
    );
    await store.setNotified([{ batchId: BATCH_CATALOGUE, level: 'last' }], LATER);

    const res = await read();
    assert.equal(res.status, 200);
    const view = (await res.json()) as AutoTopUpUnmarkedView;
    assert.deepEqual(view.stamps, [
      {
        batchId: BATCH_CATALOGUE,
        nodeId: NODE_CATALOGUE,
        holder: 'catalogue',
        level: 'last',
        since: T0.toISOString(),
        levelSince: LATER.toISOString(),
        message: 'The catalogue batch has under 2 days.',
        notifiedAt: LATER.toISOString(),
      },
      {
        batchId: BATCH_STAGE,
        nodeId: NODE_A,
        holder: 'stage',
        level: 'low',
        since: T0.toISOString(),
        levelSince: T0.toISOString(),
        message: 'The stage batch is low.',
        notifiedAt: null,
      },
    ]);
  });

  it('answers 500 without the reason when the list cannot be read', async () => {
    failing = new Error('the database did not answer');
    const res = await read();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal_error' });
  });
});
