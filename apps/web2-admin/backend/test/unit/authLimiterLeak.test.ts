/**
 * An error between the limiter's reservation and the attempt's outcome settles the attempt: it is counted as neither
 * a failure nor left pending. A pending attempt counts towards the lockout and is never forgotten, so before this a
 * database that failed five times locked that account, and that address, until the backend restarted. Unit test, the
 * stores in memory. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthService, type SessionInfo } from '../../src/domain/auth/AuthService.js';
import type { UserRow } from '../../src/types/index.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { InMemoryAuditLog } from './support/fakes.js';

const PASSWORD = 'a-long-enough-password';
const IP = '192.0.2.10';

async function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const auth = new AuthService(
    users,
    sessions,
    new InMemoryCredentialRepository(users, sessions),
    new InMemoryAuditLog(),
  );
  await auth.addUser(TEST_SETUP, 'leaky', PASSWORD);
  const user = (await users.findByUsername('leaky'))!;
  return { users, auth, user };
}

/** Makes `method` of `target` throw `times` times, then answer as before. */
function failing<T extends object, K extends keyof T>(target: T, method: K, times: number): Error {
  const failure = new Error('the database went away');
  const real = (target[method] as (...args: unknown[]) => unknown).bind(target);
  let left = times;
  (target as Record<K, unknown>)[method] = async (...args: unknown[]) => {
    if (left-- > 0) throw failure;
    return real(...args);
  };
  return failure;
}

function sessionOf(user: UserRow): SessionInfo {
  return { user, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000) };
}

describe('an error after the limiter reserved an attempt', () => {
  it('leaves sign-in open: five failed lookups, then the right password signs in', async () => {
    const { users, auth } = await setup();
    const failure = failing(users, 'findByUsername', 5);

    for (let n = 0; n < 5; n++) {
      await assert.rejects(
        auth.signIn({ username: 'leaky', password: PASSWORD, ip: IP, userAgent: null }),
        (error: unknown) => error === failure,
        `attempt ${n + 1} is the store's own error`,
      );
    }

    const signedIn = await auth.signIn({ username: 'leaky', password: PASSWORD, ip: IP, userAgent: null });
    assert.equal(signedIn.user.username, 'leaky');
  });

  it('leaves a confirmation open: five failed reads, then the right password confirms', async () => {
    const { users, auth, user } = await setup();
    const failure = failing(users, 'findById', 5);

    for (let n = 0; n < 5; n++) {
      await assert.rejects(
        auth.confirmPassword(sessionOf(user), PASSWORD, 'a test confirmation', IP),
        (error: unknown) => error === failure,
        `attempt ${n + 1} is the store's own error`,
      );
    }

    const confirmed = await auth.confirmPassword(sessionOf(user), PASSWORD, 'a test confirmation', IP);
    assert.equal(confirmed.id, user.id);
    // And sign-in, which shares the key, was never locked by them either.
    assert.equal(
      (await auth.signIn({ username: 'leaky', password: PASSWORD, ip: IP, userAgent: null })).user.username,
      'leaky',
    );
  });
});
