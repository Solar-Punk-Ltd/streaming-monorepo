/**
 * The bounded client that stores and clears the brand's catalogue stamp record in a web2 admin: the call it makes,
 * the check of the record before it leaves, and the one outcome code each kind of answer comes to.
 *
 * Unit test against a fake admin on the loopback. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, type TestContext } from 'node:test';

import { CATALOGUE_STAMP_PATH, type CatalogueStampRecord } from '@streaming-monorepo/contracts';

import { sendCatalogueRequest } from '../../src/domain/stages/catalogueRequest.js';

const TOKEN = 'synthetic-registrar-token-0123456789abcdef';
const OBSERVED_AT = '2026-09-28T10:00:00.000Z';

const record: CatalogueStampRecord = {
  schemaVersion: 1,
  managerId: '00000000-0000-4000-8000-000000000099',
  nodeName: 'catalogue',
  beeApiUrl: 'http://192.0.2.30:10025',
  batchId: 'ab'.repeat(32),
  immutable: true,
  depth: 20,
  state: 'active',
  ttlSeconds: 7_776_000,
  fillRatio: 0.125,
  designatedAt: '2026-09-28T09:00:00.000Z',
  observedAt: OBSERVED_AT,
};

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

describe('storing the catalogue stamp record', () => {
  it('PUTs the record to the catalogue stamp path with the bearer token, and answers stored', async (t) => {
    const admin = await fakeAdmin(t, json(200, { stored: true }));
    const outcome = await sendCatalogueRequest({ kind: 'store', baseUrl: `${admin.base}/`, token: TOKEN, record });
    assert.equal(outcome, 'stored');
    assert.equal(admin.seen.length, 1);
    assert.equal(admin.seen[0]!.method, 'PUT');
    assert.equal(admin.seen[0]!.url, CATALOGUE_STAMP_PATH);
    assert.equal(admin.seen[0]!.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(admin.seen[0]!.body), record);
  });

  it('answers older-ignored when the admin kept a newer record', async (t) => {
    const admin = await fakeAdmin(t, json(200, { stored: false }));
    assert.equal(
      await sendCatalogueRequest({ kind: 'store', baseUrl: admin.base, token: TOKEN, record }),
      'older-ignored',
    );
  });

  it('sends nothing for a record the contract refuses', async (t) => {
    const admin = await fakeAdmin(t, json(200, { stored: true }));
    const outcome = await sendCatalogueRequest({
      kind: 'store',
      baseUrl: admin.base,
      token: TOKEN,
      record: { ...record, depth: 12 },
    });
    assert.equal(outcome, 'skipped-no-record');
    assert.equal(admin.seen.length, 0);
  });

  it('tells a refused token from a refused record, and either from another server', async (t) => {
    const cases: Array<[Handler, string]> = [
      [json(401, { error: 'unauthenticated' }), 'refused-token'],
      [json(401, { error: 'something-else' }), 'not-admin'],
      [json(400, { error: 'validation_error' }), 'refused-record'],
      [json(404, { error: 'not_found' }), 'not-admin'],
      [json(200, { hello: 'world' }), 'not-admin'],
    ];
    for (const [handler, expected] of cases) {
      const admin = await fakeAdmin(t, handler);
      assert.equal(await sendCatalogueRequest({ kind: 'store', baseUrl: admin.base, token: TOKEN, record }), expected);
    }
  });

  it('follows no redirect, gives up on a slow answer, and asks nothing of an address that is not http', async (t) => {
    const redirect = await fakeAdmin(t, (_req, res) => {
      res.writeHead(302, { location: 'https://elsewhere.example.org/' });
      res.end();
    });
    assert.equal(
      await sendCatalogueRequest({ kind: 'store', baseUrl: redirect.base, token: TOKEN, record }),
      'redirected',
    );
    assert.equal(redirect.seen.length, 1);

    const slow = await fakeAdmin(t, () => undefined);
    assert.equal(
      await sendCatalogueRequest({ kind: 'store', baseUrl: slow.base, token: TOKEN, record }, { timeoutMs: 50 }),
      'unreachable',
    );

    assert.equal(
      await sendCatalogueRequest({ kind: 'store', baseUrl: 'ftp://admin.example.org', token: TOKEN, record }),
      'not-admin',
    );
  });
});

describe('clearing the catalogue stamp', () => {
  it('DELETEs with the moment in the body, and tells a clear from nothing to clear', async (t) => {
    const cleared = await fakeAdmin(t, json(200, { cleared: true }));
    assert.equal(
      await sendCatalogueRequest({ kind: 'clear', baseUrl: cleared.base, token: TOKEN, observedAt: OBSERVED_AT }),
      'cleared',
    );
    assert.equal(cleared.seen[0]!.method, 'DELETE');
    assert.equal(cleared.seen[0]!.url, CATALOGUE_STAMP_PATH);
    assert.equal(cleared.seen[0]!.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(cleared.seen[0]!.body), { observedAt: OBSERVED_AT });

    const nothing = await fakeAdmin(t, json(200, { cleared: false }));
    assert.equal(
      await sendCatalogueRequest({ kind: 'clear', baseUrl: nothing.base, token: TOKEN, observedAt: OBSERVED_AT }),
      'not-cleared',
    );
  });
});

describe('an admin link in plain http to another host', () => {
  it('is sent nothing, and the call answers refused-plain-http', async (t) => {
    const fetched = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('no request may leave');
    });
    const refused = async () => 'refused' as const;
    const baseUrl = 'http://admin.example:3000';
    assert.equal(
      await sendCatalogueRequest({ kind: 'store', baseUrl, token: TOKEN, record }, { plainHttp: refused }),
      'refused-plain-http',
    );
    assert.equal(
      await sendCatalogueRequest(
        { kind: 'clear', baseUrl, token: TOKEN, observedAt: OBSERVED_AT },
        { plainHttp: refused },
      ),
      'refused-plain-http',
    );
    assert.equal(fetched.mock.callCount(), 0);
  });
});
