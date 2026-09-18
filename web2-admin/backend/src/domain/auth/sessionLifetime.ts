import {
  LAST_SEEN_REFRESH_MS,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
} from '@streaming-monorepo/web2-admin-common';

import type { StoredSession } from './SessionRepository.js';

/**
 * A session has two clocks, and the earlier one wins. `expires_at` is the
 * absolute deadline written once at sign-in; the idle clock slides on
 * `last_seen_at`. Nothing else in the backend decides whether a session is
 * still good, so the two repository implementations cannot drift on it.
 */

/** Sessions last seen before this moment have idled out. */
export function idleSince(now: Date): Date {
  return new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS);
}

export function absoluteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS);
}

/** When this session stops working if nothing else touches it. */
export function endsAt(session: StoredSession): Date {
  const idleEnd = session.lastSeenAt.getTime() + SESSION_IDLE_TIMEOUT_MS;
  return new Date(Math.min(session.expiresAt.getTime(), idleEnd));
}

export function hasExpired(session: StoredSession, now: Date): boolean {
  return endsAt(session).getTime() <= now.getTime();
}

/**
 * Whether `last_seen_at` is stale enough to be worth a write. Without this
 * every request would be a write.
 */
export function needsTouch(session: StoredSession, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_REFRESH_MS;
}
