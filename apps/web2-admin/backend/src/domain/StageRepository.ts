import type { AdminTokenKind, CatalogueStampRecord } from '@streaming-monorepo/contracts';
import { Pool, type PoolClient } from 'pg';

import type { CatalogueStampRow, StageRow, StageSecretsRow, StoredStageRecord } from '../types/index.js';

/**
 * Every column a list may read. The passphrase and the token hash are not among them: a list says whether there is a
 * passphrase and which kind of token the uploader presents, and nothing more.
 */
const STAGE_COLUMNS = `stage_id, manager_id, name, kind, engine, owner, record,
  srt_passphrase IS NOT NULL AS has_srt_passphrase, admin_token_kind,
  observed_at, received_at, retired_observed_at, retired_at`;

const CATALOGUE_COLUMNS = `manager_id, batch_id, record, observed_at, received_at, cleared_observed_at, cleared_at`;

/** A stage record split the way migration 009 keeps it. */
export interface StageWrite {
  record: StoredStageRecord;
  srtPassphrase: string | null;
  adminToken: { sha256: string; kind: AdminTokenKind } | null;
}

/**
 * What a retirement did:
 * - `done`: the stage was active (the designation set), and now is not;
 * - `already`: it was retired already, and keeps the later of the two moments;
 * - `newer`: the admin holds a record observed after the moment the retirement names, so the manager has seen the
 *   deployment since and the retirement is not taken;
 * - `unknown`: the admin never stored the stage, and keeps the retirement so a record observed before it cannot
 *   register the stage later.
 */
export type RetireOutcome<Row> = { outcome: 'done'; row: Row } | { outcome: 'already' | 'newer' | 'unknown' };

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The stages the manager pushed (migration 009). The rule that an older record never replaces a newer one is the
 * stage service's, and the SQL holds it as well, so two pushes racing cannot undo each other either. Every moment
 * compared here is the manager's.
 */
export class StageRepository {
  constructor(private readonly pool: Pool) {}

  /** Active stages first, then by name. */
  async list(): Promise<StageRow[]> {
    const result = await this.pool.query<StageRow>(
      `SELECT ${STAGE_COLUMNS} FROM stages
        ORDER BY retired_observed_at IS NOT NULL, name, stage_id`,
    );
    return result.rows;
  }

  /**
   * One stage as a list reads it, without the passphrase or the token hash: what the stream edits and the publish
   * check a stage by.
   */
  async findSummary(stageId: string): Promise<StageRow | null> {
    const result = await this.pool.query<StageRow>(`SELECT ${STAGE_COLUMNS} FROM stages WHERE stage_id = $1`, [
      stageId,
    ]);
    return result.rows[0] ?? null;
  }

  /**
   * The active stages whose uploader presents a token of its own with this sha256: what an uploader's call is
   * attributed by (migration 012). Only `own` rows: a `shared` row's hash is the shared token's, which is checked
   * apart, and a retired stage's token is taken no more. Two rows at most, since two already mean the token cannot
   * say which stage it is. The hash itself is not selected.
   */
  async findActiveByOwnTokenSha256(sha256: string): Promise<StageRow[]> {
    const result = await this.pool.query<StageRow>(
      `SELECT ${STAGE_COLUMNS} FROM stages
        WHERE admin_token_sha256 = $1 AND admin_token_kind = 'own' AND retired_observed_at IS NULL
        ORDER BY stage_id
        LIMIT 2`,
      [sha256],
    );
    return result.rows;
  }

  /** One stage with its passphrase and token hash, for the service to tell what a push changed. */
  async find(stageId: string): Promise<StageSecretsRow | null> {
    const result = await this.pool.query<StageSecretsRow>(
      `SELECT ${STAGE_COLUMNS}, srt_passphrase, admin_token_sha256 FROM stages WHERE stage_id = $1`,
      [stageId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Stores the record unless the stored one was observed later, or a retirement of a stage never stored was observed
   * at or after it, and answers the row as written, or null when it was kept out. A retired stage comes back only for
   * a record observed after its retirement. Storing a record removes the retirement of a stage never stored.
   */
  async upsert(write: StageWrite): Promise<StageRow | null> {
    const { record } = write;
    const result = await this.pool.query<StageRow>(
      `WITH forgotten AS (
         DELETE FROM stage_retirements WHERE stage_id = $1 AND observed_at < $11
       )
       INSERT INTO stages AS s
         (stage_id, manager_id, name, kind, engine, owner, record,
          srt_passphrase, admin_token_sha256, admin_token_kind, observed_at, received_at)
       SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM stage_retirements WHERE stage_id = $1 AND observed_at >= $11
        )
       ON CONFLICT (stage_id) DO UPDATE
          SET manager_id = EXCLUDED.manager_id,
              name = EXCLUDED.name,
              kind = EXCLUDED.kind,
              engine = EXCLUDED.engine,
              owner = EXCLUDED.owner,
              record = EXCLUDED.record,
              srt_passphrase = EXCLUDED.srt_passphrase,
              admin_token_sha256 = EXCLUDED.admin_token_sha256,
              admin_token_kind = EXCLUDED.admin_token_kind,
              observed_at = EXCLUDED.observed_at,
              received_at = NOW(),
              retired_observed_at = CASE
                WHEN EXCLUDED.observed_at > s.retired_observed_at THEN NULL
                ELSE s.retired_observed_at
              END,
              retired_at = CASE
                WHEN EXCLUDED.observed_at > s.retired_observed_at THEN NULL
                ELSE s.retired_at
              END
        WHERE s.observed_at <= EXCLUDED.observed_at
       RETURNING ${STAGE_COLUMNS}`,
      [
        record.stageId,
        record.managerId,
        record.name,
        record.kind,
        record.engine,
        record.owner,
        JSON.stringify(record),
        write.srtPassphrase,
        write.adminToken?.sha256 ?? null,
        write.adminToken?.kind ?? null,
        record.observedAt,
      ],
    );
    return result.rows[0] ?? null;
  }

  /** Retires the stage as of `observedAt`, the manager's moment; see `RetireOutcome`. */
  retire(stageId: string, observedAt: string): Promise<RetireOutcome<StageRow>> {
    return inTransaction(this.pool, async (client) => {
      const current = await client.query<{ newer: boolean; retired: boolean }>(
        `SELECT observed_at > $2::timestamptz AS newer, retired_observed_at IS NOT NULL AS retired
           FROM stages WHERE stage_id = $1 FOR UPDATE`,
        [stageId, observedAt],
      );
      const row = current.rows[0];

      if (!row) {
        await client.query(
          `INSERT INTO stage_retirements AS r (stage_id, observed_at) VALUES ($1, $2)
           ON CONFLICT (stage_id) DO UPDATE
              SET observed_at = GREATEST(r.observed_at, EXCLUDED.observed_at), received_at = NOW()`,
          [stageId, observedAt],
        );
        return { outcome: 'unknown' };
      }
      if (row.newer) return { outcome: 'newer' };
      if (row.retired) {
        await client.query(
          `UPDATE stages SET retired_observed_at = GREATEST(retired_observed_at, $2) WHERE stage_id = $1`,
          [stageId, observedAt],
        );
        return { outcome: 'already' };
      }

      const retired = await client.query<StageRow>(
        `UPDATE stages SET retired_observed_at = $2, retired_at = NOW()
          WHERE stage_id = $1
         RETURNING ${STAGE_COLUMNS}`,
        [stageId, observedAt],
      );
      return { outcome: 'done', row: retired.rows[0]! };
    });
  }
}

/** The one catalogue stamp row (migration 010). */
export class CatalogueStampRepository {
  constructor(private readonly pool: Pool) {}

  /** The row, cleared or not, or null when the manager never pushed a record nor a clear. */
  async get(): Promise<CatalogueStampRow | null> {
    const result = await this.pool.query<CatalogueStampRow>(`SELECT ${CATALOGUE_COLUMNS} FROM catalogue_stamp`);
    return result.rows[0] ?? null;
  }

  /**
   * Stores the record unless the stored one was observed later, and answers the row as written, or null when it was
   * kept out. A cleared designation is set again only by a record observed after the clear; on a row a clear made
   * before any record arrived, only such a record is stored at all.
   */
  async upsert(record: CatalogueStampRecord): Promise<CatalogueStampRow | null> {
    const result = await this.pool.query<CatalogueStampRow>(
      `INSERT INTO catalogue_stamp AS c (id, manager_id, batch_id, record, observed_at, received_at)
       VALUES (TRUE, $1, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (id) DO UPDATE
          SET manager_id = EXCLUDED.manager_id,
              batch_id = EXCLUDED.batch_id,
              record = EXCLUDED.record,
              observed_at = EXCLUDED.observed_at,
              received_at = NOW(),
              cleared_observed_at = CASE
                WHEN EXCLUDED.observed_at > c.cleared_observed_at THEN NULL
                ELSE c.cleared_observed_at
              END,
              cleared_at = CASE
                WHEN EXCLUDED.observed_at > c.cleared_observed_at THEN NULL
                ELSE c.cleared_at
              END
        WHERE c.observed_at <= EXCLUDED.observed_at
          AND (c.record IS NOT NULL OR EXCLUDED.observed_at > c.cleared_observed_at)
       RETURNING ${CATALOGUE_COLUMNS}`,
      [record.managerId, record.batchId, JSON.stringify(record), record.observedAt],
    );
    return result.rows[0] ?? null;
  }

  /** Clears the designation as of `observedAt`, the manager's moment, under the rules a stage is retired by. */
  clear(observedAt: string): Promise<RetireOutcome<CatalogueStampRow>> {
    return inTransaction(this.pool, async (client) => {
      const current = await client.query<{ newer: boolean; cleared: boolean }>(
        `SELECT observed_at > $1::timestamptz AS newer, cleared_observed_at IS NOT NULL AS cleared
           FROM catalogue_stamp FOR UPDATE`,
        [observedAt],
      );
      const row = current.rows[0];

      if (!row) {
        // A row made in the meantime by another process keeps its record and takes the later clear.
        await client.query(
          `INSERT INTO catalogue_stamp AS c (id, observed_at, cleared_observed_at, cleared_at)
           VALUES (TRUE, $1, $1, NOW())
           ON CONFLICT (id) DO UPDATE
              SET cleared_observed_at = GREATEST(c.cleared_observed_at, EXCLUDED.cleared_observed_at),
                  cleared_at = COALESCE(c.cleared_at, NOW())`,
          [observedAt],
        );
        return { outcome: 'unknown' };
      }
      if (row.newer) return { outcome: 'newer' };
      if (row.cleared) {
        await client.query(`UPDATE catalogue_stamp SET cleared_observed_at = GREATEST(cleared_observed_at, $1)`, [
          observedAt,
        ]);
        return { outcome: 'already' };
      }

      const cleared = await client.query<CatalogueStampRow>(
        `UPDATE catalogue_stamp SET cleared_observed_at = $1, cleared_at = NOW()
         RETURNING ${CATALOGUE_COLUMNS}`,
        [observedAt],
      );
      return { outcome: 'done', row: cleared.rows[0]! };
    });
  }
}
