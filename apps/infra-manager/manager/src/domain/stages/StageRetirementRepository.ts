import type { Pool } from 'pg';

/**
 * A removed deployment's stage whose retirement the web2 admin has not answered yet, migration 049. The removal
 * writes it with no decision; the stage publisher decides it, sends it until the admin answers, and deletes it.
 */
export interface PendingRetirement {
  /** The deployment's instance id, which is the stage's id. */
  stageId: string;
  /** The deployment's name, for the log. */
  name: string;
  /** The moment the manager saw the row gone, as an ISO string, or null until the publisher decided it. */
  deletedAt: string | null;
  /** The origin of the link the stage's records went to, or null for the link's current origin. */
  origin: string | null;
}

/** A retirement the publisher decided, which has its moment. */
export type DecidedRetirement = PendingRetirement & { deletedAt: string };

/** The pending retirements as the stage publisher reads and writes them. */
export interface StageRetirementStore {
  /** Every retirement still pending, decided or not. */
  pending(): Promise<PendingRetirement[]>;
  /**
   * Keeps a decided retirement until it is answered, writing its row when the removal left none. A moment and an
   * origin decided before stay as they are. Answers the retirement as kept.
   */
  keep(retirement: DecidedRetirement): Promise<DecidedRetirement>;
  /** Takes a retirement out: answered, dropped, or one the publisher decided not to send. */
  remove(stageId: string): Promise<void>;
}

interface RetirementRow {
  stage_id: string;
  profile_name: string;
  deleted_at: Date | null;
  origin: string | null;
}

const COLUMNS = 'stage_id, profile_name, deleted_at, origin';

function retirementOf(row: RetirementRow): PendingRetirement {
  return {
    stageId: row.stage_id,
    name: row.profile_name,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    origin: row.origin,
  };
}

/**
 * The row a stage's removal writes, in the transaction that deletes the deployment's profile row, with the stage id
 * and the name. One already there stays as it is.
 */
export const PENDING_RETIREMENT_INSERT_SQL =
  'INSERT INTO pending_stage_retirements (stage_id, profile_name) VALUES ($1, $2) ON CONFLICT (stage_id) DO NOTHING';

export class StageRetirementRepository implements StageRetirementStore {
  constructor(private readonly pool: Pool) {}

  async pending(): Promise<PendingRetirement[]> {
    const result = await this.pool.query<RetirementRow>(
      `SELECT ${COLUMNS} FROM pending_stage_retirements ORDER BY created_at, stage_id`,
    );
    return result.rows.map(retirementOf);
  }

  async keep(retirement: DecidedRetirement): Promise<DecidedRetirement> {
    const result = await this.pool.query<RetirementRow>(
      `INSERT INTO pending_stage_retirements (stage_id, profile_name, deleted_at, origin) VALUES ($1, $2, $3, $4)
       ON CONFLICT (stage_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at, origin = EXCLUDED.origin
         WHERE pending_stage_retirements.deleted_at IS NULL
       RETURNING ${COLUMNS}`,
      [retirement.stageId, retirement.name, retirement.deletedAt, retirement.origin],
    );
    // No row written: one decided before is kept as it was.
    const row =
      result.rows[0] ??
      (
        await this.pool.query<RetirementRow>(`SELECT ${COLUMNS} FROM pending_stage_retirements WHERE stage_id = $1`, [
          retirement.stageId,
        ])
      ).rows[0];
    const kept = row ? retirementOf(row) : null;
    return kept?.deletedAt ? { ...kept, deletedAt: kept.deletedAt } : retirement;
  }

  async remove(stageId: string): Promise<void> {
    await this.pool.query('DELETE FROM pending_stage_retirements WHERE stage_id = $1', [stageId]);
  }
}
