/**
 * The manager's own read of the stages it pushes: `GET /stages` and one
 * deployment's last push, behind the session like every router.
 *
 * Unit test, the router on a random port behind the real session gate, with
 * the publisher standing in. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import { type ConsoleStage, SESSION_COOKIE_NAME } from '@streaming-infra-manager/common';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { createStagesRouter } from '../../src/api/routes/stages.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';

const session = {
  async sessionFor(token: string) {
    return token === 'test-session'
      ? {
          user: { id: 7, username: 'operator', isAdmin: false },
          tokenHash: 'test-hash',
          expiresAt: new Date(Date.now() + 60_000),
        }
      : null;
  },
} as unknown as AuthService;

const STAGE: ConsoleStage = {
  name: 'stage-one',
  record: null,
  problem: 'The version has no build yet.',
  lastPush: { outcome: 'skipped-no-record', at: '2026-09-28T10:00:00.000Z' },
};

async function app(t: TestContext): Promise<string> {
  const server = express();
  server.use(createRequireSession(session));
  server.use(
    '/stages',
    createStagesRouter({
      consoleStages: async () => [STAGE],
      lastPush: (name) => (name === 'stage-one' ? STAGE.lastPush : null),
    }),
  );
  server.use(errorHandler);
  const listening = http.createServer(server);
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  t.after(() => listening.close());
  const address = listening.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

const signedIn = { cookie: `${SESSION_COOKIE_NAME}=test-session` };

describe('GET /stages', () => {
  it('answers every stage with its last push, and is not cached', async (t) => {
    const base = await app(t);
    const res = await fetch(`${base}/stages`, { headers: signedIn });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { stages: [STAGE] });
  });

  it('refuses a caller with no session', async (t) => {
    const base = await app(t);
    assert.equal((await fetch(`${base}/stages`)).status, 401);
    assert.equal((await fetch(`${base}/stages/stage-one/registration`)).status, 401);
  });
});

describe('GET /stages/:name/registration', () => {
  it('answers the deployment’s last push, and null before any', async (t) => {
    const base = await app(t);
    const one = await fetch(`${base}/stages/stage-one/registration`, { headers: signedIn });
    assert.deepEqual(await one.json(), { registration: STAGE.lastPush });
    const other = await fetch(`${base}/stages/stage-two/registration`, { headers: signedIn });
    assert.deepEqual(await other.json(), { registration: null });
  });

  it('refuses a name that is not a deployment name', async (t) => {
    const base = await app(t);
    assert.equal((await fetch(`${base}/stages/NOT_A_NAME/registration`, { headers: signedIn })).status, 400);
  });
});
