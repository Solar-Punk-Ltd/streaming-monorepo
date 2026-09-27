/**
 * Session tokens. Unit test — no database.
 *
 * The cookie value never reaches the database; only its sha256 does. These pin
 * that and the token's entropy. The two clocks that decide when a session is
 * over live in sessionLifetime.ts and are tested there.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { createSessionToken, hashSessionToken } from '../../src/domain/auth/sessionToken.js';

describe('session tokens', () => {
  it('mints 32 random bytes as base64url', () => {
    const token = createSessionToken();

    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.notEqual(token, createSessionToken());
  });

  it('hashes with sha256, and the hash is not the token', () => {
    const token = createSessionToken();
    const hash = hashSessionToken(token);

    assert.equal(hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(hash, token);
    assert.equal(hashSessionToken(token), hash, 'stable for the same token');
  });
});
