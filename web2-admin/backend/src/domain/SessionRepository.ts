import { Pool } from 'pg';

import type { SessionRow, SessionWithUserRow, UserRow } from '../types/index.js';

import { USER_COLUMNS } from './userSql.js';

const SESSION_COLUMNS = `
  id, user_id, token_hash, created_at, expires_at
`;

/** Row shape of the session ⋈ user join, before it is split in two. */
interface JoinedRow extends SessionRow {
  u_id: string;
  u_username: string;
  u_password_hash: string;
  u_password_changed_at: Date | null;
  u_created_at: Date;
  u_updated_at: Date;
}

export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<SessionRow> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING ${SESSION_COLUMNS}`,
      [userId, tokenHash, expiresAt],
    );
    return result.rows[0]!;
  }

  /**
   * The session and its user in one round trip. Expiry is *not* filtered here:
   * AuthService decides what an expired session means (and deletes it), so the
   * rule lives in one readable place instead of half in SQL.
   */
  async findByTokenHash(tokenHash: string): Promise<SessionWithUserRow | null> {
    const result = await this.pool.query<JoinedRow>(
      `SELECT s.id, s.user_id, s.token_hash, s.created_at, s.expires_at,
              u.id AS u_id, u.username AS u_username,
              u.password_hash AS u_password_hash,
              u.password_changed_at AS u_password_changed_at,
              u.created_at AS u_created_at, u.updated_at AS u_updated_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    if (!result.rowCount || result.rowCount === 0) return null;

    const row = result.rows[0]!;
    const user: UserRow = {
      id: row.u_id,
      username: row.u_username,
      password_hash: row.u_password_hash,
      password_changed_at: row.u_password_changed_at,
      created_at: row.u_created_at,
      updated_at: row.u_updated_at,
    };
    const session: SessionRow = {
      id: row.id,
      user_id: row.user_id,
      token_hash: row.token_hash,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
    return { session, user };
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
  }

  /** Used by a password change: every other login of that user is revoked. */
  async deleteForUserExcept(userId: string, keepTokenHash: string): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2',
      [userId, keepTokenHash],
    );
    return result.rowCount ?? 0;
  }

  async deleteExpired(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM sessions WHERE expires_at <= NOW()',
    );
    return result.rowCount ?? 0;
  }
}
