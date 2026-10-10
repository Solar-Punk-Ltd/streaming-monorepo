/**
 * Who gets into the funding API under /api/admin-funding, and who gets out of it into the operator's routes.
 *
 * The web2 admin calls this API with `Authorization: Bearer <FUNDING_API_TOKEN>` and nothing else. A session cookie is
 * not a way in, and the bearer is no way into an operator's route, so neither credential crosses into the other's
 * scope. Without a token the API is off and every path under it answers 404 `funding_off`.
 *
 * Unit test, no database and no Docker: the real gate, router and operator-route refusal, assembled in the order
 * `api/server.ts` mounts them, with a fake inventory and a fake session. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import { ADMIN_FUNDING_PATH, FUNDING_INVENTORY_PATH, type FundingInventory } from '@streaming-monorepo/contracts';
import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, SESSION_COOKIE_NAME } from '@streaming-infra-manager/common';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { refuseFundingBearer } from '../../src/api/middleware/fundingBearer.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { createAdminFundingRouter, createFundingInventoryRouter } from '../../src/api/routes/adminFunding.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import { fundingApiToken } from '../../src/utils/config.js';

const TOKEN = 'f'.repeat(24) + 'u'.repeat(24);

const INVENTORY: FundingInventory = {
  observedAt: '2026-10-05T10:00:00.000Z',
  chain: { chainId: 100, bzzToken: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da' },
  stages: [],
  catalogue: null,
};

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

/** The app in `api/server.ts`'s order: the funding API, the bearer refusal, the cross-site gate, the session gate. */
async function testApi(t: TestContext, token: string | null) {
  let reads = 0;
  const app = express();
  app.use(
    ADMIN_FUNDING_PATH,
    createAdminFundingRouter(token, [
      createFundingInventoryRouter({
        inventory: async () => {
          reads += 1;
          return INVENTORY;
        },
      }),
    ]),
  );
  app.use(refuseFundingBearer);
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession(session));
  app.get('/profiles', (_req, res) => void res.json({ profiles: [] }));
  app.post('/profiles', (_req, res) => void res.status(201).json({ created: true }));
  app.use(notFound);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function send(
    path: string,
    {
      method = 'GET',
      bearer,
      authorization,
      cookie = false,
      sameSite = false,
      body,
      contentType = 'application/json',
    }: Record<string, unknown> = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method: method as string,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer as string}` } : {}),
        ...(authorization ? { authorization: authorization as string } : {}),
        ...(cookie ? { cookie: `${SESSION_COOKIE_NAME}=test-session` } : {}),
        ...(sameSite ? { [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE } : {}),
        ...(body === undefined ? {} : { 'content-type': contentType as string }),
      },
      body: body as string | undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      headers: response.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
  }

  return { send, reads: () => reads };
}

describe('FUNDING_API_TOKEN', () => {
  it('turns the API off when unset or empty', () => {
    assert.equal(fundingApiToken(undefined), null);
    assert.equal(fundingApiToken(''), null);
    assert.equal(fundingApiToken('   '), null);
  });

  it('takes a token of 32 characters or more', () => {
    assert.equal(fundingApiToken('a'.repeat(32)), 'a'.repeat(32));
    assert.equal(fundingApiToken(` ${TOKEN} `), TOKEN);
  });

  it('stops the manager at startup on a shorter token, or one with a space inside, naming itself and not the value', () => {
    for (const raw of ['a'.repeat(31), `${'a'.repeat(20)} ${'b'.repeat(20)}`]) {
      assert.throws(
        () => fundingApiToken(raw),
        (err: Error) => /FUNDING_API_TOKEN/.test(err.message) && !err.message.includes(raw.trim()),
        raw,
      );
    }
  });
});

describe('the funding API', () => {
  it('is off without a token: every path under it answers 404 funding_off, whatever is presented', async (t) => {
    const api = await testApi(t, null);
    for (const [path, options] of [
      [FUNDING_INVENTORY_PATH, { bearer: TOKEN }],
      [FUNDING_INVENTORY_PATH, {}],
      [`${ADMIN_FUNDING_PATH}/anything`, { bearer: TOKEN }],
    ] as const) {
      const answer = await api.send(path, options);
      assert.equal(answer.status, 404, path);
      assert.equal(answer.body?.error, 'funding_off');
    }
    assert.equal(api.reads(), 0);
  });

  it('refuses a request with no bearer, 401 unauthorized', async (t) => {
    const api = await testApi(t, TOKEN);
    const answer = await api.send(FUNDING_INVENTORY_PATH);
    assert.equal(answer.status, 401);
    assert.equal(answer.body?.error, 'unauthorized');
    assert.equal(api.reads(), 0);
  });

  it('refuses the wrong bearer, a longer and a shorter one included, and never echoes what was presented', async (t) => {
    const api = await testApi(t, TOKEN);
    for (const wrong of [`${TOKEN.slice(0, -1)}x`, `${TOKEN}x`, 'short']) {
      const answer = await api.send(FUNDING_INVENTORY_PATH, { bearer: wrong });
      assert.equal(answer.status, 401, wrong);
      assert.equal(answer.body?.error, 'unauthorized');
      assert.ok(!answer.text.includes(wrong), 'the answer repeats the presented token');
    }
    assert.equal(api.reads(), 0);
  });

  it('refuses the right bearer when a session cookie comes with it', async (t) => {
    const api = await testApi(t, TOKEN);
    const answer = await api.send(FUNDING_INVENTORY_PATH, { bearer: TOKEN, cookie: true });
    assert.equal(answer.status, 401);
    assert.equal(answer.body?.error, 'unauthorized');
    assert.equal(api.reads(), 0);
  });

  it('refuses a session cookie alone', async (t) => {
    const api = await testApi(t, TOKEN);
    const answer = await api.send(FUNDING_INVENTORY_PATH, { cookie: true, sameSite: true });
    assert.equal(answer.status, 401);
    assert.equal(api.reads(), 0);
  });

  it('answers the inventory on the right bearer, uncached, without the cross-site header', async (t) => {
    const api = await testApi(t, TOKEN);
    const answer = await api.send(FUNDING_INVENTORY_PATH, { bearer: TOKEN });
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.body, INVENTORY);
    assert.equal(api.reads(), 1);
  });

  it('answers 404 for a path under it that names no route, once the bearer is right', async (t) => {
    const api = await testApi(t, TOKEN);
    const answer = await api.send(`${ADMIN_FUNDING_PATH}/nothing-here`, { bearer: TOKEN });
    assert.equal(answer.status, 404);
  });
});

describe('the bearer as the gate reads it', () => {
  it('takes the scheme in any case and spaces around the token, as RFC 9110 allows', async (t) => {
    const api = await testApi(t, TOKEN);
    for (const authorization of [`bearer ${TOKEN}`, `BEARER ${TOKEN}`, `Bearer    ${TOKEN}`]) {
      assert.equal((await api.send(FUNDING_INVENTORY_PATH, { authorization })).status, 200, authorization);
    }
  });

  it('refuses a scheme with nothing after it, another scheme, and the token alone', async (t) => {
    const api = await testApi(t, TOKEN);
    for (const authorization of ['Bearer ', 'Bearer', `Basic ${TOKEN}`, TOKEN, `Bearer${TOKEN}`]) {
      const answer = await api.send(FUNDING_INVENTORY_PATH, { authorization });
      assert.equal(answer.status, 401, JSON.stringify(authorization));
      assert.equal(answer.body?.error, 'unauthorized');
    }
    assert.equal(api.reads(), 0);
  });
});

describe('the paths the gate covers', () => {
  it('covers the prefix itself and with a trailing slash', async (t) => {
    const on = await testApi(t, TOKEN);
    const off = await testApi(t, null);
    for (const path of [ADMIN_FUNDING_PATH, `${ADMIN_FUNDING_PATH}/`]) {
      const refused = await on.send(path);
      assert.equal(refused.status, 401, path);
      assert.equal(refused.body?.error, 'unauthorized');
      assert.equal((await off.send(path, { bearer: TOKEN })).body?.error, 'funding_off', path);
      assert.equal((await on.send(path, { bearer: TOKEN })).status, 404, `${path} names no route`);
    }
  });

  it('covers HEAD and OPTIONS, and answers no CORS header', async (t) => {
    const api = await testApi(t, TOKEN);
    for (const method of ['HEAD', 'OPTIONS']) {
      const answer = await api.send(FUNDING_INVENTORY_PATH, { method });
      assert.equal(answer.status, 401, method);
      assert.equal(answer.headers.get('access-control-allow-origin'), null, method);
      assert.equal(answer.headers.get('access-control-allow-methods'), null, method);
    }
    assert.equal((await api.send(FUNDING_INVENTORY_PATH, { method: 'HEAD', bearer: TOKEN })).status, 200);
    assert.equal(api.reads(), 1);
  });

  it('leaves a path that only begins like it to the operator’s routes', async (t) => {
    const api = await testApi(t, TOKEN);
    const withBearer = await api.send(`${ADMIN_FUNDING_PATH}X`, { bearer: TOKEN });
    assert.equal(withBearer.status, 401);
    assert.match(String(withBearer.body?.message), /bearer/i, 'refused by the bearer refusal, not the gate');
    const alone = await api.send(`${ADMIN_FUNDING_PATH}X`);
    assert.equal(alone.status, 401);
    assert.equal(alone.body?.error, 'not_signed_in');
  });
});

describe('a body the funding API cannot read', () => {
  it('is answered in the contract’s shape: 400 bad_transaction for JSON that is not JSON', async (t) => {
    const api = await testApi(t, TOKEN);
    const answer = await api.send(FUNDING_INVENTORY_PATH, { method: 'POST', bearer: TOKEN, body: '{"requestId":' });
    assert.equal(answer.status, 400, answer.text);
    assert.equal(answer.body?.error, 'bad_transaction');
    assert.equal(typeof answer.body?.message, 'string');
    assert.deepEqual(Object.keys(answer.body ?? {}).sort(), ['error', 'message']);
  });

  it('is answered in the contract’s shape: 413 bad_transaction for a body over 256 kB', async (t) => {
    const api = await testApi(t, TOKEN);
    const body = JSON.stringify({ rawTransaction: `0x${'ab'.repeat(140_000)}` });
    const answer = await api.send(FUNDING_INVENTORY_PATH, { method: 'POST', bearer: TOKEN, body });
    assert.equal(answer.status, 413, answer.text);
    assert.equal(answer.body?.error, 'bad_transaction');
    assert.deepEqual(Object.keys(answer.body ?? {}).sort(), ['error', 'message']);
  });

  it('is never read before the gate has passed', async (t) => {
    const api = await testApi(t, TOKEN);
    const answer = await api.send(FUNDING_INVENTORY_PATH, { method: 'POST', body: '{"requestId":' });
    assert.equal(answer.status, 401);
    assert.equal(answer.body?.error, 'unauthorized');
  });
});

describe('the operator’s routes', () => {
  it('refuse a request carrying a bearer, a valid session cookie beside it included', async (t) => {
    const api = await testApi(t, TOKEN);
    const read = await api.send('/profiles', { bearer: TOKEN, cookie: true });
    assert.equal(read.status, 401);
    const write = await api.send('/profiles', { method: 'POST', bearer: TOKEN, cookie: true, sameSite: true });
    assert.equal(write.status, 401);
    assert.ok(!write.text.includes(TOKEN));
  });

  it('refuse a bearer while the funding API is off as well', async (t) => {
    const api = await testApi(t, null);
    assert.equal((await api.send('/profiles', { bearer: TOKEN, cookie: true })).status, 401);
  });

  it('still take a session cookie alone', async (t) => {
    const api = await testApi(t, TOKEN);
    assert.equal((await api.send('/profiles', { cookie: true })).status, 200);
    assert.equal((await api.send('/profiles', { method: 'POST', cookie: true, sameSite: true })).status, 201);
  });
});
