import type { Pool } from 'pg';

/**
 * The designation row, migrations 047 and 048, as the manager reads it. The deployment and the batch stay recorded
 * after a clear, which only sets `clearedAt`: `isDesignated` tells a designation in force from one taken out. While a
 * move is pending, the `movingFrom` fields name the batch the catalogue moved off, which a release takes out.
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
  /** The deployment of the batch the catalogue is moving from, or null while no move is pending. */
  movingFromProfileName: string | null;
  movingFromBatchId: string | null;
  movingFromBatchDepth: number | null;
  /** When the pending move was made, and by whom. */
  moveStartedAt: Date | null;
  moveStartedBy: string | null;
  /** When the last release was made, and by whom, kept after it. */
  releasedAt: Date | null;
  releasedBy: string | null;
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

/** Whether the row holds a pending move: a batch the catalogue moved off, not released yet. */
export function isMoving(
  row: CatalogueDesignationRow,
): row is CatalogueDesignationRow & { movingFromProfileName: string; movingFromBatchId: string; moveStartedAt: Date } {
  return row.movingFromProfileName !== null && row.movingFromBatchId !== null && row.moveStartedAt !== null;
}

/** Where the manager keeps its catalogue designation: the database, or an in-memory one in the unit tests. */
export interface CatalogueDesignationStore {
  read(): Promise<CatalogueDesignationRow>;
  /**
   * Designates while the row is still at the revision the caller read, and answers the row then, or null once it had
   * moved. A pending move stays as it is.
   */
  designate(
    write: CatalogueDesignationWrite,
    expectedRevision: number,
    username: string,
  ): Promise<CatalogueDesignationRow | null>;
  /**
   * Moves the catalogue to another batch under the same revision rule: the batch pinned now becomes the one it moves
   * from, and `write` the one designated. Null as well when the row pins no batch, pins this one, or is moving from a
   * third one, which the service refuses before it asks.
   */
  move(
    write: CatalogueDesignationWrite,
    expectedRevision: number,
    username: string,
  ): Promise<CatalogueDesignationRow | null>;
  /** Takes the designation out as of `at`, under the same revision rule, keeping the deployment and the batch. */
  clear(at: Date, expectedRevision: number, username: string): Promise<CatalogueDesignationRow | null>;
  /** Takes the batch the catalogue moved from out of the row as of `at`, under the same rule, or null with no move. */
  release(at: Date, expectedRevision: number, username: string): Promise<CatalogueDesignationRow | null>;
}

interface Row {
  profile_name: string | null;
  batch_id: string | null;
  batch_depth: number | null;
  designated_at: Date | null;
  designated_by: string | null;
  cleared_at: Date | null;
  moving_from_profile_name: string | null;
  moving_from_batch_id: string | null;
  moving_from_batch_depth: number | null;
  move_started_at: Date | null;
  move_started_by: string | null;
  released_at: Date | null;
  released_by: string | null;
  revision: number;
}

const COLUMNS = [
  'profile_name',
  'batch_id',
  'batch_depth',
  'designated_at',
  'designated_by',
  'cleared_at',
  'moving_from_profile_name',
  'moving_from_batch_id',
  'moving_from_batch_depth',
  'move_started_at',
  'move_started_by',
  'released_at',
  'released_by',
  'revision',
].join(', ');

function rowOf(row: Row): CatalogueDesignationRow {
  return {
    profileName: row.profile_name,
    batchId: row.batch_id,
    batchDepth: row.batch_depth,
    designatedAt: row.designated_at,
    designatedBy: row.designated_by,
    clearedAt: row.cleared_at,
    movingFromProfileName: row.moving_from_profile_name,
    movingFromBatchId: row.moving_from_batch_id,
    movingFromBatchDepth: row.moving_from_batch_depth,
    moveStartedAt: row.move_started_at,
    moveStartedBy: row.move_started_by,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
    revision: row.revision,
  };
}

/** The catalogue designation in its single-row table, migrations 047 and 048. */
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

  async move(
    write: CatalogueDesignationWrite,
    expectedRevision: number,
    username: string,
  ): Promise<CatalogueDesignationRow | null> {
    // The right-hand columns are the row as it stood before this update, so the pinned batch becomes the one the
    // catalogue moves from in the same statement that pins the new one.
    const result = await this.pool.query<Row>(
      `UPDATE catalogue_designation
          SET moving_from_profile_name = profile_name,
              moving_from_batch_id = batch_id,
              moving_from_batch_depth = batch_depth,
              move_started_at = $4,
              move_started_by = $5,
              profile_name = $1,
              batch_id = $2,
              batch_depth = $3,
              designated_at = $4,
              designated_by = $5,
              cleared_at = NULL,
              revision = revision + 1,
              updated_at = NOW()
        WHERE singleton
          AND revision = $6
          AND batch_id IS NOT NULL
          AND batch_id <> $2
          AND (moving_from_batch_id IS NULL OR moving_from_batch_id = $2)
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

  async release(at: Date, expectedRevision: number, username: string): Promise<CatalogueDesignationRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE catalogue_designation
          SET moving_from_profile_name = NULL,
              moving_from_batch_id = NULL,
              moving_from_batch_depth = NULL,
              move_started_at = NULL,
              move_started_by = NULL,
              released_at = $1,
              released_by = $2,
              revision = revision + 1,
              updated_at = NOW()
        WHERE singleton AND revision = $3 AND moving_from_batch_id IS NOT NULL
        RETURNING ${COLUMNS}`,
      [at, username, expectedRevision],
    );
    const row = result.rows[0];
    return row ? rowOf(row) : null;
  }
}
