import type { ArchiveBatchDesignation } from '@streaming-infra-manager/common';
import type { Pool, PoolClient } from 'pg';

/** What a revisioned write came to: saved at the new revision, refused for a revision behind, or for the row. */
export type ArchiveBatchWrite =
  | { outcome: 'saved'; revision: number }
  | { outcome: 'changed' }
  /** An adopt of a batch that is an archive batch already, or a removal of one that is none. */
  | { outcome: 'conflict' };

/** Where the manager keeps its archive batches: the database, or an in-memory one in the unit tests. */
export interface ArchiveBatchStore {
  /** Every archive batch, in the order they were designated. */
  list(): Promise<ArchiveBatchDesignation[]>;
  /** The revision an adopt and a removal name. */
  revision(): Promise<number>;
  /**
   * Writes one row and raises the revision. With `expectedRevision`, only while the list is still at the revision the
   * caller read: an operator's adopt. With null, at whatever revision: a purchase is no operator's edit of a list they
   * read. A batch, or a purchase, recorded already is a conflict, which changes nothing.
   */
  designate(designation: ArchiveBatchDesignation, expectedRevision: number | null): Promise<ArchiveBatchWrite>;
  /** Deletes one row under the same rule. */
  remove(batchId: string, expectedRevision: number): Promise<ArchiveBatchWrite>;
}

interface Row {
  batch_id: string;
  profile_name: string;
  label: string | null;
  source: ArchiveBatchDesignation['source'];
  purchase_request_id: string | null;
  designated_at: Date;
  designated_by: string | null;
}

const COLUMNS = 'batch_id, profile_name, label, source, purchase_request_id, designated_at, designated_by';
const INSERT = `INSERT INTO archive_batches (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`;

function designationOf(row: Row): ArchiveBatchDesignation {
  return {
    batchId: row.batch_id,
    profileName: row.profile_name,
    label: row.label,
    source: row.source,
    purchaseRequestId: row.purchase_request_id,
    designatedAt: row.designated_at.toISOString(),
    designatedBy: row.designated_by,
  };
}

function valuesOf(designation: ArchiveBatchDesignation): unknown[] {
  return [
    designation.batchId,
    designation.profileName,
    designation.label,
    designation.source,
    designation.purchaseRequestId,
    new Date(designation.designatedAt),
    designation.designatedBy,
  ];
}

/** What one transaction answers, and whether what it wrote is kept. */
interface Done<T> {
  keep: boolean;
  value: T;
}

/** The archive batches in migration 054's table, with the revision row an adopt and a removal check and raise. */
export class ArchiveBatchRepository implements ArchiveBatchStore {
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>) {}

  async list(): Promise<ArchiveBatchDesignation[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM archive_batches ORDER BY designated_at ASC, batch_id ASC`,
    );
    return result.rows.map(designationOf);
  }

  async revision(): Promise<number> {
    const result = await this.pool.query<{ revision: number }>('SELECT revision FROM archive_batches_revision');
    const row = result.rows[0];
    if (!row) throw new Error('archive_batches_revision has no row. Its migration inserts the one it holds.');
    return row.revision;
  }

  designate(designation: ArchiveBatchDesignation, expectedRevision: number | null): Promise<ArchiveBatchWrite> {
    return this.revised(
      expectedRevision,
      // A conflict on either key: the batch is an archive batch already, or this purchase was recorded already.
      async (client) => (await client.query(INSERT, valuesOf(designation))).rowCount === 1,
    );
  }

  remove(batchId: string, expectedRevision: number): Promise<ArchiveBatchWrite> {
    return this.revised(
      expectedRevision,
      async (client) =>
        (await client.query('DELETE FROM archive_batches WHERE batch_id = $1', [batchId])).rowCount === 1,
    );
  }

  /**
   * Raises the revision, from the one the caller read when it names one, and runs `write` in the same transaction,
   * which answers whether it changed a row. Nothing is kept when the revision had moved or the write changed nothing.
   */
  private revised(
    expectedRevision: number | null,
    write: (client: PoolClient) => Promise<boolean>,
  ): Promise<ArchiveBatchWrite> {
    return this.transaction<ArchiveBatchWrite>(async (client) => {
      const raised = await client.query<{ revision: number }>(
        `UPDATE archive_batches_revision SET revision = revision + 1, updated_at = NOW()
          WHERE singleton AND ($1::integer IS NULL OR revision = $1)
          RETURNING revision`,
        [expectedRevision],
      );
      const row = raised.rows[0];
      if (!row) return { keep: false, value: { outcome: 'changed' } };
      if (!(await write(client))) return { keep: false, value: { outcome: 'conflict' } };
      return { keep: true, value: { outcome: 'saved', revision: row.revision } };
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<Done<T>>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const done = await work(client);
      await client.query(done.keep ? 'COMMIT' : 'ROLLBACK');
      return done.value;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
