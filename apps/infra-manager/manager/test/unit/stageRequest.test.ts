/**
 * The bounded client that stores and retires stage records in a web2 admin:
 * the call it makes, and the one outcome code each kind of answer comes to.
 *
 * Unit test against a fake admin on the loopback. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, type TestContext } from 'node:test';

import type { StageRecord } from '@streaming-monorepo/contracts';

import { sendStageRequest } from '../../src/domain/stages/stageRequest.js';

const STAGE_ID = '1B4E28BA-2FA1-41D2-883F-0016D3CCA427';
const TOKEN = 'synthetic-registrar-token-0123456789abcdef';

const record = { stageId: STAGE_ID, name: 'stage-one' } as unknown as StageRecord;

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function fakeAdmin(t: TestContext, handler: Handler): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen };
}

const json =
  (status: number, body: unknown): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

describe('storing a stage record', () => {
  it('PUTs the record to the stage’s path with the bearer token, and answers stored', async (t) => {
    const admin = await fakeAdmin(t, json(200, { stored: true }));
    const outcome = await sendStageRequest({ kind: 'store', baseUrl: `${admin.base}/`, token: TOKEN, record });
    assert.equal(outcome, 'stored');
    assert.equal(admin.seen.length, 1);
    assert.equal(admin.seen[0]!.method, 'PUT');
    assert.equal(admin.seen[0]!.url, `/api/internal/stages/${STAGE_ID.toLowerCase()}`);
    assert.equal(admin.seen[0]!.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(admin.seen[0]!.body), record);
  });

  it('answers older-ignored when the admin kept a newer record', async (t) => {
    const admin = await fakeAdmin(t, json(200, { stored: false }));
    assert.equal(await sendStageRequest({ kind: 'store', baseUrl: admin.base, token: TOKEN, record }), 'older-ignored');
  });

  it('tells a refused token from a refused record, and either from another server', async (t) => {
    const cases: Array<[Handler, string]> = [
      [json(401, { error: 'unauthenticated' }), 'refused-token'],
      [json(401, { error: 'something-else' }), 'not-admin'],
      [json(400, { error: 'validation_error', errors: ['stageId'] }), 'refused-record'],
      [json(404, { error: 'not_found' }), 'not-admin'],
      [json(500, {}), 'not-admin'],
      [json(200, { hello: 'world' }), 'not-admin'],
      [
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>not json</html>');
        },
        'not-admin',
      ],
    ];
    for (const [handler, expected] of cases) {
      const admin = await fakeAdmin(t, handler);
      assert.equal(await sendStageRequest({ kind: 'store', baseUrl: admin.base, token: TOKEN, record }), expected);
    }
  });

  it('follows no redirect', async (t) => {
    const elsewhere = await fakeAdmin(t, json(200, { stored: true }));
    const admin = await fakeAdmin(t, (_req, res) => {
      res.writeHead(307, { location: `${elsewhere.base}/api/internal/stages/${STAGE_ID}` });
      res.end();
    });
    assert.equal(await sendStageRequest({ kind: 'store', baseUrl: admin.base, token: TOKEN, record }), 'redirected');
    assert.equal(elsewhere.seen.length, 0, 'the token went nowhere else');
  });

  it('gives up at the timeout and reads no more than the bound', async (t) => {
    const silent = await fakeAdmin(t, () => undefined);
    assert.equal(
      await sendStageRequest({ kind: 'store', baseUrl: silent.base, token: TOKEN, record }, { timeoutMs: 100 }),
      'unreachable',
    );
    const huge = await fakeAdmin(t, json(200, { stored: true, padding: 'x'.repeat(4096) }));
    assert.equal(
      await sendStageRequest({ kind: 'store', baseUrl: huge.base, token: TOKEN, record }, { maxBodyBytes: 1024 }),
      'not-admin',
    );
  });

  it('answers unreachable when nothing listens, and refuses an address that is not http or https', async () => {
    assert.equal(
      await sendStageRequest({ kind: 'store', baseUrl: 'http://127.0.0.1:9', token: TOKEN, record }),
      'unreachable',
    );
    assert.equal(
      await sendStageRequest({ kind: 'store', baseUrl: 'ftp://admin.example.org', token: TOKEN, record }),
      'not-admin',
    );
  });
});

describe('retiring a stage', () => {
  const GONE_AT = '2026-09-28T10:00:05.000Z';

  it('DELETEs the stage’s path with the moment it was seen gone, and answers whether there was one', async (t) => {
    const admin = await fakeAdmin(t, json(200, { retired: true }));
    assert.equal(
      await sendStageRequest({
        kind: 'retire',
        baseUrl: admin.base,
        token: TOKEN,
        stageId: STAGE_ID,
        observedAt: GONE_AT,
      }),
      'retired',
    );
    assert.equal(admin.seen[0]!.method, 'DELETE');
    assert.equal(admin.seen[0]!.url, `/api/internal/stages/${STAGE_ID.toLowerCase()}`);
    assert.equal(admin.seen[0]!.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(admin.seen[0]!.body), { observedAt: GONE_AT });

    const none = await fakeAdmin(t, json(200, { retired: false }));
    assert.equal(
      await sendStageRequest({
        kind: 'retire',
        baseUrl: none.base,
        token: TOKEN,
        stageId: STAGE_ID,
        observedAt: GONE_AT,
      }),
      'not-retired',
    );
  });
});

describe('an admin link in plain http to another host', () => {
  const refused = async () => 'refused' as const;

  it('is sent nothing, and the call answers refused-plain-http', async (t) => {
    const fetched = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('no request may leave');
    });
    const baseUrl = 'http://admin.example:3000';
    assert.equal(
      await sendStageRequest({ kind: 'store', baseUrl, token: TOKEN, record }, { plainHttp: refused }),
      'refused-plain-http',
    );
    assert.equal(
      await sendStageRequest(
        { kind: 'retire', baseUrl, token: TOKEN, stageId: STAGE_ID, observedAt: '2026-09-28T10:00:05.000Z' },
        { plainHttp: refused },
      ),
      'refused-plain-http',
    );
    assert.equal(fetched.mock.callCount(), 0);
  });

  it('is sent nothing while its name does not resolve, and the call answers unreachable', async (t) => {
    const fetched = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('no request may leave');
    });
    const outcome = await sendStageRequest(
      { kind: 'store', baseUrl: 'http://web2-admin-backend:3000', token: TOKEN, record },
      { plainHttp: async () => 'unresolved' },
    );
    assert.equal(outcome, 'unreachable');
    assert.equal(fetched.mock.callCount(), 0);
  });

  it('is judged on the link’s address, and one taken is sent as before', async (t) => {
    const admin = await fakeAdmin(t, json(200, { stored: true }));
    const judged: string[] = [];
    const outcome = await sendStageRequest(
      { kind: 'store', baseUrl: admin.base, token: TOKEN, record },
      {
        plainHttp: async (url) => {
          judged.push(url);
          return 'allowed-by-setting';
        },
      },
    );
    assert.equal(outcome, 'stored');
    assert.deepEqual(judged, [admin.base]);
  });
});
