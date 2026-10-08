/**
 * The client of the manager's funding API (`packages/contracts/src/funding.ts`), through which the funding services
 * read the nodes and the brand wallet's account, relay the transfers the admin signs and ask for stamp operations.
 * Unit test, with a fetch that answers from the test, so nothing leaves the process. `pnpm test`.
 *
 * What is pinned here: each route is asked as the contract names it, with the token as a bearer, no redirect followed
 * and a deadline, a stamp operation under a longer one of its own; each answer is what the contract's schema makes of
 * it; and every way a call can fail is one typed error, the manager's refusals with its code and status, with the
 * token in no error and no log line.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

import {
  FUNDING_ERROR_CODES,
  FUNDING_ERROR_STATUS,
  type FundingErrorCode,
  type FundingStampOperationRequest,
  type FundingTransferRequest,
} from '@streaming-monorepo/contracts';

import {
  MANAGER_FUNDING_FAILURES,
  MANAGER_FUNDING_STAMP_TIMEOUT_MS,
  MANAGER_FUNDING_TIMEOUT_MS,
  ManagerFundingClient,
  type ManagerFundingClientOptions,
  ManagerFundingError,
} from '../../src/domain/funding/ManagerFundingClient.js';

const BASE = 'https://manager.example.org';
const TOKEN = 'funding-client-test-token-of-more-than-thirty-two-characters';
const STAGE_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const REQUEST_ID = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const NODE_WALLET = '0x1111111111111111111111111111111111111111';
const BRAND_WALLET = '0x2222222222222222222222222222222222222222';
const BZZ_TOKEN = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const TX_HASH = `0x${'ab'.repeat(32)}`;

const shout = (address: string) => `0x${address.slice(2).toUpperCase()}`;

const node = () => ({
  nodeId: `${STAGE_ID}:bee-uploader`,
  label: 'main stage 360p',
  role: 'uploader',
  walletAddress: NODE_WALLET,
  xdaiWei: '250000000000000000',
  xbzzPlur: '10000000000000000',
  readError: null,
});

const inventory = () => ({
  observedAt: '2026-10-05T10:00:00.000Z',
  chain: { chainId: 100, bzzToken: BZZ_TOKEN },
  stages: [{ stageId: STAGE_ID, name: 'main stage', nodes: [node()] }],
  catalogue: null,
});

const account = () => ({
  address: BRAND_WALLET,
  chainId: 100,
  xdaiWei: '1000000000000000000',
  xbzzPlur: '500000000000000000',
  nonce: 7,
  maxFeePerGasWei: '2000000000',
  maxPriorityFeePerGasWei: '1000000000',
  gasNative: '21000',
  gasBzzTransfer: '65000',
});

const transferRequest = (): FundingTransferRequest => ({
  requestId: REQUEST_ID,
  nodeId: `${STAGE_ID}:bee-uploader`,
  kind: 'xdai',
  to: NODE_WALLET,
  amount: '100000000000000000',
  rawTransaction: `0x02f8${'0a'.repeat(100)}`,
});

const transferStatus = () => ({
  requestId: REQUEST_ID,
  state: 'confirmed',
  txHash: TX_HASH,
  blockNumber: 41_000_000,
  error: null,
});

const BATCH_ID = `0x${'b1'.repeat(32)}`;

const topUpRequest = (): FundingStampOperationRequest => ({
  requestId: REQUEST_ID,
  kind: 'topup',
  nodeId: `${STAGE_ID}:bee-uploader`,
  batchId: BATCH_ID,
  expectedDepth: 20,
  amountPerChunkPlur: '12441600000',
});

const diluteRequest = (): FundingStampOperationRequest => ({
  requestId: REQUEST_ID,
  kind: 'dilute',
  nodeId: `${STAGE_ID}:bee-uploader`,
  batchId: BATCH_ID,
  expectedDepth: 20,
  newDepth: 22,
});

const stampStatus = () => ({
  requestId: REQUEST_ID,
  kind: 'topup',
  state: 'failed',
  txHash: null,
  error: 'The node refused the top-up: out of funds.',
});

/** An answer that comes `ms` after the request, or never once the request is aborted. */
const answersAfter =
  (ms: number, answer: () => Response): Answer =>
  ({ signal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(answer()), ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });

/** One request the client made, as the fetch saw it. */
interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
}

type Answer = (seen: Seen) => Response | Promise<Response>;

/** A client of `BASE` whose fetch answers with `answer`, and the requests it made. */
function clientOn(
  answer: Answer,
  options: Partial<ManagerFundingClientOptions> = {},
): { client: ManagerFundingClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
      redirect: init?.redirect,
      signal: init?.signal,
    };
    seen.push(request);
    return answer(request);
  };
  const client = new ManagerFundingClient({ url: BASE, token: TOKEN, fetch: fakeFetch as typeof fetch, ...options });
  return { client, seen };
}

/** A fetch that answers when the request is aborted, by rejecting with the reason, as fetch does. */
const neverAnswers: Answer = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** What `run` threw, which has to be a ManagerFundingError. */
async function failure(run: () => Promise<unknown>): Promise<ManagerFundingError> {
  const error = await run().then(
    () => assert.fail('the call answered'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof ManagerFundingError, String(error));
  return error;
}

describe('ManagerFundingClient: the requests', () => {
  it('asks each route the contract names, with the token as a bearer, following no redirect, under a deadline', async () => {
    const { client, seen } = clientOn(({ url }) => {
      if (url.endsWith('/inventory')) return Response.json(inventory());
      if (url.includes('/accounts/')) return Response.json(account());
      if (url.endsWith('/transfers'))
        return Response.json({ requestId: REQUEST_ID, state: 'submitted', txHash: null }, { status: 202 });
      return Response.json(transferStatus());
    });

    await client.inventory();
    await client.account(shout(BRAND_WALLET));
    await client.relay(transferRequest());
    await client.status(REQUEST_ID.toUpperCase());

    assert.deepEqual(
      seen.map(({ method, url }) => `${method} ${url}`),
      [
        `GET ${BASE}/api/admin-funding/inventory`,
        `GET ${BASE}/api/admin-funding/accounts/${BRAND_WALLET}`,
        `POST ${BASE}/api/admin-funding/transfers`,
        `GET ${BASE}/api/admin-funding/transfers/${REQUEST_ID}`,
      ],
    );
    for (const request of seen) {
      assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`, request.url);
      assert.equal(request.redirect, 'manual', request.url);
      assert.ok(request.signal instanceof AbortSignal, request.url);
    }
    assert.equal(seen[2]?.headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(seen[2]?.body ?? 'null'), transferRequest());
    assert.deepEqual(
      seen.filter((request) => request.method === 'GET').map((request) => request.body),
      [null, null, null],
    );
  });

  it('relays the contract fields of a transfer and nothing else the object carries', async () => {
    const { client, seen } = clientOn(() =>
      Response.json({ requestId: REQUEST_ID, state: 'submitted', txHash: null }, { status: 202 }),
    );

    await client.relay({ ...transferRequest(), password: 'the operator typed this' } as FundingTransferRequest);

    assert.deepEqual(Object.keys(JSON.parse(seen[0]?.body ?? '{}')).sort(), Object.keys(transferRequest()).sort());
  });

  it('adds the paths after an address that has a path of its own', async () => {
    const { client, seen } = clientOn(() => Response.json(inventory()), { url: 'https://example.org/manager/' });

    await client.inventory();

    assert.equal(seen[0]?.url, 'https://example.org/manager/api/admin-funding/inventory');
  });

  it('asks nothing for an account that is not an address, or a transfer that is not a UUID', async () => {
    const { client, seen } = clientOn(() => Response.json(account()));

    await assert.rejects(client.account('0x12'), /address/);
    await assert.rejects(client.status('../inventory'), /UUID/);

    assert.deepEqual(seen, []);
  });

  it('waits 10 seconds by default', () => {
    assert.equal(MANAGER_FUNDING_TIMEOUT_MS, 10_000);
  });
});

describe('ManagerFundingClient: the answers', () => {
  it("answers each route's answer as the contract's schema reads it", async () => {
    const answers = {
      inventory: {
        ...inventory(),
        chain: { chainId: 100, bzzToken: shout(BZZ_TOKEN) },
        stages: [
          { stageId: STAGE_ID, name: 'main stage', nodes: [{ ...node(), beeApiUrl: 'http://192.0.2.20:1633' }] },
        ],
      },
      account: { ...account(), address: shout(BRAND_WALLET) },
      relay: {
        requestId: REQUEST_ID.toUpperCase(),
        state: 'submitted',
        txHash: TX_HASH.toUpperCase().replace('0X', '0x'),
      },
      status: transferStatus(),
    };
    const { client } = clientOn(({ url, method }) => {
      if (url.endsWith('/inventory')) return Response.json(answers.inventory);
      if (url.includes('/accounts/')) return Response.json(answers.account);
      if (method === 'POST') return Response.json(answers.relay, { status: 202 });
      return Response.json(answers.status);
    });

    const read = {
      inventory: await client.inventory(),
      account: await client.account(BRAND_WALLET),
      relay: await client.relay(transferRequest()),
      status: await client.status(REQUEST_ID),
    };

    assert.equal(read.inventory.chain.bzzToken, BZZ_TOKEN, 'the address is kept in lower case');
    assert.equal(
      'beeApiUrl' in read.inventory.stages[0]!.nodes[0]!,
      false,
      'a field the contract does not name passed',
    );
    assert.equal(read.account.address, BRAND_WALLET);
    assert.equal(read.account.nonce, 7);
    assert.deepEqual(read.relay, { requestId: REQUEST_ID, state: 'submitted', txHash: TX_HASH });
    assert.deepEqual(read.status, transferStatus());
  });

  it('takes an answer with any success status, as a transfer sent again may answer 200', async () => {
    const { client } = clientOn(() => Response.json({ requestId: REQUEST_ID, state: 'confirmed', txHash: TX_HASH }));

    const answer = await client.relay(transferRequest());

    assert.equal(answer.state, 'confirmed');
  });
});

describe('ManagerFundingClient: stamp operations', () => {
  it('asks for an operation and for where it stands as the contract names the routes, with the token as a bearer', async () => {
    const { client, seen } = clientOn(({ method }) =>
      method === 'POST'
        ? Response.json({ requestId: REQUEST_ID, kind: 'topup', state: 'confirmed', txHash: TX_HASH }, { status: 202 })
        : Response.json(stampStatus()),
    );

    await client.stampOperation(topUpRequest());
    await client.stampOperationStatus(REQUEST_ID.toUpperCase());

    assert.deepEqual(
      seen.map(({ method, url }) => `${method} ${url}`),
      [
        `POST ${BASE}/api/admin-funding/stamp-operations`,
        `GET ${BASE}/api/admin-funding/stamp-operations/${REQUEST_ID}`,
      ],
    );
    for (const request of seen) {
      assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`, request.url);
      assert.equal(request.redirect, 'manual', request.url);
      assert.ok(request.signal instanceof AbortSignal, request.url);
    }
    assert.equal(seen[0]?.headers.get('content-type'), 'application/json');
    assert.equal(seen[1]?.body, null);
  });

  it("sends the contract's fields of each kind and nothing else the object carries", async () => {
    const { client, seen } = clientOn(() =>
      Response.json({ requestId: REQUEST_ID, kind: 'topup', state: 'submitted', txHash: null }, { status: 202 }),
    );

    // What a caller's object may carry beside the contract's fields: the other kind's field, and more.
    const topUpAndMore: Record<string, unknown> = { ...topUpRequest(), newDepth: 21, days: 30 };
    const diluteAndMore: Record<string, unknown> = {
      ...diluteRequest(),
      amountPerChunkPlur: '1',
      password: 'the operator typed this',
    };
    await client.stampOperation(topUpAndMore as FundingStampOperationRequest);
    await client.stampOperation(diluteAndMore as FundingStampOperationRequest);

    assert.deepEqual(JSON.parse(seen[0]?.body ?? 'null'), topUpRequest());
    assert.deepEqual(JSON.parse(seen[1]?.body ?? 'null'), diluteRequest());
  });

  it("answers the manager's answer and status as the contract's schemas read them", async () => {
    const { client } = clientOn(({ method }) =>
      method === 'POST'
        ? Response.json(
            {
              requestId: REQUEST_ID.toUpperCase(),
              kind: 'dilute',
              state: 'unknown',
              txHash: TX_HASH.toUpperCase().replace('0X', '0x'),
              batchApiUrl: 'http://192.0.2.20:1633',
            },
            { status: 202 },
          )
        : Response.json(stampStatus()),
    );

    const answer = await client.stampOperation(diluteRequest());
    const status = await client.stampOperationStatus(REQUEST_ID);

    assert.deepEqual(answer, { requestId: REQUEST_ID, kind: 'dilute', state: 'unknown', txHash: TX_HASH });
    assert.deepEqual(status, stampStatus());
  });

  it("carries the manager's refusals of an operation as its code, its status and its sentence", async () => {
    for (const code of ['stamp_refused', 'node_unreachable', 'unknown_node', 'conflict'] as const) {
      const status = FUNDING_ERROR_STATUS[code];
      const { client } = clientOn(() => Response.json({ error: code, message: `A sentence for ${code}.` }, { status }));

      const error = await failure(() => client.stampOperation(topUpRequest()));

      assert.deepEqual([error.code, error.status, error.message], [code, status, `A sentence for ${code}.`]);
    }
    const { client } = clientOn(() =>
      Response.json(
        { error: 'unknown_request', message: 'No stamp operation was journalled under this request id.' },
        { status: 404 },
      ),
    );
    const unknown = await failure(() => client.stampOperationStatus(REQUEST_ID));
    assert.deepEqual([unknown.code, unknown.status], ['unknown_request', 404]);
  });

  it("calls an answer that is not the route's bad_answer, a transfer's answer among them", async () => {
    const { client } = clientOn(() =>
      Response.json({ requestId: REQUEST_ID, state: 'submitted', txHash: null }, { status: 202 }),
    );

    const error = await failure(() => client.stampOperation(topUpRequest()));

    assert.deepEqual([error.code, error.status], ['bad_answer', 202]);
  });

  it('asks nothing for the status of what is not a UUID', async () => {
    const { client, seen } = clientOn(() => Response.json(stampStatus()));

    await assert.rejects(client.stampOperationStatus('../inventory'), /UUID/);

    assert.deepEqual(seen, []);
  });

  it('waits on an operation under its own deadline, 200 seconds by default, and on its status read under the usual one', async () => {
    assert.equal(MANAGER_FUNDING_STAMP_TIMEOUT_MS, 200_000);
    const slow = answersAfter(80, () =>
      Response.json({ requestId: REQUEST_ID, kind: 'topup', state: 'confirmed', txHash: TX_HASH }, { status: 202 }),
    );
    const { client } = clientOn(slow, { timeoutMs: 20, stampTimeoutMs: 1_000 });

    const answer = await client.stampOperation(topUpRequest());
    const statusRead = await failure(() => client.stampOperationStatus(REQUEST_ID));
    const inventoryRead = await failure(() => client.inventory());

    assert.equal(answer.state, 'confirmed');
    assert.equal(statusRead.code, 'timeout');
    assert.equal(inventoryRead.code, 'timeout');
  });

  it('calls an operation that outlasts its own deadline timeout, naming that deadline', async () => {
    const { client } = clientOn(neverAnswers, { stampTimeoutMs: 30 });

    const error = await failure(() => client.stampOperation(diluteRequest()));

    assert.deepEqual([error.code, error.status], ['timeout', null]);
    assert.match(error.message, /within 30 ms/);
  });
});

describe('ManagerFundingClient: the failures', () => {
  it("carries each of the manager's refusals as its code, its status and its sentence", async () => {
    for (const code of FUNDING_ERROR_CODES) {
      const status = FUNDING_ERROR_STATUS[code];
      const { client } = clientOn(() => Response.json({ error: code, message: `A sentence for ${code}.` }, { status }));

      const error = await failure(() => client.inventory());

      assert.deepEqual([error.code, error.status, error.message], [code, status, `A sentence for ${code}.`]);
    }
  });

  it('tells a status read for a request the manager never journalled, unknown_request, from a refused node', async () => {
    const answering = (code: FundingErrorCode, message: string) =>
      clientOn(() => Response.json({ error: code, message }, { status: FUNDING_ERROR_STATUS[code] })).client;

    const neverJournalled = await failure(() =>
      answering('unknown_request', 'The manager journalled no transfer under that request id.').status(REQUEST_ID),
    );
    const refusedNode = await failure(() =>
      answering('unknown_node', 'The node is not in the inventory.').relay(transferRequest()),
    );

    assert.deepEqual(
      [neverJournalled.code, neverJournalled.status, neverJournalled.message],
      ['unknown_request', 404, 'The manager journalled no transfer under that request id.'],
    );
    assert.deepEqual([refusedNode.code, refusedNode.status], ['unknown_node', 404]);
  });

  it('keeps the status the manager answered with, as for a body it could not read', async () => {
    const { client } = clientOn(() =>
      Response.json({ error: 'bad_transaction', message: 'The request body is not JSON.' }, { status: 400 }),
    );

    const error = await failure(() => client.relay(transferRequest()));

    assert.deepEqual([error.code, error.status], ['bad_transaction', 400]);
  });

  it('calls an answer that is not JSON not_json, with its status', async () => {
    for (const [status, body] of [
      [200, 'not json'],
      [502, '<html>Bad gateway</html>'],
      [200, ''],
    ] as const) {
      const { client } = clientOn(() => new Response(body, { status }));

      const error = await failure(() => client.inventory());

      assert.deepEqual([error.code, error.status], ['not_json', status], body);
    }
  });

  it('calls a body that is not UTF-8 not_json', async () => {
    const { client } = clientOn(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d])));

    const error = await failure(() => client.inventory());

    assert.equal(error.code, 'not_json');
  });

  it("calls JSON that is not the route's answer, or an error without the contract's code, bad_answer", async () => {
    for (const [what, status, body] of [
      ['an answer without its chain', 200, { ...inventory(), chain: undefined }],
      ['an address that is no address', 200, { ...inventory(), chain: { chainId: 100, bzzToken: '0x12' } }],
      ['an array', 200, []],
      ['the error of an older manager, with no funding API', 404, { error: 'not_found' }],
      ['an error with a code the contract does not have', 500, { error: 'internal', message: 'Something broke.' }],
    ] as const) {
      const { client } = clientOn(() => Response.json(body, { status }));

      const error = await failure(() => client.inventory());

      assert.deepEqual([error.code, error.status], ['bad_answer', status], what);
    }
  });

  it('follows no redirect: it is bad_answer, and the token goes nowhere else', async () => {
    const { client, seen } = clientOn(
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org/' } }),
    );

    const error = await failure(() => client.inventory());

    assert.deepEqual([error.code, error.status], ['bad_answer', 302]);
    assert.match(error.message, /redirect/);
    assert.equal(seen.length, 1);
  });

  it('calls an answer over the size limit bad_answer, whether its length says so or not', async () => {
    const big = JSON.stringify({ ...inventory(), padding: 'x'.repeat(200) });
    for (const [what, answer] of [
      ['with its length', () => new Response(big, { headers: { 'content-length': String(big.length) } })],
      ['in a stream', () => new Response(new Blob([big]).stream())],
    ] as const) {
      const { client } = clientOn(answer, { maxAnswerBytes: 64 });

      const error = await failure(() => client.inventory());

      assert.equal(error.code, 'bad_answer', what);
      assert.match(error.message, /64 bytes/, what);
    }
  });

  it('calls a manager that cannot be reached unreachable, with no status', async () => {
    const cause = new TypeError('fetch failed');
    const { client } = clientOn(() => Promise.reject(cause));

    const error = await failure(() => client.inventory());

    assert.deepEqual([error.code, error.status], ['unreachable', null]);
    assert.equal(error.cause, cause);
  });

  it('calls one that does not answer before the deadline timeout, with no status', async () => {
    const { client } = clientOn(neverAnswers, { timeoutMs: 20 });

    const error = await failure(() => client.relay(transferRequest()));

    assert.deepEqual([error.code, error.status], ['timeout', null]);
  });

  it('calls an answer whose body stops arriving before the deadline timeout', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"observedAt":'));
      },
    });
    const { client } = clientOn(() => new Response(stalled), { timeoutMs: 20 });

    const error = await failure(() => client.inventory());

    assert.equal(error.code, 'timeout');
  });

  it('names its own failures, beside the contract codes', () => {
    assert.deepEqual(MANAGER_FUNDING_FAILURES, ['unreachable', 'timeout', 'not_json', 'bad_answer']);
  });
});

describe('ManagerFundingClient: the token', () => {
  it('reaches no error, no log line and no view of the client, whatever the call came to', async () => {
    const lines: string[] = [];
    const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const methods = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      mock.method(console, name, keep),
    );
    const errors: unknown[] = [];
    const answers: Answer[] = [
      () => Response.json(inventory()),
      () =>
        Response.json(
          { error: 'unauthorized', message: 'The funding API takes its bearer token and no session.' },
          { status: 401 },
        ),
      () => new Response('not json'),
      () => Response.json({ error: 'internal' }, { status: 500 }),
      () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.org/' } }),
      () => Promise.reject(new TypeError('fetch failed')),
      neverAnswers,
    ];
    let client: ManagerFundingClient | undefined;
    try {
      for (const answer of answers) {
        client = clientOn(answer, { timeoutMs: 20 }).client;
        await client.inventory().catch((error: unknown) => errors.push(error));
      }
    } finally {
      for (const method of methods) method.mock.restore();
    }

    assert.equal(errors.length, answers.length - 1);
    assert.equal(lines.join('\n').includes(TOKEN), false, 'a log line holds the token');
    for (const error of errors) {
      assert.equal(inspect(error, { depth: Infinity }).includes(TOKEN), false, String(error));
    }
    const views = [JSON.stringify(client), inspect(client, { showHidden: true, depth: Infinity }), String(client)];
    assert.equal(views.join('\n').includes(TOKEN), false, 'the client object shows the token');
  });
});

describe('ManagerFundingClient: what it is given', () => {
  it('refuses an address the funding rules refuse, and a token they refuse, repeating neither', () => {
    for (const [what, options, key, value] of [
      [
        'plain http to another host',
        { url: 'http://funding.example.test:9876' },
        'MANAGER_FUNDING_URL',
        'funding.example.test',
      ],
      [
        'a user in the address',
        { url: 'https://operator:password-1234@manager.example.org' },
        'MANAGER_FUNDING_URL',
        'password-1234',
      ],
      ['a short token', { token: 'tiny-funding-token' }, 'MANAGER_FUNDING_TOKEN', 'tiny-funding-token'],
      ['a token with a line break', { token: `${TOKEN}\nX-Injected: 1` }, 'MANAGER_FUNDING_TOKEN', TOKEN],
    ] as const) {
      assert.throws(
        () => clientOn(() => Response.json(inventory()), options),
        (error: unknown) => {
          assert.ok(error instanceof Error, what);
          assert.match(error.message, new RegExp(key), what);
          assert.equal(error.message.includes(value), false, what);
          return true;
        },
      );
    }
  });

  it('takes plain http to this host', () => {
    for (const url of ['http://127.0.0.1:9876', 'http://host.docker.internal:9876', 'http://manager:9876']) {
      assert.doesNotThrow(() => clientOn(() => Response.json(inventory()), { url }), url);
    }
  });

  it('refuses a deadline or a size limit that is not a whole number above 0', () => {
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { timeoutMs: Number.NaN },
      { stampTimeoutMs: 0 },
      { stampTimeoutMs: Number.POSITIVE_INFINITY },
      { maxAnswerBytes: 0 },
    ]) {
      assert.throws(() => clientOn(() => Response.json(inventory()), options), /whole number/, JSON.stringify(options));
    }
  });
});
