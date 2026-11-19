/**
 * The funding API's stamp purchase routes over HTTP: what each answers, and what a request that does not fit the
 * contract is answered with, behind the same gate as the rest of the funding API.
 *
 * Unit test, no database, no chain and no Bee node: the real routers with a fake service. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import {
  ADMIN_FUNDING_PATH,
  FUNDING_STAMP_PURCHASES_PATH,
  type FundingStampPurchaseRequest,
  fundingStampPurchasePath,
} from '@streaming-monorepo/contracts';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createAdminFundingRouter } from '../../src/api/routes/adminFunding.js';
import { createFundingStampPurchaseRouter } from '../../src/api/routes/fundingBatchPurchases.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';

const TOKEN = 't'.repeat(40);
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const BATCH = `0x${'c5'.repeat(32)}`;
const HASH = `0x${'9a'.repeat(32)}`;

const PURCHASE: FundingStampPurchaseRequest = {
  requestId: REQUEST,
  nodeId: '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf:bee-uploader',
  depth: 20,
  amountPerChunkPlur: '12441600000',
  label: 'Autumn event',
};

async function testApi(t: TestContext) {
  const taken: FundingStampPurchaseRequest[] = [];
  const service = {
    purchase: async (request: FundingStampPurchaseRequest) => {
      taken.push(request);
      if (request.nodeId.startsWith('refused')) {
        throw new FundingApiError(
          'stamp_refused',
          'An archive stamp is bought on the catalogue node alone, and this node is not the catalogue node.',
        );
      }
      if (request.nodeId.startsWith('silent')) {
        throw new FundingApiError(
          'node_unreachable',
          'The node’s Bee API could not be reached, so it was asked nothing.',
        );
      }
      return { requestId: request.requestId, state: 'confirmed' as const, batchId: BATCH, txHash: HASH };
    },
    status: async (requestId: string) => ({
      requestId,
      state: 'confirmed' as const,
      batchId: BATCH,
      txHash: HASH,
      usable: false,
      error: null,
    }),
  };
  const app = express();
  app.use(ADMIN_FUNDING_PATH, createAdminFundingRouter(TOKEN, [createFundingStampPurchaseRouter(service)]));
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

describe('the funding API’s stamp purchase routes', () => {
  it('take a purchase with 202 and the service’s answer, the request parsed by the contract', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_STAMP_PURCHASES_PATH, 'POST', {
      ...PURCHASE,
      requestId: REQUEST.toUpperCase(),
      label: '  Autumn event ',
      immutable: false,
    });
    assert.equal(answer.status, 202);
    assert.deepEqual(answer.body, { requestId: REQUEST, state: 'confirmed', batchId: BATCH, txHash: HASH });
    assert.deepEqual(api.taken, [PURCHASE], 'the label trimmed, and no word on mutability taken');
  });

  it('take a purchase with no label', async (t) => {
    const api = await testApi(t);
    assert.equal((await api.send(FUNDING_STAMP_PURCHASES_PATH, 'POST', { ...PURCHASE, label: null })).status, 202);
    assert.equal(api.taken[0]?.label, null);
  });

  const unfit: Array<[string, unknown, RegExp]> = [
    ['a depth under the capacity table', { ...PURCHASE, depth: 16 }, /depth/],
    ['a depth over it', { ...PURCHASE, depth: 42 }, /depth/],
    ['an amount of nothing', { ...PURCHASE, amountPerChunkPlur: '0' }, /amountPerChunkPlur/],
    ['an amount of a fraction', { ...PURCHASE, amountPerChunkPlur: '1.5' }, /amountPerChunkPlur/],
    ['a label of nothing but spaces', { ...PURCHASE, label: '   ' }, /label/],
    ['a label left out', { ...PURCHASE, label: undefined }, /label/],
    ['a node id with a slash', { ...PURCHASE, nodeId: 'catalogue/../x' }, /nodeId/],
    ['a request id that is no UUID', { ...PURCHASE, requestId: 'one' }, /requestId/],
  ];
  for (const [what, body, field] of unfit) {
    it(`refuse ${what}, 422 stamp_refused naming the field, before the service`, async (t) => {
      const api = await testApi(t);
      const answer = await api.send(FUNDING_STAMP_PURCHASES_PATH, 'POST', body);
      assert.equal(answer.status, 422);
      assert.equal(answer.body?.error, 'stamp_refused');
      assert.match(String(answer.body?.message), field);
      assert.deepEqual(api.taken, []);
    });
  }

  it('answer the service’s refusals in the contract’s shape and status', async (t) => {
    const api = await testApi(t);
    const refused = await api.send(FUNDING_STAMP_PURCHASES_PATH, 'POST', {
      ...PURCHASE,
      nodeId: 'refused:bee-uploader',
    });
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body, {
      error: 'stamp_refused',
      message: 'An archive stamp is bought on the catalogue node alone, and this node is not the catalogue node.',
    });
    const silent = await api.send(FUNDING_STAMP_PURCHASES_PATH, 'POST', { ...PURCHASE, nodeId: 'silent:bee-uploader' });
    assert.equal(silent.status, 502);
    assert.equal(silent.body?.error, 'node_unreachable');
  });

  it('answer a purchase’s state, uncached, and 404 for a path that names no request id', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(fundingStampPurchasePath(REQUEST));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {
      requestId: REQUEST,
      state: 'confirmed',
      batchId: BATCH,
      txHash: HASH,
      usable: false,
      error: null,
    });
    assert.equal(answer.cache, 'no-store');
    assert.equal((await api.send(`${FUNDING_STAMP_PURCHASES_PATH}/not-a-uuid`)).status, 404);
  });

  it('read a request id in either case', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(`${FUNDING_STAMP_PURCHASES_PATH}/${REQUEST.toUpperCase()}`);
    assert.equal(answer.body?.requestId, REQUEST);
  });

  it('sit behind the funding API’s gate: no bearer, no purchase', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_STAMP_PURCHASES_PATH, 'POST', PURCHASE, null);
    assert.equal(answer.status, 401);
    assert.equal(answer.body?.error, 'unauthorized');
    assert.deepEqual(api.taken, []);
  });
});
