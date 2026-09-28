import type { AdminTokenKind, CatalogueStampRecord } from '@streaming-monorepo/contracts';
import { Pool } from 'pg';

import type { CatalogueStampRow, StageRow, StageSecretsRow, StoredStageRecord } from '../types/index.js';

/**
 * Every column a list may read. The passphrase and the token hash are not among them: a list says whether there is a
 * passphrase and which kind of token the uploader presents, and nothing more.
 */
const STAGE_COLUMNS = `stage_id, manager_id, name, kind, engine, owner, record,
  srt_passphrase IS NOT NULL AS has_srt_passphrase, admin_token_kind,
  observed_at, received_at, retired_at`;

/** A stage record split the way migration 009 keeps it. */
export interface StageWrite {
  record: StoredStageRecord;
  srtPassphrase: string | null;
  adminToken: { sha256: string; kind: AdminTokenKind } | null;
}

/**
 * The stages the manager pushed (migration 009). The rule that an older record never replaces a newer one is the
 * stage service's, and the SQL holds it as well, so two pushes racing cannot undo each other either.
 */
export class StageRepository {
  constructor(private readonly pool: Pool) {}

  /** Active stages first, then by name. */
  async list(): Promise<StageRow[]> {
    const result = await this.pool.query<StageRow>(
      `SELECT ${STAGE_COLUMNS} FROM stages
        ORDER BY retired_at IS NOT NULL, name, stage_id`,
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
   * Stores the record unless the stored one was observed later, and answers the row as written, or null when it was
   * kept. A retired stage comes back only for a record observed after its retirement arrived: a push already on its
   * way when the deployment was deleted leaves it retired.
   */
  async upsert(write: StageWrite): Promise<StageRow | null> {
    const { record } = write;
    const result = await this.pool.query<StageRow>(
      `INSERT INTO stages AS s
         (stage_id, manager_id, name, kind, engine, owner, record,
          srt_passphrase, admin_token_sha256, admin_token_kind, observed_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NOW())
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
              retired_at = CASE
                WHEN s.retired_at IS NOT NULL AND EXCLUDED.observed_at <= s.retired_at THEN s.retired_at
                ELSE NULL
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

  /** Marks the stage retired and answers it, or null when there is no such stage or it was retired already. */
  async retire(stageId: string): Promise<StageRow | null> {
    const result = await this.pool.query<StageRow>(
      `UPDATE stages SET retired_at = NOW()
        WHERE stage_id = $1 AND retired_at IS NULL
       RETURNING ${STAGE_COLUMNS}`,
      [stageId],
    );
    return result.rows[0] ?? null;
  }
}

/** The one catalogue stamp row (migration 010). */
export class CatalogueStampRepository {
  constructor(private readonly pool: Pool) {}

  /** The row, cleared or not, or null when the manager never pushed one. */
  async get(): Promise<CatalogueStampRow | null> {
    const result = await this.pool.query<CatalogueStampRow>(
      `SELECT manager_id, batch_id, record, observed_at, received_at, cleared_at FROM catalogue_stamp`,
    );
    return result.rows[0] ?? null;
  }

  /**
   * Stores the record unless the stored one was observed later, and answers the row as written, or null when it was
   * kept. A cleared designation is set again only by a record observed after the clear arrived.
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
              cleared_at = CASE
                WHEN c.cleared_at IS NOT NULL AND EXCLUDED.observed_at <= c.cleared_at THEN c.cleared_at
                ELSE NULL
              END
        WHERE c.observed_at <= EXCLUDED.observed_at
       RETURNING manager_id, batch_id, record, observed_at, received_at, cleared_at`,
      [record.managerId, record.batchId, JSON.stringify(record), record.observedAt],
    );
    return result.rows[0] ?? null;
  }

  /** Clears the designation and answers the row, or null when there was none to clear. */
  async clear(): Promise<CatalogueStampRow | null> {
    const result = await this.pool.query<CatalogueStampRow>(
      `UPDATE catalogue_stamp SET cleared_at = NOW()
        WHERE cleared_at IS NULL
       RETURNING manager_id, batch_id, record, observed_at, received_at, cleared_at`,
    );
    return result.rows[0] ?? null;
  }
}
