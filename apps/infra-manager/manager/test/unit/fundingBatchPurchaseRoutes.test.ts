/**
 * The funding API's batch purchase routes over HTTP: what each answers, the three calls under a purchase, the
 * archive-only routes of an older admin, and what a request that does not fit the contract is answered with, behind
 * the same gate as the rest of the funding API.
 *
 * Unit test, no database, no chain and no Bee node: the real routers with a fake service. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import {
  ADMIN_FUNDING_PATH,
  FUNDING_BATCH_PURCHASES_PATH,
  FUNDING_STAMP_PURCHASES_PATH,
  type FundingBatchPurchaseRequest,
  type FundingBatchPurchaseStatus,
  type FundingStampPurchaseRequest,
  fundingBatchPurchaseCheckPath,
  fundingBatchPurchasePath,
  fundingBatchPurchaseReleasePath,
  fundingBatchPurchaseRestartPath,
  fundingStampPurchasePath,
} from '@streaming-monorepo/contracts';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createAdminFundingRouter } from '../../src/api/routes/adminFunding.js';
import { createFundingBatchPurchaseRouter } from '../../src/api/routes/fundingBatchPurchases.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';

const TOKEN = 't'.repeat(40);
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const STAGE = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const BATCH = `0x${'c5'.repeat(32)}`;
const REPLACED = `0x${'d6'.repeat(32)}`;
const HASH = `0x${'9a'.repeat(32)}`;
const RUNG_NODE = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d:bee-uploader';
const CATALOGUE_NODE = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf:bee-uploader';

const RUNG: FundingBatchPurchaseRequest = {
  requestId: REQUEST,
  purpose: 'rung',
  nodeId: RUNG_NODE,
  depth: 20,
  amountPerChunkPlur: '12441600000',
  immutable: false,
  label: null,
  replacesBatchId: REPLACED,
};

const ARCHIVE: FundingStampPurchaseRequest = {
  requestId: REQUEST,
  nodeId: CATALOGUE_NODE,
  depth: 20,
  amountPerChunkPlur: '12441600000',
  label: 'Autumn event',
};

function statusOf(requestId: string, over: Partial<FundingBatchPurchaseStatus> = {}): FundingBatchPurchaseStatus {
  return {
    requestId,
    purpose: 'rung',
    nodeId: RUNG_NODE,
    state: 'confirmed',
    batchId: BATCH,
    txHash: HASH,
    usable: true,
    step: 'set',
    error: null,
    stages: [{ stageId: STAGE, name: 'stage-abr', apply: 'waiting_live', message: null }],
    catalogue: null,
    ...over,
  };
}

async function testApi(t: TestContext) {
  const taken: FundingBatchPurchaseRequest[] = [];
  const archived: FundingStampPurchaseRequest[] = [];
  const calls: string[] = [];
  const service = {
    purchase: async (request: FundingBatchPurchaseRequest) => {
      taken.push(request);
      if (request.nodeId.startsWith('refused')) {
        throw new FundingApiError('stamp_refused', 'The batch set here now is another than the one named.');
      }
      if (request.nodeId.startsWith('busy')) throw new FundingApiError('conflict', 'Another batch purchase.');
      if (request.nodeId.startsWith('silent')) {
        throw new FundingApiError(
          'node_unreachable',
          'The node’s Bee API could not be reached, so it was asked nothing.',
        );
      }
      return {
        requestId: request.requestId,
        purpose: request.purpose,
        state: 'confirmed' as const,
        batchId: BATCH,
        txHash: HASH,
      };
    },
    status: async (requestId: string) => {
      calls.push(`status ${requestId}`);
      return statusOf(requestId);
    },
    restart: async (requestId: string, stageId: string) => {
      calls.push(`restart ${requestId} ${stageId}`);
      if (stageId !== STAGE) throw new FundingApiError('stamp_refused', 'This purchase follows no stage with this id.');
      return statusOf(requestId, { stages: [{ stageId, name: 'stage-abr', apply: 'applying', message: null }] });
    },
    check: async (requestId: string) => {
      calls.push(`check ${requestId}`);
      return statusOf(requestId, { step: 'waiting_usable' });
    },
    release: async (requestId: string) => {
      calls.push(`release ${requestId}`);
      return statusOf(requestId, {
        purpose: 'catalogue',
        nodeId: CATALOGUE_NODE,
        step: 'done',
        stages: [],
        catalogue: { previousBatchId: REPLACED, released: true },
      });
    },
    purchaseArchive: async (request: FundingStampPurchaseRequest) => {
      archived.push(request);
      return { requestId: request.requestId, state: 'confirmed' as const, batchId: BATCH, txHash: HASH };
    },
    archiveStatus: async (requestId: string) => ({
      requestId,
      state: 'confirmed' as const,
      batchId: BATCH,
      txHash: HASH,
      usable: false,
      error: null,
    }),
  };
  const app = express();
  app.use(ADMIN_FUNDING_PATH, createAdminFundingRouter(TOKEN, [createFundingBatchPurchaseRouter(service)]));
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
  return { send, taken, archived, calls };
}

describe('the funding API’s batch purchase route', () => {
  it('takes a purchase with 202 and the service’s answer, the request parsed by the contract', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_BATCH_PURCHASES_PATH, 'POST', {
      ...RUNG,
      requestId: REQUEST.toUpperCase(),
      replacesBatchId: REPLACED.toUpperCase().replace('0X', '0x'),
      label: '  Spring  ',
    });
    assert.equal(answer.status, 202);
    assert.deepEqual(answer.body, {
      requestId: REQUEST,
      purpose: 'rung',
      state: 'confirmed',
      batchId: BATCH,
      txHash: HASH,
    });
    assert.deepEqual(api.taken, [{ ...RUNG, label: 'Spring' }], 'the ids in lower case and the label trimmed');
  });

  it('takes each purpose within its own depths and kind', async (t) => {
    const api = await testApi(t);
    const bodies = [
      { ...RUNG, depth: 17 },
      { ...RUNG, depth: 40, immutable: true },
      { ...RUNG, purpose: 'catalogue', nodeId: CATALOGUE_NODE, depth: 18, immutable: true },
      { ...RUNG, purpose: 'archive', nodeId: CATALOGUE_NODE, depth: 41, immutable: true, replacesBatchId: null },
      { ...RUNG, replacesBatchId: null },
    ];
    for (const body of bodies) {
      const answer = await api.send(FUNDING_BATCH_PURCHASES_PATH, 'POST', body);
      assert.equal(answer.status, 202, JSON.stringify(body));
    }
    assert.equal(api.taken.length, bodies.length);
  });

  const unfit: Array<[string, unknown, RegExp]> = [
    ['a purpose the contract does not name', { ...RUNG, purpose: 'gateway' }, /purpose/],
    ['a rung’s depth under 17', { ...RUNG, depth: 16 }, /depth/],
    ['a rung’s depth over 40', { ...RUNG, depth: 41 }, /depth/],
    ['a catalogue batch under 18', { ...RUNG, purpose: 'catalogue', depth: 17, immutable: true }, /depth/],
    ['a mutable catalogue batch', { ...RUNG, purpose: 'catalogue', immutable: false }, /immutable/],
    ['a mutable archive stamp', { ...RUNG, purpose: 'archive', replacesBatchId: null }, /immutable/],
    [
      'an archive stamp that replaces a batch',
      { ...RUNG, purpose: 'archive', immutable: true, replacesBatchId: REPLACED },
      /replacesBatchId/,
    ],
    ['a replaced batch that is no batch id', { ...RUNG, replacesBatchId: 'd6' }, /replacesBatchId/],
    ['a replaced batch left out', { ...RUNG, replacesBatchId: undefined }, /replacesBatchId/],
    ['an amount of nothing', { ...RUNG, amountPerChunkPlur: '0' }, /amountPerChunkPlur/],
    ['a node id with a slash', { ...RUNG, nodeId: 'rung/../x' }, /nodeId/],
    ['a request id that is no UUID', { ...RUNG, requestId: 'one' }, /requestId/],
  ];
  for (const [what, body, field] of unfit) {
    it(`refuses ${what}, 422 stamp_refused naming the field, before the service`, async (t) => {
      const api = await testApi(t);
      const answer = await api.send(FUNDING_BATCH_PURCHASES_PATH, 'POST', body);
      assert.equal(answer.status, 422);
      assert.equal(answer.body?.error, 'stamp_refused');
      assert.match(String(answer.body?.message), field);
      assert.deepEqual(api.taken, []);
    });
  }

  it('answers the service’s refusals in the contract’s shape and status', async (t) => {
    const api = await testApi(t);
    const refused = await api.send(FUNDING_BATCH_PURCHASES_PATH, 'POST', { ...RUNG, nodeId: 'refused:bee-uploader' });
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body, {
      error: 'stamp_refused',
      message: 'The batch set here now is another than the one named.',
    });
    const busy = await api.send(FUNDING_BATCH_PURCHASES_PATH, 'POST', { ...RUNG, nodeId: 'busy:bee-uploader' });
    assert.equal(busy.status, 409);
    assert.equal(busy.body?.error, 'conflict');
    const silent = await api.send(FUNDING_BATCH_PURCHASES_PATH, 'POST', { ...RUNG, nodeId: 'silent:bee-uploader' });
    assert.equal(silent.status, 502);
    assert.equal(silent.body?.error, 'node_unreachable');
  });

  it('answers a purchase’s status, uncached, by its request id in either case', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(fundingBatchPurchasePath(REQUEST));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, statusOf(REQUEST));
    assert.equal(answer.cache, 'no-store');
    assert.equal((await api.send(`${FUNDING_BATCH_PURCHASES_PATH}/${REQUEST.toUpperCase()}`)).body?.requestId, REQUEST);
    assert.equal((await api.send(`${FUNDING_BATCH_PURCHASES_PATH}/not-a-uuid`)).status, 404);
  });

  it('sits behind the funding API’s gate: no bearer, no purchase', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_BATCH_PURCHASES_PATH, 'POST', RUNG, null);
    assert.equal(answer.status, 401);
    assert.equal(answer.body?.error, 'unauthorized');
    assert.deepEqual(api.taken, []);
  });
});

describe('the three calls under a batch purchase', () => {
  it('restarts a stage named by its id, and answers the status', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(fundingBatchPurchaseRestartPath(REQUEST), 'POST', { stageId: STAGE.toUpperCase() });
    assert.equal(answer.status, 200);
    assert.equal(answer.cache, 'no-store');
    assert.deepEqual(answer.body?.stages, [{ stageId: STAGE, name: 'stage-abr', apply: 'applying', message: null }]);
    assert.deepEqual(api.calls, [`restart ${REQUEST} ${STAGE}`]);
  });

  it('refuses a restart with no stage id, or one that is no UUID, before the service', async (t) => {
    const api = await testApi(t);
    for (const body of [{}, { stageId: 'stage-abr' }]) {
      const answer = await api.send(fundingBatchPurchaseRestartPath(REQUEST), 'POST', body);
      assert.equal(answer.status, 422, JSON.stringify(body));
      assert.match(String(answer.body?.message), /stageId/);
    }
    assert.deepEqual(api.calls, []);
  });

  it('answers a restart the service refuses as stamp_refused', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(fundingBatchPurchaseRestartPath(REQUEST), 'POST', {
      stageId: '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c',
    });
    assert.equal(answer.status, 422);
    assert.equal(answer.body?.error, 'stamp_refused');
  });

  it('checks a purchase again and releases a catalogue purchase’s previous batch, each with no body', async (t) => {
    const api = await testApi(t);
    const checked = await api.send(fundingBatchPurchaseCheckPath(REQUEST), 'POST');
    assert.equal(checked.status, 200);
    assert.equal(checked.body?.step, 'waiting_usable');
    const released = await api.send(fundingBatchPurchaseReleasePath(REQUEST), 'POST');
    assert.equal(released.status, 200);
    assert.deepEqual(released.body?.catalogue, { previousBatchId: REPLACED, released: true });
    assert.deepEqual(api.calls, [`check ${REQUEST}`, `release ${REQUEST}`]);
  });

  it('answers 404 for a call under a path that names no request id, and never reaches the service', async (t) => {
    const api = await testApi(t);
    for (const call of ['restart', 'check', 'release']) {
      assert.equal((await api.send(`${FUNDING_BATCH_PURCHASES_PATH}/one/${call}`, 'POST', {})).status, 404, call);
    }
    assert.deepEqual(api.calls, []);
  });
});

describe('the archive-only routes of an older admin', () => {
  it('take an archive stamp’s purchase with 202, in their own shape', async (t) => {
    const api = await testApi(t);
    const answer = await api.send(FUNDING_STAMP_PURCHASES_PATH, 'POST', {
      ...ARCHIVE,
      requestId: REQUEST.toUpperCase(),
      label: '  Autumn event ',
      immutable: false,
    });
    assert.equal(answer.status, 202);
    assert.deepEqual(answer.body, { requestId: REQUEST, state: 'confirmed', batchId: BATCH, txHash: HASH });
    assert.deepEqual(api.archived, [ARCHIVE], 'the label trimmed, and no word on mutability taken');
    assert.deepEqual(api.taken, [], 'the older route is answered by its own call');
  });

  it('refuse a depth outside the capacity table, 422 stamp_refused naming the field', async (t) => {
    const api = await testApi(t);
    for (const depth of [16, 42]) {
      const answer = await api.send(FUNDING_STAMP_PURCHASES_PATH, 'POST', { ...ARCHIVE, depth });
      assert.equal(answer.status, 422);
      assert.match(String(answer.body?.message), /depth/);
    }
    assert.deepEqual(api.archived, []);
  });

  it('answer a purchase’s state in their own shape, uncached, and 404 for a path that names no request id', async (t) => {
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
});
