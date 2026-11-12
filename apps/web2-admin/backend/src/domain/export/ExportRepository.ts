import type { ExportPauseReason, ExportState } from '@streaming-monorepo/web2-admin-common';
import type { Pool, PoolClient } from 'pg';

/** A row of `stream_exports` (migrations 023 and 024). There is at most one. */
export interface ExportRow {
  id: string;
  /** Always true: the unique column that holds the table to one row. */
  slot?: boolean;
  stream_id: string;
  rendition: string;
  quality: string;
  feed_owner: string;
  feed_topic: string;
  manifest_index: number;
  state: ExportState;
  pause_reason: ExportPauseReason | null;
  pause_message: string | null;
  paused_at: Date | null;
  segments_total: number | null;
  segments_read: number;
  segments_missing: number;
  bytes_read: number;
  estimated_bytes: number | null;
  duration_seconds: number | null;
  file_name: string | null;
  size_bytes: number | null;
  partial: boolean;
  /** A user chose Save what was read: the join finishes even while the stream is live. */
  save_chosen: boolean;
  started_by_user_id: string | null;
  started_by: string;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** The row as one user sees it: with the stream's title, and whether they closed its widget. */
export interface ExportView extends ExportRow {
  stream_title: string;
  dismissed: boolean;
}

export interface NewExport {
  id: string;
  streamId: string;
  rendition: string;
  quality: string;
  feedOwner: string;
  feedTopic: string;
  manifestIndex: number;
  estimatedBytes: number | null;
  durationSeconds: number | null;
  startedByUserId: string | null;
  startedBy: string;
}

/**
 * A move to another state, and the fields that change with it. Leaving `paused` clears the reason; `done` sets
 * `finished_at`.
 */
export interface ExportChange {
  state: ExportState;
  pauseReason?: ExportPauseReason;
  pauseMessage?: string | null;
  manifestIndex?: number;
  segmentsTotal?: number | null;
  segmentsRead?: number;
  segmentsMissing?: number;
  bytesRead?: number;
  durationSeconds?: number | null;
  quality?: string;
  fileName?: string;
  sizeBytes?: number;
  partial?: boolean;
  saveChosen?: boolean;
}

export interface ExportProgress {
  segmentsTotal: number | null;
  segmentsRead: number;
  segmentsMissing: number;
  bytesRead: number;
  durationSeconds: number | null;
}

export interface ExportStore {
  get(): Promise<ExportRow | null>;
  view(userId: string | null): Promise<ExportView | null>;
  /**
   * Inserts a new export, deleting a done one first, and answers the ids it replaced. Null while another export holds
   * the slot, including one a concurrent start inserted first.
   */
  create(input: NewExport): Promise<{ row: ExportRow; replaced: string[] } | null>;
  /** Moves the export from one of `from`; null when it is gone or in another state, and nothing changed. */
  transition(id: string, from: readonly ExportState[], change: ExportChange): Promise<ExportRow | null>;
  /** Saves progress while the export is still in `state`; false when it is not, and nothing changed. */
  progress(id: string, state: ExportState, progress: ExportProgress): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Records that the user closed the widget of a finished export; false when it is not a finished export. */
  dismiss(id: string, userId: string): Promise<boolean>;
}

const UNIQUE_VIOLATION = '23505';

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

export class ExportRepository implements ExportStore {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<ExportRow | null> {
    const result = await this.pool.query<ExportRow>('SELECT * FROM stream_exports LIMIT 1');
    return result.rows[0] ?? null;
  }

  async view(userId: string | null): Promise<ExportView | null> {
    const result = await this.pool.query<ExportView>(
      `SELECT e.*,
              s.title AS stream_title,
              ($1::uuid IS NOT NULL AND EXISTS (
                SELECT 1 FROM stream_export_dismissals d WHERE d.export_id = e.id AND d.user_id = $1::uuid
              )) AS dismissed
         FROM stream_exports e
         JOIN streams s ON s.id = e.stream_id
        LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async create(input: NewExport): Promise<{ row: ExportRow; replaced: string[] } | null> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const held = await client.query<{ id: string; state: ExportState }>(
          'SELECT id, state FROM stream_exports FOR UPDATE',
        );
        if (held.rows.some((row) => row.state !== 'done')) return null;
        const replaced = await client.query<{ id: string }>(
          `DELETE FROM stream_exports WHERE state = 'done' RETURNING id`,
        );
        const inserted = await client.query<ExportRow>(
          `INSERT INTO stream_exports
             (id, stream_id, rendition, quality, feed_owner, feed_topic, manifest_index, state,
              estimated_bytes, duration_seconds, started_by_user_id, started_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'reading', $8, $9, $10, $11)
           RETURNING *`,
          [
            input.id,
            input.streamId,
            input.rendition,
            input.quality,
            input.feedOwner,
            input.feedTopic,
            input.manifestIndex,
            input.estimatedBytes,
            input.durationSeconds,
            input.startedByUserId,
            input.startedBy,
          ],
        );
        return { row: inserted.rows[0]!, replaced: replaced.rows.map((row) => row.id) };
      });
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return null;
      throw error;
    }
  }

  async transition(id: string, from: readonly ExportState[], change: ExportChange): Promise<ExportRow | null> {
    const values: unknown[] = [id, from, change.state];
    const sets = ['state = $3', 'updated_at = NOW()'];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (change.state === 'paused') {
      set('pause_reason', change.pauseReason ?? 'problem');
      set('pause_message', change.pauseMessage ?? null);
      sets.push('paused_at = NOW()');
    } else {
      sets.push('pause_reason = NULL', 'pause_message = NULL', 'paused_at = NULL');
    }
    if (change.manifestIndex !== undefined) set('manifest_index', change.manifestIndex);
    if (change.segmentsTotal !== undefined) set('segments_total', change.segmentsTotal);
    if (change.segmentsRead !== undefined) set('segments_read', change.segmentsRead);
    if (change.segmentsMissing !== undefined) set('segments_missing', change.segmentsMissing);
    if (change.bytesRead !== undefined) set('bytes_read', change.bytesRead);
    if (change.durationSeconds !== undefined) set('duration_seconds', change.durationSeconds);
    if (change.quality !== undefined) set('quality', change.quality);
    if (change.fileName !== undefined) set('file_name', change.fileName);
    if (change.sizeBytes !== undefined) set('size_bytes', change.sizeBytes);
    if (change.partial !== undefined) set('partial', change.partial);
    if (change.saveChosen !== undefined) set('save_chosen', change.saveChosen);
    if (change.state === 'done') sets.push('finished_at = NOW()');
    const result = await this.pool.query<ExportRow>(
      `UPDATE stream_exports SET ${sets.join(', ')}
        WHERE id = $1 AND state = ANY($2::text[])
        RETURNING *`,
      values,
    );
    return result.rows[0] ?? null;
  }

  async progress(id: string, state: ExportState, progress: ExportProgress): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE stream_exports
          SET segments_total = $3,
              segments_read = $4,
              segments_missing = $5,
              bytes_read = $6,
              duration_seconds = COALESCE($7, duration_seconds),
              updated_at = NOW()
        WHERE id = $1 AND state = $2`,
      [
        id,
        state,
        progress.segmentsTotal,
        progress.segmentsRead,
        progress.segmentsMissing,
        progress.bytesRead,
        progress.durationSeconds,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM stream_exports WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async dismiss(id: string, userId: string): Promise<boolean> {
    const done = await this.pool.query(`SELECT 1 FROM stream_exports WHERE id = $1 AND state = 'done'`, [id]);
    if ((done.rowCount ?? 0) === 0) return false;
    await this.pool.query(
      `INSERT INTO stream_export_dismissals (export_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, userId],
    );
    return true;
  }
}
