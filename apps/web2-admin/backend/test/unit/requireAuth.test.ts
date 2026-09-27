/**
 * The gate in front of every route but /api/health, /api/config, /api/internal
 * and the open half of /api/auth.
 *
 * Runs the real middleware over the real Express router on a random port, with
 * the users and sessions held in memory instead of Postgres. What it pins is
 * the session's two clocks, which are impossible to check by reading the code:
 * twelve hours of inactivity, fourteen days whatever happens, and a
 * `last_seen_at` write no more often than once a minute so a console left open
 * does not become a write per request.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { hashSessionToken } from '@streaming-monorepo/web-auth';

import { AuthTestApp, call, sessionCookieFrom, signIn, startAuthTestApp } from './support/authTestApp.js';

const USERNAME = 'levi';
const PASSWORD = 'a-long-enough-password';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

let app: AuthTestApp;
let userId: string;

before(async () => {
  app = await startAuthTestApp();
  userId = (await app.authService.addUser(USERNAME, PASSWORD)).id;
});

after(() => app.close());

/** Pretends the session was last used `ago` milliseconds back. */
async function lastSeen(token: string, ago: number): Promise<void> {
  await app.sessions.touch(hashSessionToken(token), new Date(Date.now() - ago));
}

async function lastSeenAt(token: string): Promise<Date> {
  const session = await app.sessions.findByTokenHash(hashSessionToken(token));
  assert.ok(session, 'the session should still be stored');
  return session.lastSeenAt;
}

describe('requireAuth', () => {
  it('refuses a request that carries no cookie', async () => {
    const res = await call(app, 'GET', '/api/streams');

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthenticated' });
  });

  it('refuses a token nobody issued, and clears it', async () => {
    const res = await call(app, 'GET', '/api/streams', {
      cookie: 'web2_admin_session=this-was-never-issued',
    });

    assert.equal(res.status, 401);
    assert.equal(
      sessionCookieFrom(res.setCookie),
      null,
      'the dead cookie should be cleared, not left to be sent again',
    );
    assert.equal(res.setCookie.length, 1);
  });

  it('lets a signed-in request through and says who it is', async () => {
    const { cookie } = await signIn(app, USERNAME, PASSWORD);
    const res = await call(app, 'GET', '/api/streams', { cookie });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { user: USERNAME });
  });

  it('refuses a session idle for more than twelve hours', async () => {
    const { cookie, token } = await signIn(app, USERNAME, PASSWORD);

    await lastSeen(token, 11 * HOUR_MS);
    assert.equal((await call(app, 'GET', '/api/streams', { cookie })).status, 200);

    await lastSeen(token, 12 * HOUR_MS + MINUTE_MS);
    assert.equal((await call(app, 'GET', '/api/streams', { cookie })).status, 401);
  });

  it('refuses a session past its fourteen day deadline, however busy', async () => {
    const { cookie, token } = await signIn(app, USERNAME, PASSWORD);

    // Used a second ago, so only the absolute deadline can end it.
    await app.sessions.create({
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt: new Date(Date.now() - 1000),
      ip: null,
      userAgent: null,
    });

    assert.equal((await call(app, 'GET', '/api/streams', { cookie })).status, 401);
  });

  it('writes last_seen_at at most once a minute', async () => {
    const { cookie, token } = await signIn(app, USERNAME, PASSWORD);
    const first = await lastSeenAt(token);

    await call(app, 'GET', '/api/streams', { cookie });
    assert.deepEqual(await lastSeenAt(token), first, 'a second request within the minute must not write');

    await lastSeen(token, 61 * 1000);
    await call(app, 'GET', '/api/streams', { cookie });
    assert.ok(
      (await lastSeenAt(token)).getTime() > Date.now() - 5000,
      'a request after the minute must slide the window forward',
    );
  });

  it('drops every session of a user whose account is removed', async () => {
    const doomed = await app.authService.addUser('doomed', PASSWORD);
    const { cookie } = await signIn(app, 'doomed', PASSWORD);
    assert.equal((await call(app, 'GET', '/api/streams', { cookie })).status, 200);

    await app.authService.removeUser(doomed.id, userId);

    assert.equal((await call(app, 'GET', '/api/streams', { cookie })).status, 401);
  });
});
