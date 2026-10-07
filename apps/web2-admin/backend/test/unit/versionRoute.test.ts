/**
 * GET /api/version: the build this API runs, for signed-in users only. Unit test: the real route behind the real
 * session gate on a random port, wired as server.ts wires it, with users and sessions held in memory. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { VERSION_PATH, type VersionInfo } from '@streaming-monorepo/web2-admin-common';

import { TEST_SETUP } from './support/authFixtures.js';
import { AuthTestApp, call, signIn, startAuthTestApp } from './support/authTestApp.js';

const USERNAME = 'alice';
const PASSWORD = 'a-long-enough-password';

/** A tagged build, as a deploy builds one into the image. */
const BUILT: VersionInfo = { label: 'QA-build-2026-10-07', commit: '0123456789abcdef0123456789abcdef01234567' };

describe('GET /api/version on an image a deploy built', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp(undefined, { version: BUILT });
    await app.authService.addUser(TEST_SETUP, USERNAME, PASSWORD);
  });

  after(() => app.close());

  it('answers a signed-in user with the label and the commit the deploy built in, never from a cache', async () => {
    const { cookie } = await signIn(app, USERNAME, PASSWORD);

    const res = await fetch(`${app.url}${VERSION_PATH}`, { headers: { cookie } });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), BUILT);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('refuses a request that carries no session, as every console route does', async () => {
    const res = await call(app, 'GET', VERSION_PATH);

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthenticated' });
  });

  it('refuses a session cookie nobody issued, and says nothing about the build', async () => {
    const res = await call(app, 'GET', VERSION_PATH, { cookie: 'web2_admin_session=this-was-never-issued' });

    assert.equal(res.status, 401);
    assert.doesNotMatch(JSON.stringify(res.body), /QA-build|0123456789abcdef/);
  });

  it('refuses a session that was signed out', async () => {
    const { cookie } = await signIn(app, USERNAME, PASSWORD);
    assert.equal((await call(app, 'POST', '/api/auth/logout', { cookie })).status, 204);

    const res = await call(app, 'GET', VERSION_PATH, { cookie });

    assert.equal(res.status, 401);
  });
});

describe('GET /api/version on an image built without a version', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(TEST_SETUP, USERNAME, PASSWORD);
  });

  after(() => app.close());

  it('answers nulls, which the console shows as a development build', async () => {
    const { cookie } = await signIn(app, USERNAME, PASSWORD);

    const res = await call(app, 'GET', VERSION_PATH, { cookie });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { label: null, commit: null });
  });
});
