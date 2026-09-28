import type { Pool } from 'pg';

/**
 * The manager's own id, migration 045, read once at boot. Every stage record it pushes carries it, so two managers
 * linked to one web2 admin cannot take each other's stages for their own.
 */
export async function readManagerId(pool: Pick<Pool, 'query'>): Promise<string> {
  const result = await pool.query<{ manager_id: string }>('SELECT manager_id FROM manager_identity');
  const row = result.rows[0];
  if (!row) throw new Error('manager_identity has no row. Its migration inserts the one it holds.');
  return row.manager_id;
}
