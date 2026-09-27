/**
 * User removal against the real SQL, which is the only place it can be tested.
 *
 * `deleteUnlessLast` counts the users and deletes in one transaction under
 * `pg_advisory_xact_lock`, and the whole reason for that is a race no fake can
 * reproduce: two people removing each other at the same moment both read two
 * users, both decide the other is not the last one, and both delete — leaving a
 * console nobody can sign in to. The same shape holds for the last user who can
 * manage users. Both are exercised here by running the two removals together
 * against Postgres.
 *
 * It uses the suite's own throwaway instance (see instance.ts), so no row of
 * the development database is ever touched.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { PostgresUserRepository } from '../../src/domain/auth/PostgresUserRepository.js';
import { Database } from '../../src/domain/Database.js';

import { releaseStack, requireStack, stack } from './helpers.js';

/** Not a real hash, and nothing here ever verifies one. */
const HASH = 'scrypt$32768$8$3$c2FsdA==$a2V5';

const FORGET_USER = 'DELETE FROM users WHERE id = $1';

let database: Database;
let users: PostgresUserRepository;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  users = new PostgresUserRepository(database.pool);
});

after(async () => {
  await database?.close();
  await releaseStack();
});

/** A short, lower-case name the users_username_format CHECK accepts. */
function name(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Runs `body` with these extra users, and takes them away again afterwards. */
async function withUsers<T>(
  rows: readonly { username: string; admin: boolean }[],
  body: (ids: string[]) => Promise<T>,
): Promise<T> {
  const existing = await users.list();
  const ids: string[] = [];
  for (const row of rows) {
    const inserted = await users.insert(row.username, HASH, row.admin);
    assert.ok(inserted, `could not insert ${row.username}`);
    ids.push(inserted.id);
  }
  try {
    return await body(ids);
  } finally {
    for (const row of await users.list()) {
      if (existing.some((kept) => kept.id === row.id)) continue;
      await database.pool.query(FORGET_USER, [row.id]);
    }
  }
}

describe('removing a user', () => {
  it('refuses the removal that would empty the table', async () => {
    const original = await users.list();
    assert.equal(original.length, 1, 'the suite starts with one user');

    await withUsers(
      [
        { username: name('itest-ann'), admin: true },
        { username: name('itest-bob'), admin: true },
      ],
      async ([ann, bob]) => {
        // The instance's own admin steps aside, or there is always a third
        // user and neither removal is ever the last one.
        await database.pool.query(FORGET_USER, [original[0]!.id]);

        const outcomes = await Promise.all([users.deleteUnlessLast(ann!), users.deleteUnlessLast(bob!)]);

        assert.equal(
          outcomes.filter((outcome) => outcome === 'deleted').length,
          1,
          `exactly one removal may go through, got ${outcomes.join(' and ')}`,
        );
        assert.ok(outcomes.includes('last'));
        assert.equal((await users.list()).length, 1);
      },
    );

    // Put the sign-in account back for whatever runs next in this process.
    await users.insert(original[0]!.username, original[0]!.password_hash, true);
  });

  it('refuses the last user who can manage users', async () => {
    await withUsers(
      [
        { username: name('itest-plain'), admin: false },
        { username: name('itest-other'), admin: false },
      ],
      async () => {
        const admin = (await users.list()).find((row) => row.is_admin);
        assert.ok(admin, 'the instance admin is still there');

        assert.equal(await users.deleteUnlessLast(admin.id), 'last_admin');
        assert.ok(await users.findById(admin.id), 'and it is still there');
      },
    );
  });

  it('says missing for an id nobody has', async () => {
    assert.equal(await users.deleteUnlessLast('00000000-0000-4000-8000-999999999999'), 'missing');
  });
});
