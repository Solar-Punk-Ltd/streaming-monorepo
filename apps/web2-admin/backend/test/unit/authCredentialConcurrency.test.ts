/**
 * A password is verified outside any transaction, because scrypt is slow, so the
 * stored hash can move between the check and the write it admits. These pin
 * that the write refuses when it did: a sign-in with a password its owner has
 * just replaced opens no session, and of two password changes verified against
 * the same old password only the first lands. The Postgres half, where the row
 * lock does the work, is test/integration/authCredentialConcurrency.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyPassword } from '@streaming-monorepo/web-auth';

import { AuthService, type SessionInfo } from '../../src/domain/auth/AuthService.js';
import type { CredentialRepository } from '../../src/domain/auth/CredentialRepository.js';
import type { UserRow } from '../../src/types/index.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { InMemoryAuditLog } from './support/fakes.js';

const OLD_PASSWORD = 'a-long-current-password';
const FIRST_PASSWORD = 'a-long-winning-password';
const SECOND_PASSWORD = 'a-long-losing-password';

function signal() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function sessionOf(user: UserRow): SessionInfo {
  return { user, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000) };
}

/** Holds each password change at the door until the test lets it through, in the order it chooses. */
class OrderedCredentialRepository implements CredentialRepository {
  readonly entered = [signal(), signal()];
  readonly release = [signal(), signal()];
  private calls = 0;

  constructor(private readonly inner: CredentialRepository) {}

  admitSession(...args: Parameters<CredentialRepository['admitSession']>) {
    return this.inner.admitSession(...args);
  }

  async changePassword(...args: Parameters<CredentialRepository['changePassword']>) {
    const call = this.calls++;
    this.entered[call]!.resolve();
    await this.release[call]!.promise;
    return this.inner.changePassword(...args);
  }
}

function fixtures() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const credentials = new InMemoryCredentialRepository(users, sessions);
  return { users, sessions, credentials };
}

describe('password verification and credential writes', () => {
  it('does not admit a sign-in with a password replaced after it was verified', async () => {
    const { users, sessions, credentials } = fixtures();
    const auth = new AuthService(users, sessions, credentials, new InMemoryAuditLog());
    await auth.addUser(TEST_SETUP, 'owner', OLD_PASSWORD);
    const owner = (await users.findByUsername('owner'))!;

    const verified = signal();
    const resume = signal();
    const deleteExpired = sessions.deleteExpired.bind(sessions);
    sessions.deleteExpired = async (...args) => {
      verified.resolve();
      await resume.promise;
      return deleteExpired(...args);
    };

    const staleSignIn = auth.signIn({ username: 'owner', password: OLD_PASSWORD, ip: '127.0.0.1', userAgent: 'test' });
    await verified.promise;
    await auth.changePassword(sessionOf(owner), OLD_PASSWORD, FIRST_PASSWORD);
    resume.resolve();

    await assert.rejects(staleSignIn);
    assert.equal(sessions.size(), 0);
  });

  it('does not let a second password change, verified against the old one, overwrite the first', async () => {
    const { users, sessions, credentials: inner } = fixtures();
    const credentials = new OrderedCredentialRepository(inner);
    const auth = new AuthService(users, sessions, credentials, new InMemoryAuditLog());
    await auth.addUser(TEST_SETUP, 'owner', OLD_PASSWORD);
    const owner = sessionOf((await users.findByUsername('owner'))!);

    const winner = auth.changePassword(owner, OLD_PASSWORD, FIRST_PASSWORD);
    await credentials.entered[0]!.promise;
    const stale = auth.changePassword(owner, OLD_PASSWORD, SECOND_PASSWORD);
    await credentials.entered[1]!.promise;
    credentials.release[0]!.resolve();
    await winner;
    credentials.release[1]!.resolve();

    await assert.rejects(stale);
    const stored = (await users.findByUsername('owner'))!;
    assert.equal(await verifyPassword(FIRST_PASSWORD, stored.password_hash), true);
    assert.equal(await verifyPassword(SECOND_PASSWORD, stored.password_hash), false);
  });
});
