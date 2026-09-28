/**
 * Test connection's requests to a web2 admin, against fake admins on loopback.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * For an uploader's token the probe asks what the stream uploader asks: the
 * internal lookup of a stream nobody declared, with the token, where the
 * admin's own 404 means it took the token and its 401 means it did not; then,
 * with the token, the stage it belongs to and the owner the admin knows for
 * it, and on a 404 there, an admin older than stages, the public config for
 * the address the admin signs its catalog with. For the manager's own token,
 * the registrar's, it asks the admin's registrar check, and only on an older
 * admin's 404 there the lookup. It answers one outcome code and nothing the
 * far end said. It follows no redirect, reads a bounded body, gives up after
 * its timeout, and sends the token to the admin's internal routes alone.
 *
 * `adminAnswering` is an admin of stages phases 5 to 8, which takes its
 * registrar token on the uploader's routes and has no registrar check;
 * `phase9Admin` is one of this version.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { probeAdminLink } from '../../src/domain/adminLink/adminLinkProbe.js';

const TOKEN = 'synthetic-admin-token-0123456789abcdef';
/** A stage's own token, which the admin answers `stages/self` for. */
const STAGE_TOKEN = 'c3'.repeat(32);
const STAGE_ID = '5f0c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e5f';
const STAGE_SELF = '/api/internal/stages/self';
const OWNER = `0x${'ab'.repeat(20)}`;
const OTHER_OWNER = `0x${'cd'.repeat(20)}`;
const UNUSED_STREAM = '/api/internal/streams/by-ingest/video/00000000-0000-0000-0000-000000000000';

interface Seen {
  path: string;
  authorization: string | undefined;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function serve(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url ?? '', authorization: request.headers.authorization });
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Answers as the web2 admin's own routes do, for the one token it was started with. */
function adminAnswering(
  options: { owner?: string | null; configStatus?: number; stageOwner?: string; selfStatus?: number } = {},
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '';
    if (path.startsWith('/api/internal/')) {
      const onStage = request.headers.authorization === `Bearer ${STAGE_TOKEN}`;
      if (request.headers.authorization !== `Bearer ${TOKEN}` && !onStage) {
        return json(response, 401, { error: 'unauthenticated' });
      }
      // Up to phase 8, the shared token belongs to no stage, and is answered the 404 an unknown path gets.
      if (path === STAGE_SELF && onStage) {
        if (options.selfStatus) return json(response, options.selfStatus, { error: 'internal_error' });
        return json(response, 200, { stageId: STAGE_ID, owner: options.stageOwner ?? OWNER });
      }
      if (/^\/api\/internal\/streams\/by-ingest\/(video|audio)\/[0-9a-f-]{36}$/.test(path)) {
        return json(response, 404, { error: 'stream_not_found', id: path.split('/').slice(-2).join('/') });
      }
      return json(response, 404, { error: 'not_found', path });
    }
    if (path === '/api/config') {
      if (options.configStatus) return json(response, options.configStatus, { error: 'internal_error' });
      const feed =
        options.owner === null
          ? { topic: 'catalog' }
          : { owner: options.owner ?? OWNER, topic: 'catalog', topicHex: 'ab' };
      return json(response, 200, { feed, viewerBaseUrl: null });
    }
    return json(response, 404, { error: 'not_found', path });
  };
}

/** A web2 admin of this version: the registrar token opens the registrar check alone, and the uploader's routes refuse it. */
function phase9Admin(request: IncomingMessage, response: ServerResponse): void {
  const path = request.url ?? '';
  const authorization = request.headers.authorization;
  if (!path.startsWith('/api/internal/')) return json(response, 404, { error: 'not_found', path });
  if (path === '/api/internal/registrar') {
    if (authorization !== `Bearer ${TOKEN}`) return json(response, 401, { error: 'unauthenticated' });
    response.writeHead(204);
    return void response.end();
  }
  if (authorization !== `Bearer ${STAGE_TOKEN}`) return json(response, 401, { error: 'unauthenticated' });
  if (path === STAGE_SELF) return json(response, 200, { stageId: STAGE_ID, owner: OWNER });
  return json(response, 404, { error: 'stream_not_found' });
}

describe("Test connection of the manager's own token, the registrar's", () => {
  it("proves it on the admin's registrar check alone, and asks nothing else", async () => {
    const admin = await serve(phase9Admin);

    assert.equal(
      await probeAdminLink({ url: `${admin.url}/`, token: TOKEN, check: 'registrar', feedOwner: OWNER }),
      'token-accepted',
    );
    assert.deepEqual(admin.seen, [{ path: '/api/internal/registrar', authorization: `Bearer ${TOKEN}` }]);
  });

  it("takes the admin's 401 there as the token refused, a stage's own token included", async () => {
    const admin = await serve(phase9Admin);

    for (const token of [`${TOKEN}-wrong`, STAGE_TOKEN]) {
      assert.equal(
        await probeAdminLink({ url: admin.url, token, check: 'registrar', feedOwner: null }),
        'token-refused',
      );
    }
    assert.equal(admin.seen.length, 2);
  });

  it('reads the same token as refused on the lookup, which is why the lookup no longer proves it', async () => {
    const admin = await serve(phase9Admin);

    assert.equal(
      await probeAdminLink({ url: admin.url, token: TOKEN, check: 'uploader', feedOwner: null }),
      'token-refused',
    );
  });

  it("falls back to the lookup on an older admin's 404, where that admin still takes the token", async () => {
    const admin = await serve(adminAnswering());

    assert.equal(
      await probeAdminLink({ url: admin.url, token: TOKEN, check: 'registrar', feedOwner: OWNER }),
      'token-accepted',
    );
    assert.deepEqual(
      admin.seen.map((seen) => seen.path),
      ['/api/internal/registrar', UNUSED_STREAM],
      'no owner is compared for the registrar token',
    );
    assert.equal(
      await probeAdminLink({ url: admin.url, token: `${TOKEN}-wrong`, check: 'registrar', feedOwner: null }),
      'token-refused',
    );
  });

  it('is not fooled by another server, a redirect or silence', async () => {
    const plain = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<html>Not Found</html>');
    });
    const ok = await serve((_request, response) => json(response, 200, { hello: 'world' }));
    const redirecting = await serve((_request, response) => {
      response.writeHead(307, { location: 'http://127.0.0.1:9/' });
      response.end();
    });
    const hanging = await serve(() => undefined);

    const registrar = (url: string) => ({ url, token: TOKEN, check: 'registrar' as const, feedOwner: null });
    assert.equal(await probeAdminLink(registrar(plain.url)), 'not-admin');
    assert.equal(await probeAdminLink(registrar(ok.url)), 'not-admin');
    assert.equal(await probeAdminLink(registrar(redirecting.url)), 'redirected');
    assert.equal(await probeAdminLink(registrar(hanging.url), { timeoutMs: 300 }), 'unreachable');
  });
});

describe("Test connection of an uploader's token", () => {
  it('asks the lookup of a stream nobody declared with the token, and takes its 404 as the token accepted', async () => {
    const admin = await serve(adminAnswering());

    assert.equal(
      await probeAdminLink({ url: admin.url, token: TOKEN, check: 'uploader', feedOwner: null }),
      'token-accepted',
    );
    assert.deepEqual(admin.seen, [{ path: UNUSED_STREAM, authorization: `Bearer ${TOKEN}` }]);
  });

  it('strips a trailing slash from the address, as the uploader does', async () => {
    const admin = await serve(adminAnswering());

    assert.equal(
      await probeAdminLink({ url: `${admin.url}/`, token: TOKEN, check: 'uploader', feedOwner: null }),
      'token-accepted',
    );
    assert.equal(admin.seen[0]?.path, UNUSED_STREAM);
  });

  it('reads the owner off the public config without the token, and calls the link whole when it is the stream address', async () => {
    const admin = await serve(adminAnswering());

    assert.equal(
      await probeAdminLink({
        url: admin.url,
        token: TOKEN,
        check: 'uploader',
        feedOwner: OWNER.toUpperCase().replace('0X', '0x'),
      }),
      'linked',
    );
    assert.equal(
      await probeAdminLink({ url: admin.url, token: TOKEN, check: 'uploader', feedOwner: OWNER.slice(2) }),
      'linked',
    );
    assert.deepEqual(admin.seen[1], { path: STAGE_SELF, authorization: `Bearer ${TOKEN}` });
    assert.deepEqual(admin.seen[2], { path: '/api/config', authorization: undefined });
  });

  it("compares a stage's own token with the owner the admin knows for its stage, and not with the catalog's", async () => {
    // The catalog is the brand key's, and this stage signs with a key of its own.
    const admin = await serve(adminAnswering({ owner: OTHER_OWNER, stageOwner: OWNER }));

    assert.equal(
      await probeAdminLink({ url: admin.url, token: STAGE_TOKEN, check: 'uploader', feedOwner: OWNER.slice(2) }),
      'linked',
    );
    assert.deepEqual(
      admin.seen.map((seen) => seen.path),
      [UNUSED_STREAM, STAGE_SELF],
      'the public config is not asked',
    );
    assert.equal(admin.seen[1]?.authorization, `Bearer ${STAGE_TOKEN}`);
  });

  it('says so when the admin knows the stage under another owner than the stream address', async () => {
    const admin = await serve(adminAnswering({ owner: OWNER, stageOwner: OTHER_OWNER }));

    assert.equal(
      await probeAdminLink({ url: admin.url, token: STAGE_TOKEN, check: 'uploader', feedOwner: OWNER }),
      'owner-mismatch',
    );
  });

  it('says the owner could not be compared when the stage read fails, without falling back to the catalog', async () => {
    const failing = await serve(adminAnswering({ selfStatus: 500 }));
    const garbled = await serve((request, response) =>
      request.url === STAGE_SELF ? json(response, 200, { stageId: STAGE_ID }) : adminAnswering()(request, response),
    );

    assert.equal(
      await probeAdminLink({ url: failing.url, token: STAGE_TOKEN, check: 'uploader', feedOwner: OWNER }),
      'owner-unconfirmed',
    );
    assert.equal(failing.seen.length, 2);
    assert.equal(
      await probeAdminLink({ url: garbled.url, token: TOKEN, check: 'uploader', feedOwner: OWNER }),
      'owner-unconfirmed',
    );
  });

  it('says so when the admin signs its catalog with another address, which the uploader refuses to start with', async () => {
    const admin = await serve(adminAnswering({ owner: OTHER_OWNER }));

    assert.equal(
      await probeAdminLink({ url: admin.url, token: TOKEN, check: 'uploader', feedOwner: OWNER }),
      'owner-mismatch',
    );
  });

  it('says the owner could not be compared when the config names none or does not answer', async () => {
    const silent = await serve(adminAnswering({ owner: null }));
    const failing = await serve(adminAnswering({ configStatus: 500 }));

    assert.equal(
      await probeAdminLink({ url: silent.url, token: TOKEN, check: 'uploader', feedOwner: OWNER }),
      'owner-unconfirmed',
    );
    assert.equal(
      await probeAdminLink({ url: failing.url, token: TOKEN, check: 'uploader', feedOwner: OWNER }),
      'owner-unconfirmed',
    );
  });

  it("takes the admin's 401 as a wrong token, and asks nothing more", async () => {
    const admin = await serve(adminAnswering());

    assert.equal(
      await probeAdminLink({ url: admin.url, token: `${TOKEN}-wrong`, check: 'uploader', feedOwner: OWNER }),
      'token-refused',
    );
    assert.equal(admin.seen.length, 1);
  });

  it('is not fooled by a 404 or a 401 that is not the admin speaking', async () => {
    const prefixed = await serve(adminAnswering());
    const plain = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<html>Not Found</html>');
    });
    const gate = await serve((_request, response) => json(response, 401, { message: 'log in first' }));

    assert.equal(
      await probeAdminLink({ url: `${prefixed.url}/console`, token: TOKEN, check: 'uploader', feedOwner: null }),
      'not-admin',
    );
    assert.equal(
      await probeAdminLink({ url: plain.url, token: TOKEN, check: 'uploader', feedOwner: null }),
      'not-admin',
    );
    assert.equal(
      await probeAdminLink({ url: gate.url, token: TOKEN, check: 'uploader', feedOwner: null }),
      'not-admin',
    );
  });

  it('reads any other answer as not a web2 admin, garbage included', async () => {
    const ok = await serve((_request, response) => json(response, 200, { hello: 'world' }));
    const garbage = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error": "stream_not_found"');
    });

    assert.equal(await probeAdminLink({ url: ok.url, token: TOKEN, check: 'uploader', feedOwner: null }), 'not-admin');
    assert.equal(
      await probeAdminLink({ url: garbage.url, token: TOKEN, check: 'uploader', feedOwner: null }),
      'not-admin',
    );
  });

  it('refuses a redirect rather than following it, so the token goes nowhere else', async () => {
    const elsewhere = await serve(adminAnswering());
    const redirecting = await serve((_request, response) => {
      response.writeHead(307, { location: `${elsewhere.url}${UNUSED_STREAM}` });
      response.end();
    });

    assert.equal(
      await probeAdminLink({ url: redirecting.url, token: TOKEN, check: 'uploader', feedOwner: null }),
      'redirected',
    );
    assert.equal(elsewhere.seen.length, 0, 'the redirect target was never asked');
  });

  it('stops reading a body past its bound, and reads such an answer as not a web2 admin', async () => {
    const huge = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'stream_not_found', padding: 'x'.repeat(200_000) }));
    });

    assert.equal(
      await probeAdminLink({ url: huge.url, token: TOKEN, check: 'uploader', feedOwner: null }, { maxBodyBytes: 4096 }),
      'not-admin',
    );
  });

  it('gives up after its timeout and says the admin is unreachable', async () => {
    const hanging = await serve(() => undefined);
    const started = performance.now();

    assert.equal(
      await probeAdminLink({ url: hanging.url, token: TOKEN, check: 'uploader', feedOwner: null }, { timeoutMs: 300 }),
      'unreachable',
    );
    assert.ok(performance.now() - started < 3_000, 'the timeout ended the wait');
  });

  it('says the admin is unreachable when nothing listens at the address', async () => {
    const closed = await serve(() => undefined);
    const url = closed.url;
    await cleanups.pop()!();

    assert.equal(await probeAdminLink({ url, token: TOKEN, check: 'uploader', feedOwner: null }), 'unreachable');
  });

  it('asks nothing of an address that is not http or https', async () => {
    assert.equal(
      await probeAdminLink({ url: 'ftp://127.0.0.1/', token: TOKEN, check: 'uploader', feedOwner: null }),
      'invalid-address',
    );
    assert.equal(
      await probeAdminLink({ url: 'not an address', token: TOKEN, check: 'uploader', feedOwner: null }),
      'invalid-address',
    );
  });
});
