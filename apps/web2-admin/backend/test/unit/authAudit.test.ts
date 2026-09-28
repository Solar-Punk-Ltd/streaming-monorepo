/**
 * What managing users leaves in the audit log. Unit test — the users, sessions
 * and audit log in memory. `pnpm test`.
 *
 * Each entry names the acting user and the one acted on, by id and by
 * username, so it still reads once either account is gone. None of them
 * carries a password, a hash or a session token.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthService } from '../../src/domain/auth/AuthService.js';

import {
  actorFor,
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import { call, signIn, startAuthTestApp } from './support/authTestApp.js';
import { InMemoryAuditLog } from './support/fakes.js';

const PASSWORD = 'a-long-enough-password';
const OTHER_PASSWORD = 'another-fine-password';
const NEW_PASSWORD = 'a-brand-new-password';

const CLI = { kind: 'system', reason: 'cli' } as const;

async function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const audit = new InMemoryAuditLog();
  const auth = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  const ann = await auth.addUser(CLI, 'ann', PASSWORD);
  const bob = await auth.addUser(actorFor(ann), 'bob', OTHER_PASSWORD);
  return { users, auth, audit, ann, bob };
}

describe('AuthService audit', () => {
  it('records the CLI adding the first user as the system, and an operator adding the next', async () => {
    const { audit, ann, bob } = await setup();

    assert.deepEqual(audit.entries, [
      {
        actor: CLI,
        action: 'user.add',
        details: { userId: ann.id, username: 'ann', isAdmin: true },
      },
      {
        actor: { kind: 'operator', userId: ann.id, username: 'ann' },
        action: 'user.add',
        details: { userId: bob.id, username: 'bob', isAdmin: false },
      },
    ]);
  });

  it('records who removed whom, by name as well as id', async () => {
    const { auth, audit, ann, bob } = await setup();
    audit.entries.length = 0;

    await auth.removeUser(actorFor(ann), bob.id);

    assert.deepEqual(audit.entries, [
      {
        actor: actorFor(ann),
        action: 'user.remove',
        details: { userId: bob.id, username: 'bob' },
      },
    ]);
  });

  it('records a revoke with the acting user and the target', async () => {
    const { users, auth, audit, ann, bob } = await setup();
    audit.entries.length = 0;

    await auth.revokeSessions(bob.id, (await users.findById(ann.id))!);

    assert.deepEqual(audit.entries, [
      {
        actor: actorFor(ann),
        action: 'user.sessions.revoke',
        details: { userId: bob.id, username: 'bob' },
      },
    ]);
  });

  it('records a password change as the user themselves, with nothing secret in it', async () => {
    const { auth, audit, bob } = await setup();
    const signedIn = await auth.signIn({ username: 'bob', password: OTHER_PASSWORD, ip: '127.0.0.1', userAgent: null });
    const session = (await auth.sessionFor(signedIn.token))!;
    audit.entries.length = 0;

    await auth.changePassword(session, OTHER_PASSWORD, NEW_PASSWORD);

    assert.deepEqual(audit.entries, [
      {
        actor: actorFor(bob),
        action: 'user.password.change',
        details: { userId: bob.id, username: 'bob' },
      },
    ]);
    const recorded = JSON.stringify(audit.entries);
    for (const secret of [OTHER_PASSWORD, NEW_PASSWORD, signedIn.token, session.tokenHash, 'scrypt']) {
      assert.ok(!recorded.includes(secret), `no ${secret} in the entry`);
    }
  });

  it('records nothing for a removal it refused', async () => {
    const { auth, audit, ann } = await setup();
    audit.entries.length = 0;

    await assert.rejects(() => auth.removeUser(actorFor(ann), ann.id));

    assert.deepEqual(audit.entries, []);
  });

  it('still adds the user when the audit write fails', async () => {
    const { users, auth, audit, ann } = await setup();
    audit.failNextWrite = new Error('connection terminated');

    const carol = await auth.addUser(actorFor(ann), 'carol', PASSWORD);

    assert.equal((await users.findById(carol.id))?.username, 'carol');
  });
});

/**
 * The same entries, reached over HTTP: the Access page's routes hand the
 * service the user of the session, so the entry names whoever is signed in.
 */
describe('the user routes', () => {
  it('record the signed-in admin as the actor of POST and DELETE /api/auth/users', async () => {
    const app = await startAuthTestApp();
    try {
      const ann = await app.authService.addUser(TEST_SETUP, 'ann', PASSWORD);
      const { cookie } = await signIn(app, 'ann', PASSWORD);
      app.audit.entries.length = 0;

      const added = await call(app, 'POST', '/api/auth/users', {
        cookie,
        body: { username: 'bob', password: OTHER_PASSWORD },
      });
      assert.equal(added.status, 201);
      const bobId = (added.body as { id: string }).id;
      const removed = await call(app, 'DELETE', `/api/auth/users/${bobId}`, { cookie });
      assert.equal(removed.status, 204);

      const operator = { kind: 'operator', userId: ann.id, username: 'ann' };
      assert.deepEqual(
        app.audit.entries.map(({ actor, action, details }) => ({ actor, action, details })),
        [
          { actor: operator, action: 'user.add', details: { userId: bobId, username: 'bob', isAdmin: false } },
          { actor: operator, action: 'user.remove', details: { userId: bobId, username: 'bob' } },
        ],
      );
    } finally {
      await app.close();
    }
  });
});
