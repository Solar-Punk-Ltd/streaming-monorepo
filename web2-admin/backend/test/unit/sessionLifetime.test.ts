/**
 * The session's two clocks. Unit test — no database, no server.
 *
 * A session ends at the earlier of an absolute deadline written once at sign-in
 * and a sliding idle limit measured from `last_seen_at`. Neither is visible by
 * reading a route, and getting either wrong is either a session that never ends
 * or one that ends while it is being used.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LAST_SEEN_REFRESH_MS,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
} from '@streaming-monorepo/web2-admin-common';

import {
  absoluteExpiryFrom,
  endsAt,
  hasExpired,
  idleSince,
  needsTouch,
} from '../../src/domain/auth/sessionLifetime.js';
import type { StoredSession } from '../../src/domain/auth/SessionRepository.js';

import { userRow } from './support/authFixtures.js';

const NOW = new Date('2026-09-18T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    tokenHash: 'x'.repeat(64),
    user: userRow(),
    createdAt: NOW,
    lastSeenAt: NOW,
    expiresAt: new Date(NOW.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS),
    ...over,
  };
}

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

describe('session lifetime', () => {
  it('is twelve hours idle and fourteen days absolute', () => {
    assert.equal(SESSION_IDLE_TIMEOUT_MS, 12 * HOUR_MS);
    assert.equal(SESSION_ABSOLUTE_TIMEOUT_MS, 14 * DAY_MS);
  });

  it('ends a fresh session on the idle clock, which is the earlier one', () => {
    assert.deepEqual(endsAt(session()), at(SESSION_IDLE_TIMEOUT_MS));
  });

  it('ends on the absolute deadline once it is the earlier one', () => {
    const nearlyOver = session({
      expiresAt: at(HOUR_MS),
      lastSeenAt: NOW,
    });

    assert.deepEqual(endsAt(nearlyOver), at(HOUR_MS));
  });

  it('expires at the moment it ends, not a millisecond later', () => {
    const live = session();

    assert.equal(hasExpired(live, at(SESSION_IDLE_TIMEOUT_MS - 1)), false);
    assert.equal(hasExpired(live, at(SESSION_IDLE_TIMEOUT_MS)), true);
  });

  it('expires a busy session on its fourteenth day', () => {
    const busy = session({
      expiresAt: at(-1),
      lastSeenAt: NOW,
    });

    assert.equal(hasExpired(busy, NOW), true);
  });

  it('writes last_seen_at at most once a minute', () => {
    const fresh = session();

    assert.equal(LAST_SEEN_REFRESH_MS, 60_000);
    assert.equal(needsTouch(fresh, NOW), false);
    assert.equal(needsTouch(fresh, at(LAST_SEEN_REFRESH_MS - 1)), false);
    assert.equal(needsTouch(fresh, at(LAST_SEEN_REFRESH_MS)), true);
  });

  it('measures the idle cut-off and the absolute deadline from now', () => {
    assert.deepEqual(idleSince(NOW), at(-SESSION_IDLE_TIMEOUT_MS));
    assert.deepEqual(absoluteExpiryFrom(NOW), at(SESSION_ABSOLUTE_TIMEOUT_MS));
  });
});
