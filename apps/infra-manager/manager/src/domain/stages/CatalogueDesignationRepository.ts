import type { Pool } from 'pg';

/**
 * The designation row, migration 047, as the manager reads it. The deployment and the batch stay recorded after a
 * clear, which only sets `clearedAt`: `isDesignated` tells a designation in force from one taken out.
 */
export interface CatalogueDesignationRow {
  /** Null when nothing was ever designated. */
  profileName: string | null;
  batchId: string | null;
  /** The depth the node reported at designation. */
  batchDepth: number | null;
  designatedAt: Date | null;
  designatedBy: string | null;
  /** When the last designation was taken out, or null while it is in force or none was made. */
  clearedAt: Date | null;
  revision: number;
}

/** One designation: the deployment, the batch on its node, the depth the node reported, and the moment. */
export interface CatalogueDesignationWrite {
  profileName: string;
  batchId: string;
  batchDepth: number;
  at: Date;
}

/** Whether the row holds a designation in force: one made, and not taken out since. */
export function isDesignated(
  row: CatalogueDesignationRow,
): row is CatalogueDesignationRow & { profileName: string; batchId: string; designatedAt: Date; batchDepth: number } {
  return row.profileName !== null && row.batchId !== null && row.designatedAt !== null && row.clearedAt === null;
}

/** Where the manager keeps its catalogue designation: the database, or an in-memory one in the unit tests. */
export interface CatalogueDesignationStore {
  read(): Promise<CatalogueDesignationRow>;
  /** Designates while the row is still at the revision the caller read, and answers the row then, or null once it had moved. */
  designate(
    write: CatalogueDesignationWrite,
    expectedRevision: number,
    username: string,
  ): Promise<CatalogueDesignationRow | null>;
  /** Takes the designation out as of `at`, under the same revision rule, keeping the deployment and the batch. */
  clear(at: Date, expectedRevision: number, username: string): Promise<CatalogueDesignationRow | null>;
}

interface Row {
  profile_name: string | null;
  batch_id: string | null;
  batch_depth: number | null;
  designated_at: Date | null;
  designated_by: string | null;
  cleared_at: Date | null;
  revision: number;
}

const COLUMNS = 'profile_name, batch_id, batch_depth, designated_at, designated_by, cleared_at, revision';

function rowOf(row: Row): CatalogueDesignationRow {
  return {
    profileName: row.profile_name,
    batchId: row.batch_id,
    batchDepth: row.batch_depth,
    designatedAt: row.designated_at,
    designatedBy: row.designated_by,
    clearedAt: row.cleared_at,
    revision: row.revision,
  };
}

/** The catalogue designation in its single-row table, migration 047. */
export class CatalogueDesignationRepository implements CatalogueDesignationStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async read(): Promise<CatalogueDesignationRow> {
    const result = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM catalogue_designation`);
    const row = result.rows[0];
    if (!row) throw new Error('catalogue_designation has no row. Its migration inserts the one it holds.');
    return rowOf(row);
  }

  async designate(
    write: CatalogueDesignationWrite,
    expectedRevision: number,
    username: string,
  ): Promise<CatalogueDesignationRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE catalogue_designation
          SET profile_name = $1,
              batch_id = $2,
              batch_depth = $3,
              designated_at = $4,
              designated_by = $5,
              cleared_at = NULL,
              revision = revision + 1,
              updated_at = NOW()
        WHERE singleton AND revision = $6
        RETURNING ${COLUMNS}`,
      [write.profileName, write.batchId, write.batchDepth, write.at, username, expectedRevision],
    );
    const row = result.rows[0];
    return row ? rowOf(row) : null;
  }

  async clear(at: Date, expectedRevision: number, username: string): Promise<CatalogueDesignationRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE catalogue_designation
          SET designated_by = $2,
              cleared_at = $1,
              revision = revision + 1,
              updated_at = NOW()
        WHERE singleton AND revision = $3 AND profile_name IS NOT NULL
        RETURNING ${COLUMNS}`,
      [at, username, expectedRevision],
    );
    const row = result.rows[0];
    return row ? rowOf(row) : null;
  }
}
