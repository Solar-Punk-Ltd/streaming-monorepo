/**
 * How a password is stored. Unit test — no database, no network.
 *
 * The properties worth pinning are the ones that stop being obvious the moment
 * someone edits the parameters: that a hash still verifies, that a wrong
 * password never does, that the cost parameters are read back from the stored
 * string rather than from today's constants — which is what lets them be raised
 * without invalidating everyone's password, and is exactly what this port did
 * to a live database — and that hashing the same password twice never gives the
 * same string, because the salt is fresh each time.
 */
import assert from 'node:assert/strict';
import { scrypt } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  CURRENT_PARAMS,
  hashPassword,
  paramsOf,
  verifyPassword,
} from '../../src/domain/auth/passwordHash.js';

const PASSWORD = 'a-long-enough-password';

describe('password hashing', () => {
  it('verifies the password it was made from', async () => {
    const stored = await hashPassword(PASSWORD);
    assert.equal(await verifyPassword(PASSWORD, stored), true);
  });

  it('refuses a wrong password', async () => {
    const stored = await hashPassword(PASSWORD);

    for (const wrong of [
      `${PASSWORD} `,
      PASSWORD.toUpperCase(),
      PASSWORD.slice(0, -1),
      '',
    ]) {
      assert.equal(
        await verifyPassword(wrong, stored),
        false,
        `should refuse ${JSON.stringify(wrong)}`,
      );
    }
  });

  it('records the parameters it used', async () => {
    const stored = await hashPassword(PASSWORD);
    const [, , , , salt, key] = stored.split('$');

    assert.match(stored, /^scrypt\$32768\$8\$3\$/);
    assert.deepEqual(paramsOf(stored), CURRENT_PARAMS);
    assert.deepEqual(CURRENT_PARAMS, { N: 2 ** 15, r: 8, p: 3 });
    assert.equal(Buffer.from(salt!, 'base64').length, 32);
    assert.equal(Buffer.from(key!, 'base64').length, 64);
  });

  it('still verifies a hash written with the old parameters', async () => {
    // This backend's first release wrote N=16384, r=8, p=1 with a 16 byte salt
    // and a 32 byte key. Those rows are in the running database; raising the
    // cost must not lock anybody out of the account they already have.
    const old = await legacyHash(PASSWORD);

    assert.match(old, /^scrypt\$16384\$8\$1\$/);
    assert.deepEqual(paramsOf(old), { N: 16_384, r: 8, p: 1 });
    assert.equal(await verifyPassword(PASSWORD, old), true);
    assert.equal(await verifyPassword('not-the-password', old), false);
  });

  it('honours the stored parameters, not the current ones', async () => {
    // Written with a cheaper cost than CURRENT_PARAMS, the way an old hash
    // would read after the parameters are raised.
    const cheap = 'scrypt$1024$8$1$';
    const stored = await hashPassword(PASSWORD);
    const fields = stored.split('$');
    const rewritten = `${cheap}${fields[4]}$${fields[5]}`;

    assert.deepEqual(paramsOf(rewritten), { N: 1024, r: 8, p: 1 });
    // The key was derived with the expensive parameters, so verifying it with
    // the cheap ones must fail: the parameters really are being read.
    assert.equal(await verifyPassword(PASSWORD, rewritten), false);
  });

  it('salts every hash, so the same password stores differently', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    assert.notEqual(first, second);
    assert.equal(await verifyPassword(PASSWORD, second), true);
  });

  it('never contains the password', async () => {
    const stored = await hashPassword(PASSWORD);
    assert.equal(stored.includes(PASSWORD), false);
  });

  it('refuses an unreadable stored value instead of letting anyone in', async () => {
    const unreadable = [
      '',
      'not-a-hash',
      'scrypt$8$1$salt$key',
      'argon2$32768$8$3$c2FsdA==$a2V5',
      'scrypt$0$8$3$c2FsdA==$a2V5',
      'scrypt$32768$8$3$$a2V5',
    ];

    for (const stored of unreadable) {
      assert.equal(
        await verifyPassword(PASSWORD, stored),
        false,
        `should refuse ${JSON.stringify(stored)}`,
      );
      assert.equal(paramsOf(stored), null);
    }
  });
});

/** A row exactly as the pre-port hashPassword would have written it. */
function legacyHash(password: string): Promise<string> {
  const salt = Buffer.alloc(16, 7);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else {
        resolve(
          ['scrypt', 16_384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$'),
        );
      }
    });
  });
}
