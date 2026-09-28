/**
 * The password compare-and-set against the real SQL. A password is verified
 * outside any transaction, because scrypt is slow, so every write it admits
 * reads the stored hash again under the user's row lock and refuses if it
 * moved. Two races depend on it: a sign-in with a password its owner has just
 * replaced, and two password changes verified against the same old password.
 *
 * The first two cases run each race through the auth service on Postgres. The
 * last two hold the row lock by hand, the way the manager's database test does,
 * so the refusal is proven while the second writer is actually waiting on the
 * lock rather than after it.
 *
 * It uses the suite's own throwaway instance (see instance.ts), and every user
 * it adds goes again afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { verifyPassword } from '@streaming-monorepo/web-auth';
import type { Pool } from 'pg';

import { AuthService, type SessionInfo } from '../../src/domain/auth/AuthService.js';
import type { CredentialRepository } from '../../src/domain/auth/CredentialRepository.js';
import { PostgresCredentialRepository } from '../../src/domain/auth/PostgresCredentialRepository.js';
import { PostgresSessionRepository } from '../../src/domain/auth/PostgresSessionRepository.js';
import { PostgresUserRepository } from '../../src/domain/auth/PostgresUserRepository.js';
import type { Actor } from '../../src/domain/actor.js';
import { Database } from '../../src/domain/Database.js';
import { PostgresAuditLog } from '../../src/domain/PostgresAuditLog.js';
import type { UserRow } from '../../src/types/index.js';

import { releaseStack, requireStack, stack } from './helpers.js';

const OLD_PASSWORD = 'a-long-current-password';
const FIRST_PASSWORD = 'a-long-winning-password';
const SECOND_PASSWORD = 'a-long-losing-password';
const SIGNAL_TIMEOUT_MS = 2_000;
/** Who adds the users these tests start from: nobody signed in, like the CLI. */
const TEST_SETUP: Actor = { kind: 'system', reason: 'test' };

let database: Database;
let users: PostgresUserRepository;
let sessions: PostgresSessionRepository;
let credentials: PostgresCredentialRepository;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  users = new PostgresUserRepository(database.pool);
  sessions = new PostgresSessionRepository(database.pool);
  credentials = new PostgresCredentialRepository(database.pool);
});

after(async () => {
  await database?.close();
  await releaseStack();
});

function signal<T = void>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), SIGNAL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Waits until the backend `pid` is blocked on somebody else's lock. */
async function untilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await database.pool.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
      [pid],
    );
    if (rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the credential write never waited for the user row lock');
}

/** The pool, with `hook` around every statement its clients run and the backend pid each client is. */
function instrumentPool(hook: (text: string, pid: number, run: () => Promise<unknown>) => Promise<unknown>): Pool {
  const pool = database.pool;
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      return {
        release: () => client.release(),
        query: (text: string, values?: unknown[]) => hook(text, pid, () => client.query(text, values)),
      };
    },
  } as unknown as Pool;
}

/** Runs `body` with a user of its own, signed in nowhere, and removes it afterwards. */
async function withOwner(
  body: (auth: AuthService, owner: UserRow) => Promise<void>,
  repository: CredentialRepository = credentials,
) {
  const auth = new AuthService(users, sessions, repository, new PostgresAuditLog(database.pool));
  const added = await auth.addUser(TEST_SETUP, `itest-${randomUUID().slice(0, 8)}`, OLD_PASSWORD);
  try {
    await body(auth, (await users.findById(added.id))!);
  } finally {
    await database.pool.query('DELETE FROM users WHERE id = $1', [added.id]);
  }
}

function sessionOf(user: UserRow): SessionInfo {
  return { user, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000) };
}

async function sessionsOf(userId: string): Promise<number> {
  return (await database.pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [userId])).rowCount ?? 0;
}

async function storedHash(userId: string): Promise<string> {
  return (await users.findById(userId))!.password_hash;
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

describe('password verification and credential writes, on Postgres', () => {
  it('does not admit a sign-in with a password replaced after it was verified', async () => {
    await withOwner(async (auth, owner) => {
      const verified = signal();
      const resume = signal();
      const deleteExpired = sessions.deleteExpired.bind(sessions);
      sessions.deleteExpired = async (...args) => {
        verified.resolve();
        await resume.promise;
        return deleteExpired(...args);
      };
      try {
        const staleSignIn = auth.signIn({
          username: owner.username,
          password: OLD_PASSWORD,
          ip: '127.0.0.1',
          userAgent: 'test',
        });
        await bounded(verified.promise, 'the stale sign-in to verify');
        await auth.changePassword(sessionOf(owner), OLD_PASSWORD, FIRST_PASSWORD);
        resume.resolve();

        await assert.rejects(staleSignIn);
        assert.equal(await sessionsOf(owner.id), 0);
      } finally {
        sessions.deleteExpired = deleteExpired;
      }
    });
  });

  it('does not let a second password change, verified against the old one, overwrite the first', async () => {
    const ordered = new OrderedCredentialRepository(credentials);
    await withOwner(async (auth, owner) => {
      const winner = auth.changePassword(sessionOf(owner), OLD_PASSWORD, FIRST_PASSWORD);
      await bounded(ordered.entered[0]!.promise, 'the first change');
      const stale = auth.changePassword(sessionOf(owner), OLD_PASSWORD, SECOND_PASSWORD);
      await bounded(ordered.entered[1]!.promise, 'the second change');
      ordered.release[0]!.resolve();
      await winner;
      ordered.release[1]!.resolve();

      await assert.rejects(stale);
      assert.equal(await verifyPassword(FIRST_PASSWORD, await storedHash(owner.id)), true);
      assert.equal(await verifyPassword(SECOND_PASSWORD, await storedHash(owner.id)), false);
    }, ordered);
  });

  it('refuses a session once a password replacement it waited on has committed', async () => {
    await withOwner(async (_auth, owner) => {
      const blocker = await database.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query("UPDATE users SET password_hash = 'replaced' WHERE id = $1", [owner.id]);
        const waiting = signal<number>();
        const repository = new PostgresCredentialRepository(
          instrumentPool(async (text, pid, run) => {
            if (/SELECT password_hash/.test(text)) waiting.resolve(pid);
            return run();
          }),
        );
        const admitted = repository.admitSession(
          owner.id,
          owner.password_hash,
          {
            tokenHash: 'a'.repeat(64),
            userId: owner.id,
            expiresAt: new Date(Date.now() + 60_000),
            ip: null,
            userAgent: null,
          },
          new Date(),
        );

        await untilBlocked(await bounded(waiting.promise, 'the admission to read the hash'));
        await blocker.query('COMMIT');

        assert.equal(await admitted, false);
        assert.equal(await sessionsOf(owner.id), 0);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
    });
  });

  it('serialises two replacements on the row lock and refuses the one verified against the old hash', async () => {
    await withOwner(async (_auth, owner) => {
      const entered = signal();
      const release = signal();
      const first = new PostgresCredentialRepository(
        instrumentPool(async (text, _pid, run) => {
          const result = await run();
          if (/SELECT password_hash/.test(text)) {
            entered.resolve();
            await release.promise;
          }
          return result;
        }),
      );
      const waiting = signal<number>();
      const second = new PostgresCredentialRepository(
        instrumentPool(async (text, pid, run) => {
          if (/SELECT password_hash/.test(text)) waiting.resolve(pid);
          return run();
        }),
      );

      const winner = first.changePassword(owner.id, owner.password_hash, 'winner-hash', 'a'.repeat(64));
      let stale: Promise<boolean> | undefined;
      try {
        await bounded(entered.promise, 'the winning replacement to take the lock');
        stale = second.changePassword(owner.id, owner.password_hash, 'stale-hash', 'b'.repeat(64));
        await untilBlocked(await bounded(waiting.promise, 'the stale replacement to read the hash'));
      } finally {
        release.resolve();
      }

      assert.equal(await winner, true);
      assert.equal(await stale, false);
      assert.equal(await storedHash(owner.id), 'winner-hash');
    });
  });
});
