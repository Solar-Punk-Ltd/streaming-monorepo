import type {
  ArchiveItemResult,
  ArchiveJobState,
  ArchivePauseReason,
  ArchiveStampPurchaseState,
} from '@streaming-monorepo/web2-admin-common';
import type { Pool, PoolClient } from 'pg';

import { EXPORT_HOLDS_PLACE_SQL, TAKE_JOB_PLACE_LOCK_SQL } from '../jobPlace.js';

/** A row of `archive_jobs` (migration 028). There is at most one. */
export interface ArchiveJobRow {
  id: string;
  stream_id: string;
  batch_id: string | null;
  buy_new: boolean;
  purchase_id: string | null;
  state: ArchiveJobState;
  pause_reason: ArchivePauseReason | null;
  pause_message: string | null;
  paused_at: Date | null;
  chunks_total: number | null;
  chunks_per_second: number | null;
  bzz_estimate_low_plur: string | null;
  bzz_estimate_high_plur: string | null;
  chequebook_before_plur: string | null;
  bzz_spent_plur: string | null;
  started_by_user_id: string | null;
  started_by: string;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** The row as one user sees it: with the stream's title, and whether they closed its widget. */
export interface ArchiveJobView extends ArchiveJobRow {
  stream_title: string;
  dismissed: boolean;
}

export type ArchiveItemState = 'waiting' | 'measuring' | 'copying' | 'verifying' | 'done';

/** A row of `archive_job_items`: one chosen quality. */
export interface ArchiveItemRow {
  job_id: string;
  rendition: string;
  position: number;
  feed_owner: string;
  feed_topic: string;
  manifest_index: number;
  state: ArchiveItemState;
  result: ArchiveItemResult | null;
  segments_total: number | null;
  segments_done: number;
  chunks_total: number | null;
  chunks_copied: number;
  chunks_rebuilt: number;
  parity_missing: number;
  bytes_copied: number;
  tag_uid: number | null;
  posts_under_tag: number;
  chunks_synced: number;
  chunks_seen: number;
  bucket_sum_before: number | null;
}

/**
 * A row of `stream_archives` (migrations 025 and 036): one copy, a quality of a stream on one archive stamp. A quality
 * has a row for each stamp it was archived onto.
 */
export interface StreamArchiveRow {
  stream_id: string;
  rendition: string;
  batch_id: string;
  feed_owner: string;
  feed_topic: string;
  manifest_index: number;
  state: 'partial' | 'complete';
  parity_missing: number;
  segments: number;
  chunks: number;
  bytes: number;
  chunks_rebuilt: number;
  bucket_sum_before: number | null;
  bucket_sum_after: number | null;
  bzz_spent_estimate_plur: string | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completed_by: string | null;
  /**
   * When the copy's stamp runs out, as the latest catalogue stamp record that listed it read it (migration 029), or
   * null until a record lists it. Written as records arrive, never by the copy.
   */
  stamp_expires_at: Date | null;
}

/** What a copy writes as it starts: everything but its completion and its stamp's end. */
export type NewStreamArchive = Omit<
  StreamArchiveRow,
  'state' | 'completed_at' | 'completed_by_user_id' | 'completed_by' | 'stamp_expires_at'
>;

/** What a copy updates as it goes. */
export type StreamArchiveChange = Partial<
  Pick<
    StreamArchiveRow,
    | 'parity_missing'
    | 'segments'
    | 'chunks'
    | 'bytes'
    | 'chunks_rebuilt'
    | 'bucket_sum_after'
    | 'bzz_spent_estimate_plur'
  >
>;

/**
 * A row of `stream_archive_thumbnails` (migration 036): the image of a stream as it was stamped under one archive
 * stamp. There is one for a stream and a stamp.
 */
export interface StreamArchiveThumbnailRow {
  stream_id: string;
  /** The archive stamp, 64 hex digits in lower case with no `0x`. */
  batch_id: string;
  /** The image's reference, as `streams.thumbnail_ref` held it when it was stamped. */
  thumbnail_ref: string;
  stamped_at: Date;
  stamped_by_user_id: string | null;
  stamped_by: string;
}

/** What stamping an image records: everything but the moment. */
export type NewStreamArchiveThumbnail = Omit<StreamArchiveThumbnailRow, 'stamped_at'>;

/** A row of `archive_stamp_purchases` (migration 027). */
export interface ArchivePurchaseRow {
  id: string;
  depth: number;
  days: number;
  amount_per_chunk_plur: string;
  cost_plur: string;
  label: string | null;
  state: ArchiveStampPurchaseState;
  batch_id: string | null;
  tx_hash: string | null;
  error: string | null;
  relayed_at: Date | null;
  started_by_user_id: string | null;
  started_by: string;
  started_at: Date;
  updated_at: Date;
}

export interface NewArchiveJob {
  id: string;
  streamId: string;
  batchId: string | null;
  buyNew: boolean;
  startedByUserId: string | null;
  startedBy: string;
  items: Array<{ rendition: string; feedOwner: string; feedTopic: string; manifestIndex: number }>;
}

/**
 * A move of the job to another state, and the fields that change with it. Leaving `paused` clears the reason; `done`
 * sets `finished_at`.
 */
export interface ArchiveJobChange {
  state: ArchiveJobState;
  pauseReason?: ArchivePauseReason;
  pauseMessage?: string | null;
  batchId?: string | null;
  buyNew?: boolean;
  purchaseId?: string | null;
  chunksTotal?: number | null;
  chunksPerSecond?: number | null;
  bzzEstimateLowPlur?: string | null;
  bzzEstimateHighPlur?: string | null;
  chequebookBeforePlur?: string | null;
  bzzSpentPlur?: string | null;
}

export interface ArchiveItemChange {
  state?: ArchiveItemState;
  result?: ArchiveItemResult | null;
  feedTopic?: string;
  manifestIndex?: number;
  segmentsTotal?: number | null;
  segmentsDone?: number;
  chunksTotal?: number | null;
  chunksCopied?: number;
  chunksRebuilt?: number;
  parityMissing?: number;
  bytesCopied?: number;
  tagUid?: number | null;
  postsUnderTag?: number;
  chunksSynced?: number;
  chunksSeen?: number;
  bucketSumBefore?: number | null;
}

export interface ArchiveSegmentDone {
  reference: string;
  chunks: number;
  bytes: number;
  parityMissing: number;
}

export interface NewPurchase {
  id: string;
  depth: number;
  days: number;
  amountPerChunkPlur: string;
  costPlur: string;
  label: string | null;
  startedByUserId: string | null;
  startedBy: string;
}

export interface PurchaseChange {
  state?: ArchiveStampPurchaseState;
  batchId?: string | null;
  txHash?: string | null;
  error?: string | null;
  /** True marks it sent to the manager, keeping the first moment; false marks it never received, to send again. */
  relayed?: boolean;
}

/** What starting or taking the place again found holding it instead. */
export type PlaceRefusal = 'export' | 'archive';

/** The slice of the database the archive uses; a fake stands in, in the unit tests. */
export interface ArchiveStore {
  getJob(): Promise<ArchiveJobRow | null>;
  viewJob(userId: string | null): Promise<ArchiveJobView | null>;
  items(jobId: string): Promise<ArchiveItemRow[]>;
  /**
   * Inserts a new job with its items under the place's lock, deleting a done one first. Answers what holds the place
   * instead when an export or another archive does.
   */
  createJob(input: NewArchiveJob): Promise<{ row: ArchiveJobRow } | { refused: PlaceRefusal }>;
  /** Moves the job from one of `from`; null when it is gone or in another state, and nothing changed. */
  transition(id: string, from: readonly ArchiveJobState[], change: ArchiveJobChange): Promise<ArchiveJobRow | null>;
  /**
   * The same, for a move that takes the place again, such as resuming a user's pause: under the place's lock, and
   * refused when an export holds it.
   */
  transitionTakingPlace(
    id: string,
    from: readonly ArchiveJobState[],
    change: ArchiveJobChange,
  ): Promise<ArchiveJobRow | { refused: PlaceRefusal } | null>;
  updateItem(jobId: string, rendition: string, change: ArchiveItemChange): Promise<void>;
  /** Records a segment as done and saves the item's counters with it, in one transaction. */
  recordSegment(
    jobId: string,
    rendition: string,
    segment: ArchiveSegmentDone,
    change: ArchiveItemChange,
  ): Promise<void>;
  segmentsDone(jobId: string, rendition: string): Promise<Set<string>>;
  /** Forgets every segment of the item, so its copy starts over. */
  clearSegments(jobId: string, rendition: string): Promise<void>;
  removeJob(id: string): Promise<boolean>;
  dismiss(id: string, userId: string): Promise<boolean>;

  lastRate(): Promise<number | null>;
  saveRate(chunksPerSecond: number): Promise<void>;

  /** Every copy of the streams named, or of every stream: a row for each quality and stamp. */
  archivesOf(streamIds: readonly string[] | null): Promise<StreamArchiveRow[]>;
  /**
   * Writes a quality's copy on one stamp as partial, in place of the copy that stamp held of it. The quality's copies
   * on other stamps stay as they are.
   */
  startArchive(row: NewStreamArchive): Promise<void>;
  /** Updates the copy of the quality on the stamp `batchId`. */
  saveArchive(streamId: string, rendition: string, batchId: string, change: StreamArchiveChange): Promise<void>;
  /** Marks the copy of the quality on the stamp `batchId` complete. */
  completeArchive(
    streamId: string,
    rendition: string,
    batchId: string,
    byUserId: string | null,
    by: string,
  ): Promise<void>;
  /** The images stamped under archive stamps, of the streams named or of every stream. */
  thumbnailsOf(streamIds: readonly string[] | null): Promise<StreamArchiveThumbnailRow[]>;
  /** Records the image as stamped under the stamp, in place of the image recorded there for the stream. */
  recordThumbnail(row: NewStreamArchiveThumbnail): Promise<void>;
  setArchivedOnly(streamId: string, archivedOnly: boolean): Promise<boolean>;

  /** Null when another purchase is under way. */
  createPurchase(input: NewPurchase): Promise<ArchivePurchaseRow | null>;
  getPurchase(id: string): Promise<ArchivePurchaseRow | null>;
  updatePurchase(id: string, change: PurchaseChange): Promise<ArchivePurchaseRow | null>;
  /** The purchases under way first, then the most recent, at most `limit`. */
  listPurchases(limit: number): Promise<ArchivePurchaseRow[]>;
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

/** BIGINT columns, which pg answers as strings, as numbers. */
function numbersOf<T extends object>(row: T, keys: readonly string[]): T {
  const copy = { ...row } as Record<string, unknown>;
  for (const key of keys) {
    const value = copy[key];
    if (typeof value === 'string') copy[key] = Number(value);
  }
  return copy as T;
}

/** NUMERIC PLUR columns, as strings whatever the driver answers. */
function plur(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function jobOf<T extends ArchiveJobRow>(row: T): T {
  return {
    ...numbersOf(row, ['chunks_total']),
    bzz_estimate_low_plur: plur(row.bzz_estimate_low_plur),
    bzz_estimate_high_plur: plur(row.bzz_estimate_high_plur),
    chequebook_before_plur: plur(row.chequebook_before_plur),
    bzz_spent_plur: plur(row.bzz_spent_plur),
  };
}

const ITEM_NUMBERS = [
  'manifest_index',
  'chunks_total',
  'chunks_copied',
  'bytes_copied',
  'tag_uid',
  'posts_under_tag',
  'chunks_synced',
  'chunks_seen',
  'bucket_sum_before',
];

function archiveOf(row: StreamArchiveRow): StreamArchiveRow {
  return {
    ...numbersOf(row, ['manifest_index', 'chunks', 'bytes', 'bucket_sum_before', 'bucket_sum_after']),
    bzz_spent_estimate_plur: plur(row.bzz_spent_estimate_plur),
  };
}

function purchaseOf(row: ArchivePurchaseRow): ArchivePurchaseRow {
  return { ...row, amount_per_chunk_plur: String(row.amount_per_chunk_plur), cost_plur: String(row.cost_plur) };
}

/** The SET list of a job change, its values numbered after `$1` the id and `$2` the states it moves from. */
function jobSets(change: ArchiveJobChange): { sets: string[]; values: unknown[] } {
  const values: unknown[] = [change.state];
  const sets = ['state = $3', 'updated_at = NOW()'];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length + 2}`);
  };
  if (change.state === 'paused') {
    set('pause_reason', change.pauseReason ?? 'problem');
    set('pause_message', change.pauseMessage ?? null);
    sets.push('paused_at = NOW()');
  } else {
    sets.push('pause_reason = NULL', 'pause_message = NULL', 'paused_at = NULL');
  }
  if (change.batchId !== undefined) set('batch_id', change.batchId);
  if (change.buyNew !== undefined) set('buy_new', change.buyNew);
  if (change.purchaseId !== undefined) set('purchase_id', change.purchaseId);
  if (change.chunksTotal !== undefined) set('chunks_total', change.chunksTotal);
  if (change.chunksPerSecond !== undefined) set('chunks_per_second', change.chunksPerSecond);
  if (change.bzzEstimateLowPlur !== undefined) set('bzz_estimate_low_plur', change.bzzEstimateLowPlur);
  if (change.bzzEstimateHighPlur !== undefined) set('bzz_estimate_high_plur', change.bzzEstimateHighPlur);
  if (change.chequebookBeforePlur !== undefined) set('chequebook_before_plur', change.chequebookBeforePlur);
  if (change.bzzSpentPlur !== undefined) set('bzz_spent_plur', change.bzzSpentPlur);
  sets.push(change.state === 'done' ? 'finished_at = COALESCE(finished_at, NOW())' : 'finished_at = NULL');
  return { sets, values };
}

const ITEM_COLUMNS: Record<keyof ArchiveItemChange, string> = {
  state: 'state',
  result: 'result',
  feedTopic: 'feed_topic',
  manifestIndex: 'manifest_index',
  segmentsTotal: 'segments_total',
  segmentsDone: 'segments_done',
  chunksTotal: 'chunks_total',
  chunksCopied: 'chunks_copied',
  chunksRebuilt: 'chunks_rebuilt',
  parityMissing: 'parity_missing',
  bytesCopied: 'bytes_copied',
  tagUid: 'tag_uid',
  postsUnderTag: 'posts_under_tag',
  chunksSynced: 'chunks_synced',
  chunksSeen: 'chunks_seen',
  bucketSumBefore: 'bucket_sum_before',
};

/** The SET list of an item change, its values numbered after `$1` the job and `$2` the rendition. */
function itemSets(change: ArchiveItemChange): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(ITEM_COLUMNS) as Array<keyof ArchiveItemChange>) {
    if (change[key] === undefined) continue;
    values.push(change[key]);
    sets.push(`${ITEM_COLUMNS[key]} = $${values.length + 2}`);
  }
  return { sets, values };
}

const ARCHIVE_COLUMNS: ReadonlyArray<keyof StreamArchiveChange> = [
  'parity_missing',
  'segments',
  'chunks',
  'bytes',
  'chunks_rebuilt',
  'bucket_sum_after',
  'bzz_spent_estimate_plur',
];

export class ArchiveRepository implements ArchiveStore {
  constructor(private readonly pool: Pool) {}

  async getJob(): Promise<ArchiveJobRow | null> {
    const result = await this.pool.query<ArchiveJobRow>('SELECT * FROM archive_jobs LIMIT 1');
    return result.rows[0] ? jobOf(result.rows[0]) : null;
  }

  async viewJob(userId: string | null): Promise<ArchiveJobView | null> {
    const result = await this.pool.query<ArchiveJobView>(
      `SELECT j.*,
              s.title AS stream_title,
              ($1::uuid IS NOT NULL AND EXISTS (
                SELECT 1 FROM archive_job_dismissals d WHERE d.job_id = j.id AND d.user_id = $1::uuid
              )) AS dismissed
         FROM archive_jobs j
         JOIN streams s ON s.id = j.stream_id
        LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? jobOf(result.rows[0]) : null;
  }

  async items(jobId: string): Promise<ArchiveItemRow[]> {
    const result = await this.pool.query<ArchiveItemRow>(
      'SELECT * FROM archive_job_items WHERE job_id = $1 ORDER BY position',
      [jobId],
    );
    return result.rows.map((row) => numbersOf(row, ITEM_NUMBERS));
  }

  async createJob(input: NewArchiveJob): Promise<{ row: ArchiveJobRow } | { refused: PlaceRefusal }> {
    try {
      return await inTransaction(this.pool, async (client) => {
        await client.query(TAKE_JOB_PLACE_LOCK_SQL);
        if ((await client.query(EXPORT_HOLDS_PLACE_SQL)).rowCount) return { refused: 'export' as const };
        const held = await client.query<{ state: ArchiveJobState }>('SELECT state FROM archive_jobs FOR UPDATE');
        if (held.rows.some((row) => row.state !== 'done')) return { refused: 'archive' as const };
        await client.query(`DELETE FROM archive_jobs WHERE state = 'done'`);
        const inserted = await client.query<ArchiveJobRow>(
          `INSERT INTO archive_jobs (id, stream_id, batch_id, buy_new, state, started_by_user_id, started_by)
           VALUES ($1, $2, $3, $4, 'measuring', $5, $6)
           RETURNING *`,
          [input.id, input.streamId, input.batchId, input.buyNew, input.startedByUserId, input.startedBy],
        );
        for (const [position, item] of input.items.entries()) {
          await client.query(
            `INSERT INTO archive_job_items (job_id, rendition, position, feed_owner, feed_topic, manifest_index, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'waiting')`,
            [input.id, item.rendition, position, item.feedOwner, item.feedTopic, item.manifestIndex],
          );
        }
        return { row: jobOf(inserted.rows[0]!) };
      });
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { refused: 'archive' };
      throw error;
    }
  }

  async transition(
    id: string,
    from: readonly ArchiveJobState[],
    change: ArchiveJobChange,
  ): Promise<ArchiveJobRow | null> {
    const { sets, values } = jobSets(change);
    const result = await this.pool.query<ArchiveJobRow>(
      `UPDATE archive_jobs SET ${sets.join(', ')} WHERE id = $1 AND state = ANY($2::text[]) RETURNING *`,
      [id, from, ...values],
    );
    return result.rows[0] ? jobOf(result.rows[0]) : null;
  }

  async transitionTakingPlace(
    id: string,
    from: readonly ArchiveJobState[],
    change: ArchiveJobChange,
  ): Promise<ArchiveJobRow | { refused: PlaceRefusal } | null> {
    return inTransaction(this.pool, async (client) => {
      await client.query(TAKE_JOB_PLACE_LOCK_SQL);
      if ((await client.query(EXPORT_HOLDS_PLACE_SQL)).rowCount) return { refused: 'export' as const };
      const { sets, values } = jobSets(change);
      const result = await client.query<ArchiveJobRow>(
        `UPDATE archive_jobs SET ${sets.join(', ')} WHERE id = $1 AND state = ANY($2::text[]) RETURNING *`,
        [id, from, ...values],
      );
      return result.rows[0] ? jobOf(result.rows[0]) : null;
    });
  }

  async updateItem(jobId: string, rendition: string, change: ArchiveItemChange): Promise<void> {
    const { sets, values } = itemSets(change);
    if (sets.length === 0) return;
    await this.pool.query(`UPDATE archive_job_items SET ${sets.join(', ')} WHERE job_id = $1 AND rendition = $2`, [
      jobId,
      rendition,
      ...values,
    ]);
  }

  async recordSegment(
    jobId: string,
    rendition: string,
    segment: ArchiveSegmentDone,
    change: ArchiveItemChange,
  ): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO archive_job_segments (job_id, rendition, reference, chunks, bytes, parity_missing)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (job_id, rendition, reference)
           DO UPDATE SET chunks = EXCLUDED.chunks, bytes = EXCLUDED.bytes, parity_missing = EXCLUDED.parity_missing,
                         done_at = NOW()`,
        [jobId, rendition, segment.reference, segment.chunks, segment.bytes, segment.parityMissing],
      );
      const { sets, values } = itemSets(change);
      if (sets.length > 0) {
        await client.query(`UPDATE archive_job_items SET ${sets.join(', ')} WHERE job_id = $1 AND rendition = $2`, [
          jobId,
          rendition,
          ...values,
        ]);
      }
    });
  }

  async segmentsDone(jobId: string, rendition: string): Promise<Set<string>> {
    const result = await this.pool.query<{ reference: string }>(
      'SELECT reference FROM archive_job_segments WHERE job_id = $1 AND rendition = $2',
      [jobId, rendition],
    );
    return new Set(result.rows.map((row) => row.reference));
  }

  async clearSegments(jobId: string, rendition: string): Promise<void> {
    await this.pool.query('DELETE FROM archive_job_segments WHERE job_id = $1 AND rendition = $2', [jobId, rendition]);
  }

  async removeJob(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM archive_jobs WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async dismiss(id: string, userId: string): Promise<boolean> {
    const done = await this.pool.query(`SELECT 1 FROM archive_jobs WHERE id = $1 AND state = 'done'`, [id]);
    if ((done.rowCount ?? 0) === 0) return false;
    await this.pool.query(
      'INSERT INTO archive_job_dismissals (job_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, userId],
    );
    return true;
  }

  async lastRate(): Promise<number | null> {
    const result = await this.pool.query<{ chunks_per_second: number }>('SELECT chunks_per_second FROM archive_rate');
    return result.rows[0]?.chunks_per_second ?? null;
  }

  async saveRate(chunksPerSecond: number): Promise<void> {
    if (!(chunksPerSecond > 0)) return;
    await this.pool.query(
      `INSERT INTO archive_rate (id, chunks_per_second, measured_at) VALUES (TRUE, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET chunks_per_second = EXCLUDED.chunks_per_second, measured_at = NOW()`,
      [chunksPerSecond],
    );
  }

  async archivesOf(streamIds: readonly string[] | null): Promise<StreamArchiveRow[]> {
    const result =
      streamIds === null
        ? await this.pool.query<StreamArchiveRow>('SELECT * FROM stream_archives')
        : await this.pool.query<StreamArchiveRow>('SELECT * FROM stream_archives WHERE stream_id = ANY($1::uuid[])', [
            streamIds,
          ]);
    return result.rows.map(archiveOf);
  }

  async startArchive(row: NewStreamArchive): Promise<void> {
    await this.pool.query(
      `INSERT INTO stream_archives
         (stream_id, rendition, batch_id, feed_owner, feed_topic, manifest_index, state, parity_missing, segments,
          chunks, bytes, chunks_rebuilt, bucket_sum_before, bucket_sum_after, bzz_spent_estimate_plur)
       VALUES ($1, $2, $3, $4, $5, $6, 'partial', $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (stream_id, rendition, batch_id) DO UPDATE SET
         feed_owner = EXCLUDED.feed_owner, feed_topic = EXCLUDED.feed_topic,
         manifest_index = EXCLUDED.manifest_index, state = 'partial', parity_missing = EXCLUDED.parity_missing,
         segments = EXCLUDED.segments, chunks = EXCLUDED.chunks, bytes = EXCLUDED.bytes,
         chunks_rebuilt = EXCLUDED.chunks_rebuilt, bucket_sum_before = EXCLUDED.bucket_sum_before,
         bucket_sum_after = EXCLUDED.bucket_sum_after, bzz_spent_estimate_plur = EXCLUDED.bzz_spent_estimate_plur,
         completed_at = NULL, completed_by_user_id = NULL, completed_by = NULL, created_at = NOW(),
         updated_at = NOW()`,
      [
        row.stream_id,
        row.rendition,
        row.batch_id,
        row.feed_owner,
        row.feed_topic,
        row.manifest_index,
        row.parity_missing,
        row.segments,
        row.chunks,
        row.bytes,
        row.chunks_rebuilt,
        row.bucket_sum_before,
        row.bucket_sum_after,
        row.bzz_spent_estimate_plur,
      ],
    );
  }

  async saveArchive(streamId: string, rendition: string, batchId: string, change: StreamArchiveChange): Promise<void> {
    const values: unknown[] = [streamId, rendition, batchId];
    const sets = ['updated_at = NOW()'];
    for (const column of ARCHIVE_COLUMNS) {
      if (change[column] === undefined) continue;
      values.push(change[column]);
      sets.push(`${column} = $${values.length}`);
    }
    await this.pool.query(
      `UPDATE stream_archives SET ${sets.join(', ')} WHERE stream_id = $1 AND rendition = $2 AND batch_id = $3`,
      values,
    );
  }

  async completeArchive(
    streamId: string,
    rendition: string,
    batchId: string,
    byUserId: string | null,
    by: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE stream_archives
          SET state = 'complete', completed_at = NOW(), completed_by_user_id = $4, completed_by = $5, updated_at = NOW()
        WHERE stream_id = $1 AND rendition = $2 AND batch_id = $3`,
      [streamId, rendition, batchId, byUserId, by],
    );
  }

  async thumbnailsOf(streamIds: readonly string[] | null): Promise<StreamArchiveThumbnailRow[]> {
    const result =
      streamIds === null
        ? await this.pool.query<StreamArchiveThumbnailRow>('SELECT * FROM stream_archive_thumbnails')
        : await this.pool.query<StreamArchiveThumbnailRow>(
            'SELECT * FROM stream_archive_thumbnails WHERE stream_id = ANY($1::uuid[])',
            [streamIds],
          );
    return result.rows;
  }

  async recordThumbnail(row: NewStreamArchiveThumbnail): Promise<void> {
    await this.pool.query(
      `INSERT INTO stream_archive_thumbnails (stream_id, batch_id, thumbnail_ref, stamped_by_user_id, stamped_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stream_id, batch_id) DO UPDATE SET
         thumbnail_ref = EXCLUDED.thumbnail_ref, stamped_at = NOW(),
         stamped_by_user_id = EXCLUDED.stamped_by_user_id, stamped_by = EXCLUDED.stamped_by`,
      [row.stream_id, row.batch_id, row.thumbnail_ref, row.stamped_by_user_id, row.stamped_by],
    );
  }

  async setArchivedOnly(streamId: string, archivedOnly: boolean): Promise<boolean> {
    const result = await this.pool.query('UPDATE streams SET archived_only = $2 WHERE id = $1', [
      streamId,
      archivedOnly,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async createPurchase(input: NewPurchase): Promise<ArchivePurchaseRow | null> {
    try {
      const result = await this.pool.query<ArchivePurchaseRow>(
        `INSERT INTO archive_stamp_purchases
           (id, depth, days, amount_per_chunk_plur, cost_plur, label, state, started_by_user_id, started_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'buying', $7, $8)
         RETURNING *`,
        [
          input.id,
          input.depth,
          input.days,
          input.amountPerChunkPlur,
          input.costPlur,
          input.label,
          input.startedByUserId,
          input.startedBy,
        ],
      );
      return purchaseOf(result.rows[0]!);
    } catch (error) {
      // One purchase under way at a time: archive_stamp_purchases_one_open.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return null;
      throw error;
    }
  }

  async getPurchase(id: string): Promise<ArchivePurchaseRow | null> {
    const result = await this.pool.query<ArchivePurchaseRow>('SELECT * FROM archive_stamp_purchases WHERE id = $1', [
      id,
    ]);
    return result.rows[0] ? purchaseOf(result.rows[0]) : null;
  }

  async updatePurchase(id: string, change: PurchaseChange): Promise<ArchivePurchaseRow | null> {
    const values: unknown[] = [id];
    const sets = ['updated_at = NOW()'];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (change.state !== undefined) set('state', change.state);
    if (change.batchId !== undefined) set('batch_id', change.batchId);
    if (change.txHash !== undefined) set('tx_hash', change.txHash);
    if (change.error !== undefined) set('error', change.error);
    if (change.relayed === true) sets.push('relayed_at = COALESCE(relayed_at, NOW())');
    if (change.relayed === false) sets.push('relayed_at = NULL');
    const result = await this.pool.query<ArchivePurchaseRow>(
      `UPDATE archive_stamp_purchases SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      values,
    );
    return result.rows[0] ? purchaseOf(result.rows[0]) : null;
  }

  async listPurchases(limit: number): Promise<ArchivePurchaseRow[]> {
    const result = await this.pool.query<ArchivePurchaseRow>(
      `SELECT * FROM archive_stamp_purchases
        ORDER BY (state IN ('buying', 'waiting_usable')) DESC, started_at DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(purchaseOf);
  }
}
