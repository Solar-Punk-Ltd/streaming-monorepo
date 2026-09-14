import { Pool } from 'pg';

import type { UserRow } from '../types/index.js';

import { USER_COLUMNS } from './userSql.js';

export class UserRepository {
  constructor(private readonly pool: Pool) {}

  async count(): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM users',
    );
    return result.rows[0]?.count ?? 0;
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE username = $1`,
      [username],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async insert(username: string, passwordHash: string): Promise<UserRow> {
    const result = await this.pool.query<UserRow>(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING ${USER_COLUMNS}`,
      [username, passwordHash],
    );
    return result.rows[0]!;
  }

  async updatePasswordHash(
    id: string,
    passwordHash: string,
  ): Promise<UserRow | null> {
    const result = await this.pool.query<UserRow>(
      `UPDATE users
          SET password_hash = $2,
              password_changed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [id, passwordHash],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }
}
