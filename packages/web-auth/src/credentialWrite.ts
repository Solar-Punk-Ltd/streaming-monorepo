/** What a guarded credential write needs of a database client. pg's `PoolClient` fits it. */
export interface CredentialClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/** What a guarded credential write needs of a database pool. pg's `Pool` fits it. */
export interface CredentialPool {
  connect(): Promise<CredentialClient>;
}

const LOCK_USER_PASSWORD = 'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE';

function storedHashOf(rows: unknown[]): unknown {
  const row = rows[0];
  return typeof row === 'object' && row !== null ? (row as { password_hash?: unknown }).password_hash : undefined;
}

/**
 * Runs `write` in one transaction, but only while the user's stored password
 * hash is still `verifiedPasswordHash`.
 *
 * A password is verified outside any transaction, because the hash is slow on
 * purpose. So the write it admits reads the hash again under the user's row
 * lock: a sign-in with a password its owner replaced meanwhile opens no
 * session, and of two password changes verified against the same old password
 * the second finds the first one's hash and writes nothing.
 *
 * Both backends keep the hash in `users.password_hash`, keyed by `users.id`.
 *
 * @returns true when `write` ran and committed, false when the hash had moved
 *   or the user is gone, in which case nothing was written.
 */
export async function writeIfPasswordUnchanged(
  pool: CredentialPool,
  userId: string | number,
  verifiedPasswordHash: string,
  write: (client: CredentialClient) => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(LOCK_USER_PASSWORD, [userId]);
    if (storedHashOf(rows) !== verifiedPasswordHash) {
      await client.query('COMMIT');
      return false;
    }
    await write(client);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
