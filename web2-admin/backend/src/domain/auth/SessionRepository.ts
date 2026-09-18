import type { UserRow } from '../../types/index.js';

/**
 * Sessions as stored. Nothing here decides whether a session is still valid:
 * that rule lives in sessionLifetime.ts, so the two implementations of this
 * interface cannot drift on it.
 *
 * The whole user row rides along rather than just the name, because
 * `GET /api/auth/me` answers the `User` the contract declares and the streams
 * routes take the row's id straight off `req.user`.
 */
export interface StoredSession {
  tokenHash: string;
  user: UserRow;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface NewSession {
  tokenHash: string;
  userId: string;
  /** The absolute deadline, whatever the session's activity. */
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionRepository {
  create(session: NewSession): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<StoredSession | null>;
  touch(tokenHash: string, seenAt: Date): Promise<void>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
  /** Removes what is past its absolute deadline or idle since `idleSince`. */
  deleteExpired(now: Date, idleSince: Date): Promise<number>;
  /** Open sessions per user id, for the Access page's count. */
  countActiveByUser(now: Date, idleSince: Date): Promise<Map<string, number>>;
}
