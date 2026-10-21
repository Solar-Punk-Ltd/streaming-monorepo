/**
 * The account's own password asked again, by the password change and by the funding confirmations, counts on the
 * account's confirmations from every address together besides the account at the request's address. A stolen session
 * moving between addresses gets four free failures in all, and the fifth locks every confirmation everywhere, while
 * the owner still signs in. A sign-in never counts on the confirmations, so guessing from outside cannot lock them.
 * Unit test, the stores in memory. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { confirmationKey, LoginLimiter } from '@streaming-monorepo/web-auth';

import { AuthService, type SessionInfo } from '../../src/domain/auth/AuthService.js';
import { InvalidCredentialsError, TooManyAttemptsError } from '../../src/domain/errors/index.js';
import type { UserRow } from '../../src/types/index.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { InMemoryAuditLog } from './support/fakes.js';

const PASSWORD = 'a-long-enough-password';
const WRONG = 'not-the-password-at-all';
const NEXT = 'a-brand-new-long-password';

async function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const limiter = new LoginLimiter();
  const auth = new AuthService(
    users,
    sessions,
    new InMemoryCredentialRepository(users, sessions),
    new InMemoryAuditLog(),
    limiter,
  );
  await auth.addUser(TEST_SETUP, 'owner', PASSWORD);
  const user = (await users.findByUsername('owner'))!;
  return { auth, user, limiter };
}

function sessionOf(user: UserRow): SessionInfo {
  return { user, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000) };
}

/** A fresh address for every call: no two share a /64 or an account-at-address count. */
function addressSource() {
  let n = 0;
  return () => `198.51.100.${++n}`;
}

describe("the account's confirmations from every address together", () => {
  it('give a stolen session four free failures across many addresses, and the fifth locks them everywhere', async () => {
    const { auth, user } = await setup();
    const session = sessionOf(user);
    const nextAddress = addressSource();

    // Four wrong ones from four addresses, the password change and the pin and send taking turns.
    await assert.rejects(auth.changePassword(session, WRONG, NEXT, nextAddress()), InvalidCredentialsError);
    await assert.rejects(auth.confirmPassword(session, WRONG, 'pin', nextAddress()), InvalidCredentialsError);
    await assert.rejects(auth.changePassword(session, WRONG, NEXT, nextAddress()), InvalidCredentialsError);
    await assert.rejects(auth.confirmPassword(session, WRONG, 'send', nextAddress()), InvalidCredentialsError);

    // The fifth, from a fifth address, is still let through and locks.
    await assert.rejects(auth.confirmPassword(session, WRONG, 'pin', nextAddress()), InvalidCredentialsError);

    // Now even the right password is refused from yet another address, by both kinds of confirmation.
    await assert.rejects(auth.confirmPassword(session, PASSWORD, 'send', nextAddress()), TooManyAttemptsError);
    await assert.rejects(auth.changePassword(session, PASSWORD, NEXT, nextAddress()), TooManyAttemptsError);

    // While the owner still signs in, from another address.
    const signedIn = await auth.signIn({ username: 'owner', password: PASSWORD, ip: nextAddress(), userAgent: null });
    assert.equal(signedIn.user.username, 'owner');
  });

  it('take back only their own attempt on a right password: the four failures before it still stand', async () => {
    const { auth, user, limiter } = await setup();
    const session = sessionOf(user);
    const nextAddress = addressSource();

    for (let n = 0; n < 4; n++) {
      await assert.rejects(auth.confirmPassword(session, WRONG, 'pin', nextAddress()), InvalidCredentialsError);
    }
    await auth.confirmPassword(session, PASSWORD, 'pin', nextAddress());

    assert.equal(limiter.retryAfterSeconds(confirmationKey(user.id)), 0);
    await assert.rejects(auth.confirmPassword(session, WRONG, 'pin', nextAddress()), InvalidCredentialsError);
    assert.equal(limiter.retryAfterSeconds(confirmationKey(user.id)), 60, 'the fifth failure in all locks them');
  });

  it('are never counted by a sign-in: forty wrong sign-ins from ten addresses leave them free', async () => {
    const { auth, user, limiter } = await setup();
    const nextAddress = addressSource();

    for (let a = 0; a < 10; a++) {
      const ip = nextAddress();
      for (let n = 0; n < 4; n++) {
        await assert.rejects(
          auth.signIn({ username: 'owner', password: WRONG, ip, userAgent: null }),
          InvalidCredentialsError,
        );
      }
    }

    assert.equal(limiter.retryAfterSeconds(confirmationKey(user.id)), 0);
    const confirmed = await auth.confirmPassword(sessionOf(user), PASSWORD, 'send', nextAddress());
    assert.equal(confirmed.id, user.id);
  });
});
