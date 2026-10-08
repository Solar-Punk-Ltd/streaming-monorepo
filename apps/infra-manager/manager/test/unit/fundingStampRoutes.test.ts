/**
 * The funding API's stamp routes over HTTP: what each answers, and what a request that does not fit the contract is
 * answered with, behind the same gate as the rest of the funding API.
 *
 * Unit test, no database, no chain and no Bee node: the real routers with a fake service. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import {
  ADMIN_FUNDING_PATH,
  FUNDING_STAMP_OPERATIONS_PATH,
  type FundingStampOperationRequest,
  fundingStampOperationPath,
} from '@streaming-monorepo/contracts';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createAdminFundingRouter } from '../../src/api/routes/adminFunding.js';
import { createFundingStampRouter } from '../../src/api/routes/fundingStamps.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';

const TOKEN = 't'.repeat(40);
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const BATCH = `0x${'ab'.repeat(32)}`;
const HASH = `0x${'9a'.repeat(32)}`;

const TOP_UP: FundingStampOperationRequest = {
  requestId: REQUEST,
  kind: 'topup',
  nodeId: '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b:bee-uploader',
  batchId: BATCH,
  expectedDepth: 22,
  amountPerChunkPlur: '414720000',
};

const DILUTE: FundingStampOperationRequest = {
  requestId: REQUEST,
  kind: 'dilute',
  nodeId: '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b:bee-uploader',
  batchId: BATCH,
  expectedDepth: 22,
  newDepth: 24,
};

async function testApi(t: TestContext) {
  const taken: FundingStampOperationRequest[] = [];
  const service = {
    operate: async (request: FundingStampOperationRequest) => {
      taken.push(request);
      if (request.nodeId.startsWith('refused')) {
        throw new FundingApiError('stamp_refused', 'The batch has expired, and nothing revives an expired batch.');
      }
      if (request.nodeId.startsWith('silent')) {
        throw new FundingApiError(
          'node_unreachable',
          'The node’s Bee API could not be reached, so it was asked nothing.',
        );
      }
      return { requestId: request.requestId, kind: request.kind, state: 'confirmed' as const, txHash: HASH };
    },
    status: async (requestId: string) => ({
      requestId,
      kind: 'dilute' as const,
      state: 'unknown' as const,
      txHash: null,
      error: 'The node’s answer was lost.',
    }),
  };
  const app = express();
  app.use(ADMIN_FUNDING_PATH, createAdminFundingRouter(TOKEN, [createFundingStampRouter(service)]));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function send(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, token: string | null = TOKEN) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      cache: response.headers.get('cache-control'),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
  }
  return { send, taken };
}

describe('the funding API’s stamp routes', () => {
  it('take a top-up with 202 and the service’s answer, the request parsed by the contract', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_STAMP_OPERATIONS_PATH, 'POST', {
      ...TOP_UP,
      requestId: REQUEST.toUpperCase(),
      batchId: BATCH.toUpperCase().replace('0X', '0x'),
      extra: 'dropped',
    });
    assert.equal(answer.status, 202);
    assert.deepEqual(answer.body, { requestId: REQUEST, kind: 'topup', state: 'confirmed', txHash: HASH });
    assert.deepEqual(api.taken, [TOP_UP]);
  });

  it('take a dilution of one or two steps', async (t) => {
    const api = await testApi(t);
    assert.equal((await api.send(FUNDING_STAMP_OPERATIONS_PATH, 'POST', DILUTE)).status, 202);
    assert.equal((await api.send(FUNDING_STAMP_OPERATIONS_PATH, 'POST', { ...DILUTE, newDepth: 23 })).status, 202);
    assert.equal(api.taken.length, 2);
  });

  const unfit: Array<[string, unknown, RegExp]> = [
    ['a dilution of three steps', { ...DILUTE, newDepth: 25 }, /newDepth/],
    ['a dilution of no step', { ...DILUTE, newDepth: 22 }, /newDepth/],
    ['a top-up of nothing', { ...TOP_UP, amountPerChunkPlur: '0' }, /amountPerChunkPlur/],
    ['a top-up of a fraction', { ...TOP_UP, amountPerChunkPlur: '1.5' }, /amountPerChunkPlur/],
    ['a kind there is none of', { ...TOP_UP, kind: 'buy' }, /kind/],
    ['a batch id that is not one', { ...TOP_UP, batchId: 'ab'.repeat(32) }, /batchId/],
    ['a request id that is no UUID', { ...TOP_UP, requestId: 'one' }, /requestId/],
  ];
  for (const [what, body, field] of unfit) {
    it(`refuse ${what}, 422 stamp_refused naming the field, before the service`, async (t) => {
      const api = await testApi(t);
      const answer = await api.send(FUNDING_STAMP_OPERATIONS_PATH, 'POST', body);
      assert.equal(answer.status, 422);
      assert.equal(answer.body?.error, 'stamp_refused');
      assert.match(String(answer.body?.message), field);
      assert.deepEqual(api.taken, []);
    });
  }

  it('answer the service’s refusals in the contract’s shape and status', async (t) => {
    const api = await testApi(t);
    const refusedAnswer = await api.send(FUNDING_STAMP_OPERATIONS_PATH, 'POST', {
      ...TOP_UP,
      nodeId: 'refused:bee-uploader',
    });
    assert.equal(refusedAnswer.status, 422);
    assert.deepEqual(refusedAnswer.body, {
      error: 'stamp_refused',
      message: 'The batch has expired, and nothing revives an expired batch.',
    });
    const silent = await api.send(FUNDING_STAMP_OPERATIONS_PATH, 'POST', { ...TOP_UP, nodeId: 'silent:bee-uploader' });
    assert.equal(silent.status, 502);
    assert.equal(silent.body?.error, 'node_unreachable');
  });

  it('answer an operation’s state, uncached, and 404 for a path that names no request id', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(fundingStampOperationPath(REQUEST));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {
      requestId: REQUEST,
      kind: 'dilute',
      state: 'unknown',
      txHash: null,
      error: 'The node’s answer was lost.',
    });
    assert.equal(answer.cache, 'no-store');
    assert.equal((await api.send(`${FUNDING_STAMP_OPERATIONS_PATH}/not-a-uuid`)).status, 404);
  });

  it('read a request id in either case', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(`${FUNDING_STAMP_OPERATIONS_PATH}/${REQUEST.toUpperCase()}`);
    assert.equal(answer.body?.requestId, REQUEST);
  });

  it('sit behind the funding API’s gate: no bearer, no operation', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_STAMP_OPERATIONS_PATH, 'POST', TOP_UP, null);
    assert.equal(answer.status, 401);
    assert.equal(answer.body?.error, 'unauthorized');
    assert.deepEqual(api.taken, []);
  });
});
