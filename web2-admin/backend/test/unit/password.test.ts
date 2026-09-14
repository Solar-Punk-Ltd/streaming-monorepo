/**
 * Password hashing. Unit test — no database, no network. `pnpm test`.
 *
 * The stored format carries its own scrypt parameters, so the two things that
 * matter are that a hash verifies against the password it was made from and
 * nothing else, and that an old hash keeps verifying when the current cost
 * parameters change.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashPassword, verifyPassword } from '../../src/domain/password.js';

describe('password hashing', () => {
  it('round trips', async () => {
    const hash = await hashPassword('admin1234');
    assert.equal(await verifyPassword('admin1234', hash), true);
  });

  it('rejects a wrong password, including near misses', async () => {
    const hash = await hashPassword('admin1234');
    assert.equal(await verifyPassword('admin1235', hash), false);
    assert.equal(await verifyPassword('admin123', hash), false);
    assert.equal(await verifyPassword('', hash), false);
    assert.equal(await verifyPassword('ADMIN1234', hash), false);
  });

  it('is salted: the same password hashes differently every time', async () => {
    const first = await hashPassword('admin1234');
    const second = await hashPassword('admin1234');
    assert.notEqual(first, second);
    assert.equal(await verifyPassword('admin1234', second), true);
  });

  it('stores the parameters it used, in the documented format', async () => {
    const hash = await hashPassword('admin1234');
    const [algorithm, cost, blockSize, parallelisation, salt, key] =
      hash.split('$');
    assert.equal(algorithm, 'scrypt');
    assert.equal(cost, '16384');
    assert.equal(blockSize, '8');
    assert.equal(parallelisation, '1');
    assert.equal(Buffer.from(salt!, 'base64').length, 16);
    assert.equal(Buffer.from(key!, 'base64').length, 32);
  });

  it('verifies a hash written with different cost parameters', async () => {
    // What makes raising the cost later safe: verification follows the hash,
    // not today's constants.
    const cheap =
      'scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2Ex$' +
      (await deriveWith('admin1234', 'c2FsdHNhbHRzYWx0c2Ex', 1024));
    assert.equal(await verifyPassword('admin1234', cheap), true);
    assert.equal(await verifyPassword('nope', cheap), false);
  });

  it('throws on a stored value that is not a scrypt hash', async () => {
    await assert.rejects(
      () => verifyPassword('admin1234', 'not-a-hash'),
      /scrypt\$N\$r\$p\$salt\$hash/,
    );
  });
});

/** The same derivation node:crypto does, to build a fixture hash. */
async function deriveWith(
  password: string,
  saltB64: string,
  cost: number,
): Promise<string> {
  const { scrypt } = await import('node:crypto');
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(saltB64, 'base64'),
      32,
      { N: cost, r: 8, p: 1 },
      (err, key) => (err ? reject(err) : resolve(key.toString('base64'))),
    );
  });
}
