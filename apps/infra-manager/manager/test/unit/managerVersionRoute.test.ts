/**
 * GET /version: the build this manager runs, to a signed-in user and to nobody else, read once from what the deploy
 * built into the api image.
 *
 * Unit test, no database. The real gate and the real router on a random port, with the users and sessions held in
 * memory. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createManagerVersionRouter } from '../../src/api/routes/managerVersion.js';
import { managerVersion } from '../../src/utils/config.js';
import { type AuthTestApp, call, signIn, startAuthTestApp } from '../support/authTestApp.js';

const USERNAME = 'operator';
const PASSWORD = 'a-long-enough-password';
const LABEL = 'QA-build-2026-10-07+3';
const COMMIT = '635b4e1753cd35d06191fdd54a1f426f7478d438';

/**
 * The gate with the version router behind it, answering what the config reads from `env` as the manager's own
 * environment, and one user to sign in as.
 */
async function startWith(env: NodeJS.ProcessEnv): Promise<AuthTestApp> {
  const version = managerVersion(env.MANAGER_VERSION, env.MANAGER_COMMIT);
  const app = await startAuthTestApp(undefined, { '/version': createManagerVersionRouter(version) });
  await app.authService.addUser(USERNAME, PASSWORD);
  return app;
}

describe('GET /version', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startWith({ MANAGER_VERSION: LABEL, MANAGER_COMMIT: COMMIT });
  });

  after(() => app.close());

  it('refuses a request without a session, and says nothing of the build', async () => {
    const res = await call(app, 'GET', '/version');

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'not_signed_in' });
  });

  it('refuses a session cookie nobody issued', async () => {
    const res = await call(app, 'GET', '/version', { cookie: 'sim_session=this-was-never-issued' });

    assert.equal(res.status, 401);
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(`${COMMIT}|QA-build`));
  });

  it('answers the label and the commit to a signed-in user, never from a cache', async () => {
    const { cookie } = await signIn(app, USERNAME, PASSWORD);

    const res = await fetch(`${app.url}/version`, { headers: { cookie } });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { label: LABEL, commit: COMMIT });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('answers null for both when nothing set a version, as on a development build', async () => {
    const bare = await startWith({});
    try {
      const { cookie } = await signIn(bare, USERNAME, PASSWORD);

      const res = await call(bare, 'GET', '/version', { cookie });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { label: null, commit: null });
    } finally {
      await bare.close();
    }
  });

  it('answers null for a value of another shape than the deploy builds in', async () => {
    const malformed = await startWith({ MANAGER_VERSION: "QA';touch x;'", MANAGER_COMMIT: COMMIT.slice(0, 9) });
    try {
      const { cookie } = await signIn(malformed, USERNAME, PASSWORD);

      const res = await call(malformed, 'GET', '/version', { cookie });

      assert.deepEqual(res.body, { label: null, commit: null });
    } finally {
      await malformed.close();
    }
  });
});

describe('the build the config reads from MANAGER_VERSION and MANAGER_COMMIT', () => {
  it('is the label and the commit the image carries', () => {
    assert.deepEqual(managerVersion(LABEL, COMMIT), { label: LABEL, commit: COMMIT });
  });

  it('is null for each one that is unset or empty', () => {
    assert.deepEqual(managerVersion(undefined, undefined), { label: null, commit: null });
    assert.deepEqual(managerVersion('', ''), { label: null, commit: null });
    assert.deepEqual(managerVersion(LABEL, undefined), { label: LABEL, commit: null });
    assert.deepEqual(managerVersion(undefined, COMMIT), { label: null, commit: COMMIT });
  });

  it('is null for a label outside the characters and the length version.mjs prints', () => {
    for (const label of ['QA build', 'QA"', 'QA$(id)', 'QA`id`', 'QA\\', ` ${LABEL}`, `${LABEL}\n`, 'a'.repeat(97)]) {
      assert.equal(managerVersion(label, COMMIT).label, null, label);
    }
    assert.equal(managerVersion('a'.repeat(96), COMMIT).label, 'a'.repeat(96));
  });

  it('is null for a commit that is not 40 lowercase hex digits', () => {
    for (const commit of [COMMIT.slice(0, 9), COMMIT.toUpperCase(), `${COMMIT}0`, `${COMMIT} `, 'z'.repeat(40)]) {
      assert.equal(managerVersion(LABEL, commit).commit, null, commit);
    }
  });
});
