import { writeIfPasswordUnchanged } from '@streaming-monorepo/web-auth';
import { Pool } from 'pg';

import type { CredentialRepository } from './CredentialRepository.js';
import type { NewSession } from './SessionRepository.js';

export class PostgresCredentialRepository implements CredentialRepository {
  constructor(private readonly pool: Pool) {}

  admitSession(userId: number, verifiedPasswordHash: string, session: NewSession, signedInAt: Date): Promise<boolean> {
    return writeIfPasswordUnchanged(this.pool, userId, verifiedPasswordHash, async (client) => {
      await client.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [session.tokenHash, userId, session.expiresAt, session.ip, session.userAgent],
      );
      await client.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [userId, signedInAt]);
    });
  }

  changePassword(
    userId: number,
    verifiedPasswordHash: string,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<boolean> {
    return writeIfPasswordUnchanged(this.pool, userId, verifiedPasswordHash, async (client) => {
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [
        userId,
        keepSessionTokenHash,
      ]);
    });
  }
}
