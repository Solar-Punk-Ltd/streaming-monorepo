/**
 * The funding API's chain routes over HTTP: what each answers, and what a request that does not fit the contract is
 * answered with, behind the same gate as the inventory.
 *
 * Unit test, no database and no chain: the real routers with a fake service. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import {
  ADMIN_FUNDING_PATH,
  FUNDING_TRANSFERS_PATH,
  type FundingTransferRequest,
  fundingAccountPath,
  fundingTransferPath,
} from '@streaming-monorepo/contracts';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createAdminFundingRouter } from '../../src/api/routes/adminFunding.js';
import { createFundingChainRouter } from '../../src/api/routes/fundingChain.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';

const TOKEN = 't'.repeat(40);
const ADDRESS = '0x2222222222222222222222222222222222222222';
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const HASH = `0x${'ab'.repeat(32)}`;

const BODY: FundingTransferRequest = {
  requestId: REQUEST,
  nodeId: '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b:bee-uploader',
  kind: 'xdai',
  to: '0x1111111111111111111111111111111111111111',
  amount: '100000000000000000',
  rawTransaction: `0x02f8${'0a'.repeat(100)}`,
};

async function testApi(t: TestContext) {
  const taken: unknown[] = [];
  const service = {
    account: async (address: string) => ({
      address,
      chainId: 100,
      xdaiWei: '1',
      xbzzPlur: '2',
      nonce: 3,
      maxFeePerGasWei: '4',
      maxPriorityFeePerGasWei: '5',
      gasNative: '21000',
      gasBzzTransfer: '65000',
    }),
    transfer: async (request: FundingTransferRequest) => {
      taken.push(request);
      if (request.nodeId.startsWith('nobody'))
        throw new FundingApiError('unknown_node', 'No node of this manager has this id.');
      return { requestId: request.requestId, state: 'submitted' as const, txHash: HASH };
    },
    status: async (requestId: string) => ({
      requestId,
      state: 'confirmed' as const,
      txHash: HASH,
      blockNumber: 1,
      error: null,
    }),
  };
  const app = express();
  app.use(ADMIN_FUNDING_PATH, createAdminFundingRouter(TOKEN, [createFundingChainRouter(service)]));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function send(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
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

describe('the funding API’s chain routes', () => {
  it('answer an account, uncached, by an address in either case', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(
      fundingAccountPath(ADDRESS).replace(ADDRESS, ADDRESS.toUpperCase().replace('0X', '0x')),
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.body?.address, ADDRESS);
    assert.equal(answer.cache, 'no-store');
  });

  it('answer 404 for an account path that names no address', async (t) => {
    const api = await testApi(t);
    assert.equal((await api.send(`${ADMIN_FUNDING_PATH}/accounts/not-an-address`)).status, 404);
  });

  it('take a transfer with 202 and the service’s answer, the request parsed by the contract', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_TRANSFERS_PATH, 'POST', {
      ...BODY,
      requestId: REQUEST.toUpperCase(),
      extra: 'dropped',
    });
    assert.equal(answer.status, 202);
    assert.deepEqual(answer.body, { requestId: REQUEST, state: 'submitted', txHash: HASH });
    assert.deepEqual(api.taken, [BODY]);
  });

  it('refuse a transfer body the contract does not take, 422 bad_transaction naming the field, before the service', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_TRANSFERS_PATH, 'POST', { ...BODY, amount: '0' });
    assert.equal(answer.status, 422);
    assert.equal(answer.body?.error, 'bad_transaction');
    assert.match(String(answer.body?.message), /amount/);
    assert.deepEqual(api.taken, []);
  });

  it('answer the service’s refusal in the contract’s shape', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_TRANSFERS_PATH, 'POST', { ...BODY, nodeId: 'nobody:bee-uploader' });
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.body, { error: 'unknown_node', message: 'No node of this manager has this id.' });
  });

  it('answer a transfer’s state, uncached, and 404 for a path that names no request id', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(fundingTransferPath(REQUEST));
    assert.equal(answer.status, 200);
    assert.equal(answer.body?.state, 'confirmed');
    assert.equal(answer.cache, 'no-store');
    assert.equal((await api.send(`${FUNDING_TRANSFERS_PATH}/not-a-uuid`)).status, 404);
  });
});

describe('FUNDING_RPC_URL', () => {
  it('is null unset, so the funding API reads the chain through BEE_RPC_ENDPOINT', async () => {
    const { fundingRpcUrl } = await import('../../src/utils/config.js');
    assert.equal(fundingRpcUrl(undefined), null);
    assert.equal(fundingRpcUrl('  '), null);
    assert.equal(fundingRpcUrl(' https://rpc.example.org/some-key '), 'https://rpc.example.org/some-key');
  });

  it('stops the manager at startup on a value that is no endpoint, naming itself and never the value', async () => {
    const { fundingRpcUrl } = await import('../../src/utils/config.js');
    for (const raw of ['not a url', 'ftp://rpc.example.org', 'https://user@rpc.example.org/secret-key']) {
      assert.throws(
        () => fundingRpcUrl(raw),
        (err: Error) => /FUNDING_RPC_URL/.test(err.message) && !err.message.includes('secret-key'),
        raw,
      );
    }
  });
});
