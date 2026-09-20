/**
 * The way in, against a real backend: the session cookie, the cross-site
 * header, the user routes, and the uploader's surface staying outside all of
 * it.
 *
 * The instance is the suite's own (see instance.ts) and its first user was
 * made by the `user:add` CLI, which is the only way a user can be made at all —
 * so the first two claims tested here are that the CLI worked and that the user
 * it made can manage users.
 *
 * The lockout is last on purpose: the client address is one of the keys it
 * counts on, so locking it out locks out every sign-in from this process.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  MeResponse,
  UserListResponse,
  UserSummary,
} from '@streaming-monorepo/web2-admin-common';

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  api,
  forgetCookie,
  internalCall,
  login,
  raw,
  releaseStack,
  requireStack,
  sessionCookie,
} from './helpers.js';

const PLAIN_USERNAME = 'itest-mate';
const PLAIN_PASSWORD = 'another-integration-password';

before(requireStack);
after(releaseStack);

async function users(): Promise<UserSummary[]> {
  const body = await api<UserListResponse>('GET', '/api/auth/users');
  return body.users;
}

describe('the first user, made on the host with the CLI', () => {
  it('is an admin, whatever the flag said', async () => {
    await login();
    const [first, ...rest] = await users();

    assert.equal(rest.length, 0);
    assert.equal(first.username, ADMIN_USERNAME);
    assert.equal(first.isAdmin, true);
    assert.equal(first.sessions, 1);
    assert.ok(first.lastLoginAt, 'signing in recorded when it happened');
  });
});

describe('the session route, which the console asks on boot', () => {
  it('answers 401 unauthenticated with no cookie', async () => {
    forgetCookie();
    const response = await raw('GET', '/api/auth/session', { anonymous: true });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'unauthenticated' });
  });

  it('answers the signed-in user, admin flag and all', async () => {
    await login();
    const { user } = await api<MeResponse>('GET', '/api/auth/session');

    assert.equal(user.username, ADMIN_USERNAME);
    assert.equal(user.isAdmin, true);
    assert.ok(user.lastLoginAt);
  });

  it('has no expiry on the cookie: the sessions row is the only clock', async () => {
    forgetCookie();
    const response = await raw('POST', '/api/auth/login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    const setCookie = response.headers.get('set-cookie') ?? '';

    assert.equal(response.status, 200);
    assert.doesNotMatch(setCookie, /Expires=/i);
    assert.doesNotMatch(setCookie, /Max-Age=/i);
    // Plain HTTP, so Secure would make the browser drop it on arrival.
    assert.doesNotMatch(setCookie, /Secure/i);
  });
});

describe('cross-site writes', () => {
  it('refuses a write without the header, before the body is read', async () => {
    await login();
    // Not JSON on purpose: read first, this would be 400 for the body rather
    // than 403 for the missing header.
    const response = await raw('POST', '/api/streams', {
      crossSiteHeader: false,
      raw: Buffer.from('{ not json'),
      contentType: 'application/json',
    });

    assert.equal(response.status, 403);
    assert.equal(
      (response.body as { error: string }).error,
      'cross_site_request',
    );
  });

  it('refuses a write whose Origin names another site', async () => {
    const response = await raw('POST', '/api/streams', {
      headers: { origin: 'https://evil.example' },
      body: {},
    });

    assert.equal(response.status, 403);
  });

  it('lets a read through without the header', async () => {
    const response = await raw('GET', '/api/streams');

    assert.equal(response.status, 200);
  });

  it('leaves the uploader reachable on its bearer token alone', async () => {
    // No cookie, no Origin, no x-requested-with: exactly what swarm-hls-stream
    // sends, and exactly what the cross-site check would refuse. /api/internal
    // is mounted ahead of it for that reason, and this is the test that says so.
    const response = await raw(
      'GET',
      '/api/internal/streams/by-ingest/video/not-a-uuid',
      internalCall(),
    );

    assert.notEqual(response.status, 403);
    assert.equal(response.status, 400, response.text);
  });

  it('still refuses an internal call with no token', async () => {
    const response = await raw(
      'GET',
      '/api/internal/streams/by-ingest/video/not-a-uuid',
      { anonymous: true, crossSiteHeader: false },
    );

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'unauthenticated' });
  });
});

describe('managing users over HTTP', () => {
  let plainId: string;
  let adminId: string;

  before(async () => {
    await login();
    adminId = (await users())[0].id;
  });

  it('adds a plain user', async () => {
    const created = await api<UserSummary>('POST', '/api/auth/users', {
      body: { username: PLAIN_USERNAME, password: PLAIN_PASSWORD },
    });
    plainId = created.id;

    assert.equal(created.isAdmin, false);
    assert.equal(created.sessions, 0);
  });

  it('refuses the same name twice', async () => {
    const response = await raw('POST', '/api/auth/users', {
      body: { username: PLAIN_USERNAME, password: PLAIN_PASSWORD },
    });

    assert.equal(response.status, 409);
    assert.equal((response.body as { error: string }).error, 'user_exists');
  });

  it('refuses a password the policy refuses, with the reason', async () => {
    const response = await raw('POST', '/api/auth/users', {
      body: { username: 'itest-weak', password: 'short' },
    });

    assert.equal(response.status, 400);
    const body = response.body as { error: string; errors: string[] };
    assert.equal(body.error, 'validation_error');
    assert.match(body.errors[0], /at least 12 characters/);
  });

  it('refuses a username the database CHECK would refuse', async () => {
    const response = await raw('POST', '/api/auth/users', {
      body: { username: 'Itest-Capitals', password: PLAIN_PASSWORD },
    });

    assert.equal(response.status, 400);
  });

  it('refuses a plain user who tries to manage users', async () => {
    await login(PLAIN_USERNAME, PLAIN_PASSWORD);

    const added = await raw('POST', '/api/auth/users', {
      body: { username: 'itest-intruder', password: PLAIN_PASSWORD },
    });
    const removed = await raw('DELETE', `/api/auth/users/${adminId}`);

    assert.equal(added.status, 403);
    assert.equal((added.body as { error: string }).error, 'admin_required');
    assert.equal(removed.status, 403);
    // But the list itself is open to anyone signed in.
    assert.equal((await raw('GET', '/api/auth/users')).status, 200);
  });

  it('lets anyone sign themselves out everywhere', async () => {
    const response = await raw('POST', `/api/auth/users/${plainId}/revoke`);
    assert.equal(response.status, 204);

    // The cookie it was holding is one of the sessions that just went.
    assert.equal((await raw('GET', '/api/streams')).status, 401);
  });

  it('refuses to remove yourself, and refuses the last admin', async () => {
    await login();

    const self = await raw('DELETE', `/api/auth/users/${adminId}`);
    assert.equal(self.status, 409);
    assert.equal(
      (self.body as { error: string }).error,
      'cannot_remove_user',
    );
  });

  it('answers 404 for an id that is not a user, 400 for one that is not a UUID', async () => {
    const missing = await raw(
      'DELETE',
      '/api/auth/users/00000000-0000-4000-8000-999999999999',
    );
    const malformed = await raw('DELETE', '/api/auth/users/17');

    assert.equal(missing.status, 404);
    assert.equal((missing.body as { error: string }).error, 'user_not_found');
    assert.equal(malformed.status, 400);
  });

  it('removes the plain user, and their sessions with them', async () => {
    const response = await raw('DELETE', `/api/auth/users/${plainId}`);

    assert.equal(response.status, 204);
    assert.equal((await users()).length, 1);
  });
});

describe('changing your own password', () => {
  const NEXT_PASSWORD = 'a-changed-integration-password';

  it('keeps this session, drops the others, and takes the new password', async () => {
    // The other browser signs in first, because `raw` keeps one cookie jar:
    // whichever session signed in last is the one the jar holds, and the one
    // making the change has to be the other.
    const elsewhere = await raw('POST', '/api/auth/login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
      anonymous: true,
    });
    const otherCookie = (elsewhere.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(otherCookie);
    await login();
    assert.notEqual(sessionCookie(), otherCookie, 'two distinct sessions');

    const changed = await api<MeResponse>('POST', '/api/auth/password', {
      body: { currentPassword: ADMIN_PASSWORD, newPassword: NEXT_PASSWORD },
    });
    assert.ok(changed.user.passwordChangedAt);

    // This session still works; the other one is gone.
    assert.equal((await raw('GET', '/api/streams')).status, 200);
    const other = await raw('GET', '/api/streams', {
      anonymous: true,
      headers: { cookie: otherCookie },
    });
    assert.equal(other.status, 401);

    await login(ADMIN_USERNAME, NEXT_PASSWORD);
  });

  it('refuses a wrong current password, and a new one the policy refuses', async () => {
    const wrong = await raw('POST', '/api/auth/password', {
      body: { currentPassword: 'not-it-at-all', newPassword: ADMIN_PASSWORD },
    });
    assert.equal(wrong.status, 401);
    assert.equal(
      (wrong.body as { error: string }).error,
      'invalid_credentials',
    );

    const weak = await raw('POST', '/api/auth/password', {
      body: { currentPassword: NEXT_PASSWORD, newPassword: 'short' },
    });
    assert.equal(weak.status, 400);

    // Put it back, so the rest of this process can sign in as it started.
    await login(ADMIN_USERNAME, NEXT_PASSWORD);
    await api('POST', '/api/auth/password', {
      body: { currentPassword: NEXT_PASSWORD, newPassword: ADMIN_PASSWORD },
    });
  });
});

// Last, and nothing may sign in after it: the client address is one of the
// keys the limiter counts on, and every request in this process comes from the
// same one.
describe('the lockout, as an operator meets it', () => {
  it('locks after the fifth wrong password and says for how long', async () => {
    forgetCookie();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await raw('POST', '/api/auth/login', {
        body: { username: ADMIN_USERNAME, password: 'definitely-not-it' },
      });
      assert.equal(response.status, 401, `attempt ${attempt}`);
    }

    const locked = await raw('POST', '/api/auth/login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });

    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '60');
    assert.deepEqual(locked.body, {
      error: 'too_many_attempts',
      retryAfterSeconds: 60,
    });
  });
});
