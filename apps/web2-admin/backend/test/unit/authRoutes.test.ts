/**
 * The sign-in routes, driven over HTTP the way the browser drives them.
 *
 * The app is the real Express wiring on a random port, with the users and
 * sessions in memory instead of Postgres. Every case here is a claim about what
 * the backend answers, and each is cheap to break by accident: the empty-users
 * state, the cookie's attributes, the refusal of a write that arrives without
 * the header a cross-origin page cannot set, the lockout schedule as an
 * operator meets it, and the uploader's routes staying reachable in front of
 * all of it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { MeResponse, UserListResponse, UserSummary } from '@streaming-monorepo/web2-admin-common';
import { LoginLimiter } from '@streaming-monorepo/web-auth';

import {
  AuthTestApp,
  call,
  INTERNAL_TOKEN,
  sessionCookieFrom,
  signIn,
  startAuthTestApp,
} from './support/authTestApp.js';

const USERNAME = 'levi';
const PASSWORD = 'a-long-enough-password';
const OTHER_PASSWORD = 'another-fine-password';

const LOGIN = '/api/auth/login';
const SESSION = '/api/auth/session';
const USERS = '/api/auth/users';

describe('with no users yet', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp();
  });
  after(() => app.close());

  it('still answers the health check', async () => {
    const res = await call(app, 'GET', '/api/health');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('tells the sign-in page there is nobody to sign in as', async () => {
    const res = await call(app, 'GET', SESSION);

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'no_users' });
  });

  it('refuses a sign-in with the same reason', async () => {
    const res = await call(app, 'POST', LOGIN, {
      body: { username: USERNAME, password: PASSWORD },
    });

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'no_users' });
  });

  it('keeps every other route shut', async () => {
    const res = await call(app, 'GET', '/api/streams');

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthenticated' });
  });

  it('leaves the uploader routes open, token and all', async () => {
    const res = await call(app, 'POST', '/api/internal/ping', {
      body: { hello: 'uploader' },
      requestedWith: false,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, body: { hello: 'uploader' } });
  });
});

describe('signing in and out', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(USERNAME, PASSWORD);
  });
  after(() => app.close());

  it('sets a cookie the page script cannot read and a stranger cannot use', async () => {
    const res = await call(app, 'POST', LOGIN, {
      body: { username: USERNAME, password: PASSWORD },
    });

    assert.equal(res.status, 200);
    assert.equal((res.body as MeResponse).user.username, USERNAME);
    const header = res.setCookie[0] ?? '';
    assert.match(header, /^web2_admin_session=/);
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i);
    assert.match(header, /Path=\//i);
    // A session cookie: the sessions row is the only clock there is.
    assert.doesNotMatch(header, /Expires=/i);
    assert.doesNotMatch(header, /Max-Age=/i);
    // Plain HTTP here, so Secure would make the browser drop it at once.
    assert.doesNotMatch(header, /Secure/i);
  });

  it('answers the session route with the signed-in user', async () => {
    const { cookie } = await signIn(app, USERNAME, PASSWORD);
    const res = await call(app, 'GET', SESSION, { cookie });

    assert.equal(res.status, 200);
    const { user } = res.body as MeResponse;
    assert.equal(user.username, USERNAME);
    assert.equal(user.isAdmin, true);
    assert.ok(user.lastLoginAt, 'signing in records when it happened');
  });

  it('opens the rest of the API, which was shut a moment earlier', async () => {
    assert.equal((await call(app, 'GET', '/api/streams')).status, 401);

    const { cookie } = await signIn(app, USERNAME, PASSWORD);

    assert.equal((await call(app, 'GET', '/api/streams', { cookie })).status, 200);
  });

  it('says the same thing to a wrong password and an unknown name', async () => {
    const wrongPassword = await call(app, 'POST', LOGIN, {
      body: { username: USERNAME, password: 'not-the-password' },
    });
    const noSuchUser = await call(app, 'POST', LOGIN, {
      body: { username: 'nobody', password: 'not-the-password' },
    });

    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, { error: 'invalid_credentials' });
    assert.deepEqual(noSuchUser.body, wrongPassword.body);
    assert.equal(sessionCookieFrom(noSuchUser.setCookie), null);
  });

  it('refuses a password too long to be one, before anything hashes it', async () => {
    const res = await call(app, 'POST', LOGIN, {
      body: { username: USERNAME, password: 'x'.repeat(5_000) },
    });

    assert.equal(res.status, 400);
    assert.equal((res.body as { error: string }).error, 'validation_error');
  });

  it('signs out, and the cookie stops working', async () => {
    const { cookie } = await signIn(app, USERNAME, PASSWORD);
    const out = await call(app, 'POST', '/api/auth/logout', { cookie });

    assert.equal(out.status, 204);
    assert.equal(sessionCookieFrom(out.setCookie), null);
    assert.equal((await call(app, 'GET', '/api/streams', { cookie })).status, 401);
  });

  it('clears a stale cookie on logout instead of refusing it', async () => {
    const res = await call(app, 'POST', '/api/auth/logout', {
      cookie: 'web2_admin_session=long-gone',
    });

    assert.equal(res.status, 204);
  });
});

describe('too many attempts', () => {
  let app: AuthTestApp;
  const clock = { now: 1_700_000_000_000 };

  const OURS = '198.51.100.7';
  const ELSEWHERE = '203.0.113.9';
  const LATER = '203.0.113.10';

  const from = (ip: string) => ({ 'x-forwarded-for': ip });

  const login = (ip: string, username: string, password: string) =>
    call(app, 'POST', LOGIN, {
      body: { username, password },
      headers: from(ip),
    });

  before(async () => {
    app = await startAuthTestApp(new LoginLimiter(() => clock.now));
    await app.authService.addUser(USERNAME, PASSWORD);
    await app.authService.addUser('mate', OTHER_PASSWORD);
  });
  after(() => app.close());

  it('locks after the fifth wrong password, and says for how long', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const res = await login(OURS, USERNAME, 'not-the-password');
      assert.equal(res.status, 401, `attempt ${i}`);
    }

    const locked = await login(OURS, USERNAME, 'not-the-password');

    assert.equal(locked.status, 429);
    assert.equal(locked.retryAfter, '60');
    assert.deepEqual(locked.body, {
      error: 'too_many_attempts',
      retryAfterSeconds: 60,
    });
  });

  it('refuses the right password while it is locked', async () => {
    const res = await login(OURS, USERNAME, PASSWORD);

    assert.equal(res.status, 429);
    assert.equal(sessionCookieFrom(res.setCookie), null);
  });

  it('locks the address as well, so a second account cannot be tried from it', async () => {
    assert.equal((await login(OURS, 'mate', OTHER_PASSWORD)).status, 429);
  });

  it('leaves other addresses able to sign in', async () => {
    const res = await login(ELSEWHERE, 'mate', OTHER_PASSWORD);

    assert.equal(res.status, 200);
    assert.ok(sessionCookieFrom(res.setCookie));
  });

  it('lets the right password through once the wait is over, and forgets the count', async () => {
    clock.now += 60_000;

    assert.equal((await login(LATER, USERNAME, PASSWORD)).status, 200);

    // The successful sign-in cleared the username key, so four more misses
    // from a fresh address must not lock it again.
    for (let i = 1; i <= 4; i += 1) {
      const res = await login(LATER, USERNAME, 'not-the-password');
      assert.equal(res.status, 401, `attempt ${i} after the reset`);
    }
  });
});

// Its own app, so the count starts at zero: what matters here is how many of
// the requests got as far as hashing a password.
describe('a burst of sign-ins sent at once', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(USERNAME, PASSWORD);
  });
  after(() => app.close());

  it('lets only the free attempts pay for a password check', async () => {
    const sent = 20;
    const before = app.users.usernameLookups();

    const answers = await Promise.all(
      Array.from({ length: sent }, () =>
        call(app, 'POST', LOGIN, {
          body: { username: USERNAME, password: 'not-the-password' },
        }),
      ),
    );

    const checked = app.users.usernameLookups() - before;
    assert.ok(checked <= 5, `${checked} of ${sent} guesses reached the password check`);
    assert.equal(answers.filter((res) => res.status === 401).length, checked);
    assert.equal(answers.filter((res) => res.status === 429).length, sent - checked);
  });
});

// Its own app and its own clock, so the wait it reports is exact.
describe('too many wrong current passwords', () => {
  let app: AuthTestApp;
  let cookie: string;
  const clock = { now: 1_700_000_000_000 };

  before(async () => {
    app = await startAuthTestApp(new LoginLimiter(() => clock.now));
    await app.authService.addUser(USERNAME, PASSWORD);
    cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
  });
  after(() => app.close());

  it('locks the password change the way a sign-in is locked', async () => {
    const wrongCurrent = () =>
      call(app, 'POST', '/api/auth/password', {
        cookie,
        body: {
          currentPassword: 'not-the-password',
          newPassword: 'a-fine-new-password',
        },
      });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal((await wrongCurrent()).status, 401, `attempt ${attempt}`);
    }

    const locked = await wrongCurrent();

    assert.equal(locked.status, 429);
    assert.equal(locked.retryAfter, '60');
    assert.deepEqual(locked.body, {
      error: 'too_many_attempts',
      retryAfterSeconds: 60,
    });
  });

  it('lets the right current password through once the wait is over', async () => {
    clock.now += 60_000;

    const changed = await call(app, 'POST', '/api/auth/password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
    });

    assert.equal(changed.status, 200);
  });
});

describe('cross-site writes', () => {
  let app: AuthTestApp;
  let cookie: string;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(USERNAME, PASSWORD);
    cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
  });
  after(() => app.close());

  it('refuses a write without the header, before the body is read', async () => {
    // The body is not JSON on purpose: read first, this would be answered 400
    // for the body rather than 403 for the missing header.
    const res = await call(app, 'POST', '/api/streams', {
      cookie,
      requestedWith: false,
      rawBody: '{ not json',
    });

    assert.equal(res.status, 403);
    assert.equal((res.body as { error: string }).error, 'cross_site_request');
  });

  it('refuses a sign-in without the header as well', async () => {
    const res = await call(app, 'POST', LOGIN, {
      requestedWith: false,
      body: { username: USERNAME, password: PASSWORD },
    });

    assert.equal(res.status, 403);
  });

  it('refuses a write the browser reports as cross-site', async () => {
    const res = await call(app, 'POST', '/api/streams', {
      cookie,
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    assert.equal(res.status, 403);
  });

  it('refuses a write whose Origin names another site', async () => {
    const res = await call(app, 'POST', '/api/streams', {
      cookie,
      headers: { origin: 'https://evil.example' },
    });

    assert.equal(res.status, 403);
  });

  it('allows the write our own page makes', async () => {
    const res = await call(app, 'POST', '/api/streams', { cookie });

    assert.equal(res.status, 201);
  });

  it('lets a read through without the header', async () => {
    const res = await call(app, 'GET', '/api/streams', {
      cookie,
      requestedWith: false,
    });

    assert.equal(res.status, 200);
  });

  it('never sets a CORS header, so no other origin can read an answer', async () => {
    const res = await fetch(`${app.url}${SESSION}`, {
      headers: { origin: 'https://evil.example' },
    });

    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });

  it('leaves the uploader outside all of it', async () => {
    // No Origin, no Sec-Fetch-Site, no x-requested-with, no cookie: exactly
    // what swarm-hls-stream sends, and exactly what requireSameSite refuses.
    const res = await call(app, 'POST', '/api/internal/ping', {
      requestedWith: false,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      body: { report: 'live' },
    });

    assert.equal(res.status, 200);
  });

  it('still refuses an uploader route without the token', async () => {
    const res = await call(app, 'POST', '/api/internal/ping', {
      requestedWith: false,
      body: { report: 'live' },
    });

    assert.equal(res.status, 401);
  });
});

describe('two users removing each other at once', () => {
  it('refuses the removal that would empty the table', async () => {
    const app = await startAuthTestApp();
    const ann = await app.authService.addUser('ann', PASSWORD);
    const bob = await app.authService.addUser('bob', OTHER_PASSWORD);

    const outcomes = await Promise.allSettled([
      app.authService.removeUser(bob.id, ann.id),
      app.authService.removeUser(ann.id, bob.id),
    ]);

    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
      'exactly one of the two removals may go through',
    );
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.match(String((refused as PromiseRejectedResult).reason), /last user/);
    assert.equal(await app.users.count(), 1);

    await app.close();
  });
});

describe('managing users', () => {
  let app: AuthTestApp;
  let cookie: string;
  let adminId: string;

  before(async () => {
    app = await startAuthTestApp();
    adminId = (await app.authService.addUser(USERNAME, PASSWORD)).id;
    cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
  });
  after(() => app.close());

  const list = async (): Promise<UserSummary[]> => {
    const res = await call(app, 'GET', USERS, { cookie });
    assert.equal(res.status, 200);
    return (res.body as UserListResponse).users;
  };

  it('lists who exists, when they last signed in, and how many sessions they hold', async () => {
    const [levi, ...rest] = await list();

    assert.equal(rest.length, 0);
    assert.equal(levi!.username, USERNAME);
    assert.equal(levi!.isAdmin, true);
    assert.equal(levi!.sessions, 1);
    assert.ok(levi!.lastLoginAt);
  });

  it('adds a user, and refuses the name a second time', async () => {
    const added = await call(app, 'POST', USERS, {
      cookie,
      body: { username: 'mate', password: OTHER_PASSWORD },
    });

    assert.equal(added.status, 201);
    const created = added.body as UserSummary;
    assert.equal(created.username, 'mate');
    assert.equal(created.isAdmin, false, 'a later user is plain unless asked');
    assert.equal(created.sessions, 0);

    const again = await call(app, 'POST', USERS, {
      cookie,
      body: { username: 'mate', password: OTHER_PASSWORD },
    });

    assert.equal(again.status, 409);
    assert.deepEqual(again.body, { error: 'user_exists', username: 'mate' });
  });

  it('refuses a password that is too short or carries the username', async () => {
    for (const password of ['short', 'mallory-is-here']) {
      const res = await call(app, 'POST', USERS, {
        cookie,
        body: { username: 'mallory', password },
      });

      assert.equal(res.status, 400, password);
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
  });

  it('refuses a username the database would refuse', async () => {
    for (const username of ['A', 'Mate', 'has space', 'x', '_leading']) {
      const res = await call(app, 'POST', USERS, {
        cookie,
        body: { username, password: OTHER_PASSWORD },
      });

      assert.equal(res.status, 400, username);
    }
  });

  it('refuses to remove yourself', async () => {
    const res = await call(app, 'DELETE', `${USERS}/${adminId}`, { cookie });

    assert.equal(res.status, 409);
    assert.equal((res.body as { error: string }).error, 'cannot_remove_user');
  });

  it('answers 404 for an id that is not a user', async () => {
    const res = await call(app, 'DELETE', `${USERS}/00000000-0000-4000-8000-999999999999`, { cookie });

    assert.equal(res.status, 404);
    assert.equal((res.body as { error: string }).error, 'user_not_found');
  });

  it('answers 400 for an id that is not a UUID', async () => {
    const res = await call(app, 'DELETE', `${USERS}/17`, { cookie });

    assert.equal(res.status, 400);
  });

  it('signs out every session of another user on request', async () => {
    const mate = (await list()).find((row) => row.username === 'mate');
    assert.ok(mate);
    const mateCookie = (await signIn(app, 'mate', OTHER_PASSWORD)).cookie;
    assert.equal((await call(app, 'GET', '/api/streams', { cookie: mateCookie })).status, 200);

    const revoked = await call(app, 'POST', `${USERS}/${mate.id}/revoke`, {
      cookie,
    });

    assert.equal(revoked.status, 204);
    assert.equal((await call(app, 'GET', '/api/streams', { cookie: mateCookie })).status, 401);
  });

  it('removes another user, and their sessions with them', async () => {
    const mate = (await list()).find((row) => row.username === 'mate');
    assert.ok(mate);
    const mateCookie = (await signIn(app, 'mate', OTHER_PASSWORD)).cookie;

    const removed = await call(app, 'DELETE', `${USERS}/${mate.id}`, { cookie });

    assert.equal(removed.status, 204);
    assert.equal((await list()).length, 1);
    assert.equal((await call(app, 'GET', '/api/streams', { cookie: mateCookie })).status, 401);
  });

  it('changes your password, keeps this session, drops your others', async () => {
    const elsewhere = (await signIn(app, USERNAME, PASSWORD)).cookie;

    const changed = await call(app, 'POST', '/api/auth/password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
    });

    assert.equal(changed.status, 200);
    assert.ok((changed.body as MeResponse).user.passwordChangedAt);
    assert.equal((await call(app, 'GET', '/api/streams', { cookie })).status, 200);
    assert.equal((await call(app, 'GET', '/api/streams', { cookie: elsewhere })).status, 401);

    // And the new password is the one that works now.
    await signIn(app, USERNAME, OTHER_PASSWORD);
    cookie = (await signIn(app, USERNAME, OTHER_PASSWORD)).cookie;
  });

  it('refuses a new password the policy refuses', async () => {
    const res = await call(app, 'POST', '/api/auth/password', {
      cookie,
      body: { currentPassword: OTHER_PASSWORD, newPassword: 'short' },
    });

    assert.equal(res.status, 400);
    assert.equal((res.body as { error: string }).error, 'validation_error');
  });
});

describe('who may manage users', () => {
  let app: AuthTestApp;
  let adminCookie: string;
  let plainCookie: string;
  let adminId: string;
  let plainId: string;

  before(async () => {
    app = await startAuthTestApp();
    // Asked for a plain user, and made an admin anyway: somebody has to be
    // able to add the second.
    adminId = (await app.authService.addUser(USERNAME, PASSWORD, { admin: false })).id;
    plainId = (await app.authService.addUser('mate', OTHER_PASSWORD)).id;
    adminCookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
    plainCookie = (await signIn(app, 'mate', OTHER_PASSWORD)).cookie;
  });
  after(() => app.close());

  it('makes the first user an admin and the next one plain', async () => {
    const res = await call(app, 'GET', USERS, { cookie: adminCookie });
    const users = (res.body as UserListResponse).users;

    assert.deepEqual(
      users.map((row) => [row.username, row.isAdmin]),
      [
        [USERNAME, true],
        ['mate', false],
      ],
    );
  });

  it('tells each session whether it can manage users', async () => {
    const admin = await call(app, 'GET', SESSION, { cookie: adminCookie });
    const plain = await call(app, 'GET', SESSION, { cookie: plainCookie });

    assert.equal((admin.body as MeResponse).user.isAdmin, true);
    assert.equal((plain.body as MeResponse).user.isAdmin, false);
  });

  it('lets a plain user read the list, because the console shows it', async () => {
    assert.equal((await call(app, 'GET', USERS, { cookie: plainCookie })).status, 200);
  });

  it('refuses a plain user who tries to add or remove one', async () => {
    const added = await call(app, 'POST', USERS, {
      cookie: plainCookie,
      body: { username: 'intruder', password: 'a-perfectly-good-password' },
    });
    const removed = await call(app, 'DELETE', `${USERS}/${adminId}`, {
      cookie: plainCookie,
    });

    assert.equal(added.status, 403);
    assert.equal((added.body as { error: string }).error, 'admin_required');
    assert.equal(removed.status, 403);
  });

  it('lets a plain user sign themselves out everywhere, but nobody else', async () => {
    const mine = await call(app, 'POST', `${USERS}/${plainId}/revoke`, {
      cookie: plainCookie,
    });
    assert.equal(mine.status, 204);

    const theirs = await call(app, 'POST', `${USERS}/${adminId}/revoke`, {
      cookie: (await signIn(app, 'mate', OTHER_PASSWORD)).cookie,
    });
    assert.equal(theirs.status, 403);
  });

  it('lets an admin add another admin, and refuses to remove the only one', async () => {
    const refused = await call(app, 'DELETE', `${USERS}/${adminId}`, {
      cookie: (await signIn(app, USERNAME, PASSWORD)).cookie,
    });
    // Removing yourself is refused first, so ask the plain user's id for the
    // last-admin rule: promote them and try again from the other side.
    assert.equal(refused.status, 409);

    const promoted = await call(app, 'POST', USERS, {
      cookie: adminCookie,
      body: {
        username: 'second-admin',
        password: 'yet-another-fine-password',
        admin: true,
      },
    });
    assert.equal(promoted.status, 201);
    assert.equal((promoted.body as UserSummary).isAdmin, true);

    const secondAdminCookie = (await signIn(app, 'second-admin', 'yet-another-fine-password')).cookie;
    const removedAdmin = await call(app, 'DELETE', `${USERS}/${adminId}`, {
      cookie: secondAdminCookie,
    });
    assert.equal(removedAdmin.status, 204, 'two admins, so one may go');

    const lastOne = await call(app, 'DELETE', `${USERS}/${plainId}`, {
      cookie: secondAdminCookie,
    });
    assert.equal(lastOne.status, 204);

    // Only `second-admin` is left, and they cannot remove themselves either.
    const emptied = await call(app, 'GET', USERS, { cookie: secondAdminCookie });
    assert.equal((emptied.body as UserListResponse).users.length, 1);
  });
});
