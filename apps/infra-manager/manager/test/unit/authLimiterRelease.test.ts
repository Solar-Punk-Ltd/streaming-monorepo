/**
 * An error between the limiter's reservation and the attempt's outcome gives the attempt back and forgives nothing:
 * the failures counted before it still stand, so a guesser cannot wipe their count by making a request fail. Unit
 * test, the stores in memory. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountAtAddressKey, LoginLimiter } from '@streaming-monorepo/web-auth';

import { AuthService, type SessionInfo } from '../../src/domain/auth/AuthService.js';
import { OpenStreams } from '../../src/domain/auth/OpenStreams.js';
import { InvalidCredentialsError, LockedOutError } from '../../src/domain/errors/index.js';
import { InMemoryCredentialRepository } from '../support/InMemoryCredentialRepository.js';
import { InMemorySessionRepository } from '../support/InMemorySessionRepository.js';
import { InMemoryUserRepository } from '../support/InMemoryUserRepository.js';

const PASSWORD = 'a-long-enough-password';
const WRONG = 'not-the-password-at-all';
const NEXT = 'a-brand-new-long-password';
const IP = '192.0.2.10';

async function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const limiter = new LoginLimiter();
  const auth = new AuthService(
    users,
    sessions,
    new InMemoryCredentialRepository(users, sessions),
    new OpenStreams(),
    limiter,
  );
  const added = await auth.addUser('guarded', PASSWORD);
  const session: SessionInfo = {
    user: { id: added.id, username: added.username, isAdmin: added.isAdmin },
    tokenHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
  };
  return { users, auth, session, limiter };
}

/** Makes `method` of `target` throw once, then answer as before. */
function failingOnce<T extends object, K extends keyof T>(target: T, method: K): Error {
  const failure = new Error('the database went away');
  const real = (target[method] as (...args: unknown[]) => unknown).bind(target);
  let left = 1;
  (target as Record<K, unknown>)[method] = async (...args: unknown[]) => {
    if (left-- > 0) throw failure;
    return real(...args);
  };
  return failure;
}

describe('an error after the limiter reserved an attempt', () => {
  it('keeps the sign-in failures counted before it: four wrong, an error, and the next wrong one locks', async () => {
    const { users, auth, limiter } = await setup();
    const signIn = (password: string) => auth.signIn({ username: 'guarded', password, ip: IP, userAgent: null });

    for (let n = 0; n < 4; n++) await assert.rejects(signIn(WRONG), InvalidCredentialsError);
    const failure = failingOnce(users, 'findByUsername');
    await assert.rejects(signIn(PASSWORD), (error: unknown) => error === failure);

    await assert.rejects(signIn(WRONG), InvalidCredentialsError, 'the fifth failure is still let through');
    // The address's own count locks here too, so the account at that address is read on its own: it holds five.
    assert.equal(limiter.retryAfterSeconds(accountAtAddressKey('guarded', IP)), 60);
    await assert.rejects(signIn(PASSWORD), LockedOutError);
  });

  it('keeps the password change failures counted before it: four wrong, an error, and the next wrong one locks', async () => {
    const { users, auth, session } = await setup();
    const change = (current: string) => auth.changePassword(session, current, NEXT);

    for (let n = 0; n < 4; n++) await assert.rejects(change(WRONG), InvalidCredentialsError);
    const failure = failingOnce(users, 'findById');
    await assert.rejects(change(PASSWORD), (error: unknown) => error === failure);

    await assert.rejects(change(WRONG), InvalidCredentialsError, 'the fifth failure is still let through');
    await assert.rejects(change(PASSWORD), LockedOutError, 'and it locks the password change');
  });
});
