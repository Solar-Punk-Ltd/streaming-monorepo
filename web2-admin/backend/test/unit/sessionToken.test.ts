/**
 * Session tokens. Unit test — no database.
 *
 * The cookie value never reaches the database; only its sha256 does. These
 * pin that, the token's entropy, and the expiry arithmetic AuthService uses.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  createSessionToken,
  hashSessionToken,
  isSessionActive,
  sessionExpiresAt,
} from '../../src/domain/sessionToken.js';

describe('session tokens', () => {
  it('mints 32 random bytes as hex', () => {
    const token = createSessionToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, createSessionToken());
  });

  it('hashes with sha256, and the hash is not the token', () => {
    const token = createSessionToken();
    const hash = hashSessionToken(token);
    assert.equal(hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(hash, token);
    assert.equal(hashSessionToken(token), hash, 'stable for the same token');
  });

  it('expires ttlHours after the given moment', () => {
    const now = new Date('2026-09-11T10:00:00.000Z');
    assert.equal(
      sessionExpiresAt(now, 24).toISOString(),
      '2026-09-12T10:00:00.000Z',
    );
    assert.equal(
      sessionExpiresAt(now, 0.5).toISOString(),
      '2026-09-11T10:30:00.000Z',
    );
  });

  it('is active until the expiry moment, not after it', () => {
    const expires = new Date('2026-09-12T10:00:00.000Z');
    assert.equal(
      isSessionActive(expires, new Date('2026-09-12T09:59:59.999Z')),
      true,
    );
    assert.equal(isSessionActive(expires, expires), false);
    assert.equal(
      isSessionActive(expires, new Date('2026-09-12T10:00:00.001Z')),
      false,
    );
  });
});
