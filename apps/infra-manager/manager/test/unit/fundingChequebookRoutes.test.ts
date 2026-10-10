/**
 * The funding API's chequebook routes over HTTP: what each answers, and what a request that does not fit the contract
 * is answered with, behind the same gate as the rest of the funding API.
 *
 * Unit test, no database, no chain and no Bee node: the real routers with a fake service. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import {
  ADMIN_FUNDING_PATH,
  FUNDING_CHEQUEBOOK_OPERATIONS_PATH,
  type FundingChequebookOperationRequest,
  fundingChequebookOperationPath,
  fundingChequebookOperationStatusSchema,
} from '@streaming-monorepo/contracts';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createAdminFundingRouter } from '../../src/api/routes/adminFunding.js';
import { createFundingChequebookRouter } from '../../src/api/routes/fundingChequebooks.js';
import { ChequebookJournalError } from '../../src/domain/errors/ChequebookJournalError.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';

const TOKEN = 't'.repeat(40);
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
/** The request id the fake service answers as a move whose block is mined and not final yet. */
const MINED_REQUEST = '8e2f3a4b-5c6d-4e7f-8a1b-c2d3e4f5a6b7';
const HASH = `0x${'9a'.repeat(32)}`;

const DEPOSIT: FundingChequebookOperationRequest = {
  requestId: REQUEST,
  nodeId: '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b:bee-uploader',
  direction: 'deposit',
  amountPlur: '500000000000000',
};

async function testApi(t: TestContext, token: string | null = TOKEN) {
  const taken: FundingChequebookOperationRequest[] = [];
  const service = {
    operate: async (request: FundingChequebookOperationRequest) => {
      taken.push(request);
      if (request.nodeId.startsWith('refused')) {
        throw new FundingApiError(
          'chequebook_refused',
          'This manager moves only the chequebook of a stage’s Bee node or a rung.',
        );
      }
      if (request.nodeId.startsWith('busy')) {
        throw new FundingApiError('conflict', 'Another chequebook move on this node is still under way.');
      }
      if (request.nodeId.startsWith('nobody')) {
        throw new FundingApiError('unknown_node', 'No node of this manager has this id.');
      }
      if (request.nodeId.startsWith('journal')) throw new ChequebookJournalError();
      return { requestId: request.requestId, direction: request.direction, state: 'submitted' as const, txHash: HASH };
    },
    status: async (requestId: string) =>
      requestId === MINED_REQUEST
        ? {
            requestId,
            direction: 'withdraw' as const,
            state: 'submitted' as const,
            txHash: HASH,
            error: null,
            mined: true,
          }
        : {
            requestId,
            direction: 'withdraw' as const,
            state: 'unknown' as const,
            txHash: null,
            error: 'The manager could not tell whether the node made the move.',
            mined: false,
          },
  };
  const app = express();
  app.use(ADMIN_FUNDING_PATH, createAdminFundingRouter(token, [createFundingChequebookRouter(service)]));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function send(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, bearer: string | null = TOKEN) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
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

describe('the funding API’s chequebook routes', () => {
  it('take a deposit with 202 and the service’s answer, the request parsed by the contract', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_CHEQUEBOOK_OPERATIONS_PATH, 'POST', {
      ...DEPOSIT,
      requestId: REQUEST.toUpperCase(),
      to: '0x1111111111111111111111111111111111111111',
    });
    assert.equal(answer.status, 202);
    assert.deepEqual(answer.body, { requestId: REQUEST, direction: 'deposit', state: 'submitted', txHash: HASH });
    assert.deepEqual(api.taken, [DEPOSIT], 'the request id in lower case, and no field the contract does not name');
  });

  it('take a withdrawal', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_CHEQUEBOOK_OPERATIONS_PATH, 'POST', { ...DEPOSIT, direction: 'withdraw' });
    assert.equal(answer.status, 202);
    assert.equal(answer.body?.direction, 'withdraw');
  });

  const unfit: Array<[string, unknown, RegExp]> = [
    ['a move of nothing', { ...DEPOSIT, amountPlur: '0' }, /amountPlur/],
    ['a move of a fraction', { ...DEPOSIT, amountPlur: '0.5' }, /amountPlur/],
    ['an amount of 31 digits', { ...DEPOSIT, amountPlur: '1'.repeat(31) }, /amountPlur/],
    ['a direction there is none of', { ...DEPOSIT, direction: 'cashout' }, /direction/],
    ['a node id that is not one', { ...DEPOSIT, nodeId: 'a/b' }, /nodeId/],
    ['a request id that is no UUID', { ...DEPOSIT, requestId: 'one' }, /requestId/],
    ['a body with no amount', { requestId: REQUEST, nodeId: DEPOSIT.nodeId, direction: 'deposit' }, /amountPlur/],
  ];
  for (const [what, body, field] of unfit) {
    it(`refuse ${what}, 422 chequebook_refused naming the field, before the service`, async (t) => {
      const api = await testApi(t);
      const answer = await api.send(FUNDING_CHEQUEBOOK_OPERATIONS_PATH, 'POST', body);
      assert.equal(answer.status, 422);
      assert.equal(answer.body?.error, 'chequebook_refused');
      assert.match(String(answer.body?.message), field);
      assert.deepEqual(api.taken, []);
    });
  }

  it('answer the service’s refusals in the contract’s shape and status', async (t) => {
    const api = await testApi(t);
    const cases: Array<[string, number, string]> = [
      ['refused:bee-uploader', 422, 'chequebook_refused'],
      ['busy:bee-uploader', 409, 'conflict'],
      ['nobody:bee-uploader', 404, 'unknown_node'],
    ];
    for (const [nodeId, status, error] of cases) {
      const answer = await api.send(FUNDING_CHEQUEBOOK_OPERATIONS_PATH, 'POST', { ...DEPOSIT, nodeId });
      assert.equal(answer.status, status, nodeId);
      assert.equal(answer.body?.error, error, nodeId);
      assert.equal(typeof answer.body?.message, 'string', nodeId);
    }
  });

  it('leave a journal failure to the manager’s own error answer, no contract code the admin could take as a refusal', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_CHEQUEBOOK_OPERATIONS_PATH, 'POST', {
      ...DEPOSIT,
      nodeId: 'journal:bee-uploader',
    });
    assert.equal(answer.status, 503);
    assert.equal(answer.body?.error, 'chequebook_journal_unavailable');
  });

  it('answer an operation’s state, uncached, and 404 for a path that names no request id', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(fundingChequebookOperationPath(REQUEST));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {
      requestId: REQUEST,
      direction: 'withdraw',
      state: 'unknown',
      txHash: null,
      error: 'The manager could not tell whether the node made the move.',
      mined: false,
    });
    assert.equal(answer.cache, 'no-store');
    assert.equal((await api.send(`${FUNDING_CHEQUEBOOK_OPERATIONS_PATH}/not-a-uuid`)).status, 404);
  });

  it('answer whether a submitted move is mined and waits for its block to be final, as the contract reads it', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(fundingChequebookOperationPath(MINED_REQUEST));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {
      requestId: MINED_REQUEST,
      direction: 'withdraw',
      state: 'submitted',
      txHash: HASH,
      error: null,
      mined: true,
    });
    assert.equal(fundingChequebookOperationStatusSchema.parse(answer.body).mined, true);
  });

  it('read a request id in either case', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(`${FUNDING_CHEQUEBOOK_OPERATIONS_PATH}/${REQUEST.toUpperCase()}`);
    assert.equal(answer.body?.requestId, REQUEST);
  });

  it('sit behind the funding API’s gate: no bearer, no operation and no state', async (t) => {
    const api = await testApi(t);
    const post = await api.send(FUNDING_CHEQUEBOOK_OPERATIONS_PATH, 'POST', DEPOSIT, null);
    assert.equal(post.status, 401);
    assert.equal(post.body?.error, 'unauthorized');
    const get = await api.send(fundingChequebookOperationPath(REQUEST), 'GET', undefined, 'w'.repeat(40));
    assert.equal(get.status, 401);
    assert.deepEqual(api.taken, []);
  });

  it('answer 404 funding_off when the manager has no funding token, whatever is presented', async (t) => {
    const api = await testApi(t, null);
    const answer = await api.send(FUNDING_CHEQUEBOOK_OPERATIONS_PATH, 'POST', DEPOSIT);
    assert.equal(answer.status, 404);
    assert.equal(answer.body?.error, 'funding_off');
    assert.deepEqual(api.taken, []);
  });
});
