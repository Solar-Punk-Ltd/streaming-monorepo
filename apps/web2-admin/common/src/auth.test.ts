/**
 * The admin's sign-in values, and the rules it takes from the shared web-auth
 * package.
 *
 * The rules themselves are pinned in that package. What is pinned here is that
 * the backend and the console read those same rules under the names they
 * always had, and that the two values only the admin uses stay its own: a
 * browser signed in to it holds a cookie by this name, and its console sends
 * this header value on every write.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as rules from '@streaming-monorepo/web-auth/rules';

import * as auth from './auth.js';

const SHARED_RULES = [
  'PASSWORD_MIN_LENGTH',
  'PASSWORD_MAX_LENGTH',
  'passwordProblem',
  'USERNAME_RE',
  'USERNAME_MAX_LENGTH',
  'USERNAME_MESSAGE',
  'usernameProblem',
  'REQUESTED_WITH_HEADER',
  'SESSION_IDLE_TIMEOUT_MS',
  'SESSION_ABSOLUTE_TIMEOUT_MS',
  'LAST_SEEN_REFRESH_MS',
  'LOGIN_FREE_ATTEMPTS',
  'LOGIN_FIRST_LOCKOUT_MS',
  'LOGIN_MAX_LOCKOUT_MS',
  'LOGIN_FORGET_MS',
  'lockoutMsFor',
] as const;

describe('the admin sign-in values', () => {
  it('reads every shared rule from the web-auth package, under its old name', () => {
    for (const name of SHARED_RULES) {
      assert.equal(auth[name], rules[name], name);
    }
  });

  it('keeps its own session cookie name', () => {
    assert.equal(auth.SESSION_COOKIE_NAME, 'web2_admin_session');
  });

  it('keeps its own request header value', () => {
    assert.equal(auth.REQUESTED_WITH_HEADER, 'x-requested-with');
    assert.equal(auth.REQUESTED_WITH_VALUE, 'web2-admin');
  });
});
