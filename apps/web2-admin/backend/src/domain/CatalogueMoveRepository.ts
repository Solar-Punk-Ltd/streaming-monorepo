import type { CatalogueMoveState } from '@streaming-monorepo/web2-admin-common';
import { Pool, PoolClient } from 'pg';

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

/** One row of `catalogue_moves`, migration 014. The BIGINTs come back as numbers: a feed never has 2^53 slots. */
export interface CatalogueMoveRow {
  id: string;
  targetBatchId: string;
  fromBatchId: string | null;
  state: CatalogueMoveState;
  nextIndex: number;
  headIndex: number | null;
  restampedSlots: number;
  skippedSlots: number;
  thumbnails: number;
  error: string | null;
  startedBy: string;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/** What the move reads of one slot's row in `feed_writes`. */
export interface FeedSlotRow {
  index: number;
  payloadText: string | null;
  batchId: string | null;
  restampedBatchId: string | null;
  reference: string | null;
}

/** How many rows of a span of slots are under a batch by the admin's record, and how many can be uploaded again. */
export interface SlotCounts {
  /** Rows written with the batch, or uploaded again under it. */
  underTarget: number;
  /** Rows under the batch, or with their exact bytes recorded. */
  readable: number;
}

/** Where the catalogue move keeps its progress: Postgres, or memory in the unit tests. */
export interface CatalogueMoveStore {
  latest(owner: string, topic: string): Promise<CatalogueMoveRow | null>;
  /** Every slot below this is under `targetBatchId` by a move that finished: the highest `next_index` of those. */
  coveredBelow(owner: string, topic: string, targetBatchId: string): Promise<number>;
  slotCounts(owner: string, topic: string, targetBatchId: string, from: number, to: number): Promise<SlotCounts>;
  /** The rows of slots `from` to `to`, both included. A slot with no row is not in the answer. */
  slots(owner: string, topic: string, from: number, to: number): Promise<FeedSlotRow[]>;
  /** A new running move, or null when one is running already for the feed. */
  create(move: {
    owner: string;
    topic: string;
    targetBatchId: string;
    fromBatchId: string | null;
    startedBy: string;
  }): Promise<CatalogueMoveRow | null>;
  /** A failed move running again from where it stopped, or null when it is not failed. */
  retry(id: string): Promise<CatalogueMoveRow | null>;
  /**
   * Records that slot `index` is under the move's target, uploaded again (`restamped`) or already so, and that the
   * feed's head was `head`. Only for the move's next slot while it runs; null otherwise, and nothing is written.
   */
  recordSlot(
    id: string,
    slot: { owner: string; topic: string; index: number; restamped: boolean; head: number },
  ): Promise<CatalogueMoveRow | null>;
  finish(id: string, thumbnails: number): Promise<CatalogueMoveRow | null>;
  fail(id: string, error: string): Promise<CatalogueMoveRow | null>;
}

interface Row {
  id: string;
  target_batch_id: string;
  from_batch_id: string | null;
  state: CatalogueMoveState;
  next_index: string;
  head_index: string | null;
  restamped_slots: number;
  skipped_slots: number;
  thumbnails: number;
  error: string | null;
  started_by: string;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const COLUMNS = `id::text AS id, target_batch_id, from_batch_id, state, next_index, head_index, restamped_slots,
  skipped_slots, thumbnails, error, started_by, started_at, updated_at, finished_at`;

function rowOf(row: Row): CatalogueMoveRow {
  return {
    id: row.id,
    targetBatchId: row.target_batch_id,
    fromBatchId: row.from_batch_id,
    state: row.state,
    nextIndex: Number(row.next_index),
    headIndex: row.head_index === null ? null : Number(row.head_index),
    restampedSlots: row.restamped_slots,
    skippedSlots: row.skipped_slots,
    thumbnails: row.thumbnails,
    error: row.error,
    startedBy: row.started_by,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/** Owner and topic are hex; case has never been load-bearing. */
function normalise(value: string): string {
  return value.toLowerCase();
}

/** The catalogue moves, migration 014, and the restamp columns it adds to `feed_writes`. */
export class CatalogueMoveRepository implements CatalogueMoveStore {
  constructor(private readonly pool: Pool) {}

  async latest(owner: string, topic: string): Promise<CatalogueMoveRow | null> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM catalogue_moves
        WHERE feed_owner = $1 AND feed_topic = $2
        ORDER BY id DESC
        LIMIT 1`,
      [normalise(owner), normalise(topic)],
    );
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  async coveredBelow(owner: string, topic: string, targetBatchId: string): Promise<number> {
    const result = await this.pool.query<{ covered: string | null }>(
      `SELECT MAX(next_index) AS covered FROM catalogue_moves
        WHERE feed_owner = $1 AND feed_topic = $2 AND target_batch_id = $3 AND state = 'done'`,
      [normalise(owner), normalise(topic), targetBatchId],
    );
    return Number(result.rows[0]?.covered ?? 0);
  }

  async slotCounts(owner: string, topic: string, targetBatchId: string, from: number, to: number): Promise<SlotCounts> {
    const result = await this.pool.query<SlotCounts>(
      `SELECT COUNT(*) FILTER (WHERE batch_id = $3 OR restamped_batch_id = $3)::int AS "underTarget",
              COUNT(*) FILTER (WHERE payload_text IS NOT NULL OR batch_id = $3 OR restamped_batch_id = $3)::int
                AS "readable"
         FROM feed_writes
        WHERE feed_owner = $1 AND feed_topic = $2 AND feed_index BETWEEN $4 AND $5`,
      [normalise(owner), normalise(topic), targetBatchId, from, to],
    );
    return result.rows[0] ?? { underTarget: 0, readable: 0 };
  }

  async slots(owner: string, topic: string, from: number, to: number): Promise<FeedSlotRow[]> {
    const result = await this.pool.query<{
      feed_index: string;
      payload_text: string | null;
      batch_id: string | null;
      restamped_batch_id: string | null;
      reference: string | null;
    }>(
      `SELECT feed_index, payload_text, batch_id, restamped_batch_id, reference
         FROM feed_writes
        WHERE feed_owner = $1 AND feed_topic = $2 AND feed_index BETWEEN $3 AND $4
        ORDER BY feed_index`,
      [normalise(owner), normalise(topic), from, to],
    );
    return result.rows.map((row) => ({
      index: Number(row.feed_index),
      payloadText: row.payload_text,
      batchId: row.batch_id,
      restampedBatchId: row.restamped_batch_id,
      reference: row.reference,
    }));
  }

  async create(move: {
    owner: string;
    topic: string;
    targetBatchId: string;
    fromBatchId: string | null;
    startedBy: string;
  }): Promise<CatalogueMoveRow | null> {
    // The partial unique index holds one running move per feed; a second start answers null rather than an error.
    const result = await this.pool.query<Row>(
      `INSERT INTO catalogue_moves (feed_owner, feed_topic, target_batch_id, from_batch_id, state, started_by)
       VALUES ($1, $2, $3, $4, 'running', $5)
       ON CONFLICT (feed_owner, feed_topic) WHERE state = 'running' DO NOTHING
       RETURNING ${COLUMNS}`,
      [normalise(move.owner), normalise(move.topic), move.targetBatchId, move.fromBatchId, move.startedBy],
    );
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  async retry(id: string): Promise<CatalogueMoveRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE catalogue_moves
          SET state = 'running', error = NULL, finished_at = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'failed'
          AND NOT EXISTS (
            SELECT 1 FROM catalogue_moves other
             WHERE other.feed_owner = catalogue_moves.feed_owner
               AND other.feed_topic = catalogue_moves.feed_topic
               AND other.state = 'running')
        RETURNING ${COLUMNS}`,
      [id],
    );
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  recordSlot(
    id: string,
    slot: { owner: string; topic: string; index: number; restamped: boolean; head: number },
  ): Promise<CatalogueMoveRow | null> {
    return inTransaction(this.pool, async (client) => {
      const moved = await client.query<Row>(
        `UPDATE catalogue_moves
            SET next_index = next_index + 1,
                head_index = GREATEST(COALESCE(head_index, 0), $3),
                restamped_slots = restamped_slots + CASE WHEN $4 THEN 1 ELSE 0 END,
                skipped_slots = skipped_slots + CASE WHEN $4 THEN 0 ELSE 1 END,
                updated_at = NOW()
          WHERE id = $1 AND state = 'running' AND next_index = $2
          RETURNING ${COLUMNS}`,
        [id, slot.index, slot.head, slot.restamped],
      );
      const row = moved.rows[0];
      if (!row) return null;
      if (slot.restamped) {
        await client.query(
          `UPDATE feed_writes
              SET restamped_batch_id = $4, restamped_at = NOW()
            WHERE feed_owner = $1 AND feed_topic = $2 AND feed_index = $3`,
          [normalise(slot.owner), normalise(slot.topic), slot.index, row.target_batch_id],
        );
      }
      return rowOf(row);
    });
  }

  async finish(id: string, thumbnails: number): Promise<CatalogueMoveRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE catalogue_moves
          SET state = 'done', thumbnails = $2, finished_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND state = 'running'
        RETURNING ${COLUMNS}`,
      [id, thumbnails],
    );
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  async fail(id: string, error: string): Promise<CatalogueMoveRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE catalogue_moves
          SET state = 'failed', error = $2, finished_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND state = 'running'
        RETURNING ${COLUMNS}`,
      [id, error],
    );
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }
}
