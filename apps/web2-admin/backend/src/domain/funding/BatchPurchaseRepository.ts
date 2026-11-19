import type { BatchPurchaseStage, BatchPurchaseState, BuyablePurpose } from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

/**
 * The batches bought from the Stamps tab, migration 030's `batch_purchases`: one row per purchase, written before the
 * manager is asked, under the id the manager's funding API knows it by. docs/architecture/funding.md, "Buying a new
 * batch".
 *
 * A batch id here is 64 hex digits in lower case without `0x`, as the admin keeps one.
 */

/** One row of `batch_purchases`. */
export interface BatchPurchaseRow {
  /** The purchase's id, the request id the manager knows it by. */
  id: string;
  purpose: BuyablePurpose;
  nodeId: string;
  nodeLabel: string;
  depth: number;
  immutable: boolean;
  days: number;
  /** PLUR as a decimal string. */
  amountPerChunkPlur: string;
  /** PLUR as a decimal string: what the user confirmed. */
  costPlur: string;
  replacesBatchId: string | null;
  state: BatchPurchaseState;
  batchId: string | null;
  txHash: string | null;
  error: string | null;
  /** The manager's last answer about the stages of a rung purchase. */
  stages: BatchPurchaseStage[];
  releasedAt: Date | null;
  /** When the purchase was last sent to the manager; null for one not sent yet, which is sent under the same id. */
  relayedAt: Date | null;
  startedByUserId: string | null;
  startedBy: string;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/** A purchase as it is written, before the manager is asked: `buying`, not sent. */
export type NewBatchPurchase = Pick<
  BatchPurchaseRow,
  | 'id'
  | 'purpose'
  | 'nodeId'
  | 'nodeLabel'
  | 'depth'
  | 'immutable'
  | 'days'
  | 'amountPerChunkPlur'
  | 'costPlur'
  | 'replacesBatchId'
  | 'startedByUserId'
  | 'startedBy'
>;

/**
 * What moves on a purchase. A field left out keeps what is recorded. `error` is written as given, null included. A
 * state of `done` or `failed` marks the purchase finished, and any other clears that mark.
 */
export interface BatchPurchaseChange {
  state?: BatchPurchaseState;
  batchId?: string | null;
  txHash?: string | null;
  error?: string | null;
  stages?: readonly BatchPurchaseStage[];
  /** Marks the previous catalogue batch released, once. */
  released?: true;
  /** `sent` marks the purchase sent to the manager now; `unsent` marks it never received, to be sent again. */
  relayed?: 'sent' | 'unsent';
}

/** The states in which a purchase is under way, as migration 030's partial index names them. */
const OPEN_SQL = `state IN ('buying', 'waiting_usable', 'restarting', 'moving')`;

/** The index that keeps one purchase under way on a node. */
const ONE_OPEN_PER_NODE = 'batch_purchases_one_open_per_node';

/** Where the purchase service keeps its purchases: Postgres, or memory in the unit tests. */
export interface BatchPurchaseStore {
  /** Writes a new purchase, `buying` and not sent. Null when another purchase is under way on its node. */
  create(purchase: NewBatchPurchase): Promise<BatchPurchaseRow | null>;
  get(id: string): Promise<BatchPurchaseRow | null>;
  /** The purchases under way, and those that started or finished at `since` or later, the latest first. */
  listSince(since: Date): Promise<BatchPurchaseRow[]>;
  /** The purchases under way, the oldest first. */
  listOpen(): Promise<BatchPurchaseRow[]>;
  /**
   * Records what moved, and answers the row as it now stands. Null for a purchase never written. `busy` when the change
   * would put the purchase under way again while another is under way on its node; nothing is written then.
   */
  update(id: string, change: BatchPurchaseChange): Promise<BatchPurchaseRow | 'busy' | null>;
}

interface Row {
  id: string;
  purpose: BuyablePurpose;
  node_id: string;
  node_label: string;
  depth: number;
  immutable: boolean;
  days: number;
  amount_per_chunk_plur: string;
  cost_plur: string;
  replaces_batch_id: string | null;
  state: BatchPurchaseState;
  batch_id: string | null;
  tx_hash: string | null;
  error: string | null;
  stages: BatchPurchaseStage[] | null;
  released_at: Date | null;
  relayed_at: Date | null;
  started_by_user_id: string | null;
  started_by: string;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const COLUMNS = `id::text AS id, purpose, node_id, node_label, depth, immutable, days,
  amount_per_chunk_plur::text AS amount_per_chunk_plur, cost_plur::text AS cost_plur, replaces_batch_id, state,
  batch_id, tx_hash, error, stages, released_at, relayed_at, started_by_user_id::text AS started_by_user_id,
  started_by, started_at, updated_at, finished_at`;

function rowOf(row: Row): BatchPurchaseRow {
  return {
    id: row.id,
    purpose: row.purpose,
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    depth: Number(row.depth),
    immutable: row.immutable,
    days: Number(row.days),
    amountPerChunkPlur: row.amount_per_chunk_plur,
    costPlur: row.cost_plur,
    replacesBatchId: row.replaces_batch_id,
    state: row.state,
    batchId: row.batch_id,
    txHash: row.tx_hash,
    error: row.error,
    stages: Array.isArray(row.stages) ? row.stages : [],
    releasedAt: row.released_at,
    relayedAt: row.relayed_at,
    startedByUserId: row.started_by_user_id,
    startedBy: row.started_by,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/** Whether `error` is the one-open-per-node index refusing a second purchase under way on a node. */
function isOneOpenPerNode(error: unknown): boolean {
  const { code, constraint } = error as { code?: string; constraint?: string };
  return code === '23505' && constraint === ONE_OPEN_PER_NODE;
}

export class BatchPurchaseRepository implements BatchPurchaseStore {
  constructor(private readonly pool: Pool) {}

  async create(purchase: NewBatchPurchase): Promise<BatchPurchaseRow | null> {
    try {
      const result = await this.pool.query<Row>(
        `INSERT INTO batch_purchases (id, purpose, node_id, node_label, depth, immutable, days,
           amount_per_chunk_plur, cost_plur, replaces_batch_id, state, started_by_user_id, started_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10, 'buying', $11, $12)
         RETURNING ${COLUMNS}`,
        [
          purchase.id,
          purchase.purpose,
          purchase.nodeId,
          purchase.nodeLabel,
          purchase.depth,
          purchase.immutable,
          purchase.days,
          purchase.amountPerChunkPlur,
          purchase.costPlur,
          purchase.replacesBatchId,
          purchase.startedByUserId,
          purchase.startedBy,
        ],
      );
      return result.rows[0] ? rowOf(result.rows[0]) : null;
    } catch (error) {
      if (isOneOpenPerNode(error)) return null;
      throw error;
    }
  }

  async get(id: string): Promise<BatchPurchaseRow | null> {
    const result = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM batch_purchases WHERE id = $1`, [id]);
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  async listSince(since: Date): Promise<BatchPurchaseRow[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM batch_purchases
        WHERE ${OPEN_SQL} OR started_at >= $1 OR finished_at >= $1
        ORDER BY started_at DESC, id`,
      [since],
    );
    return result.rows.map(rowOf);
  }

  async listOpen(): Promise<BatchPurchaseRow[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM batch_purchases WHERE ${OPEN_SQL} ORDER BY started_at ASC, id`,
    );
    return result.rows.map(rowOf);
  }

  async update(id: string, change: BatchPurchaseChange): Promise<BatchPurchaseRow | 'busy' | null> {
    try {
      const result = await this.pool.query<Row>(
        `UPDATE batch_purchases
            SET state = COALESCE($2::text, state),
                batch_id = CASE WHEN $3::boolean THEN $4 ELSE batch_id END,
                tx_hash = COALESCE($5, tx_hash),
                error = CASE WHEN $6::boolean THEN $7 ELSE error END,
                stages = COALESCE($8::jsonb, stages),
                released_at = CASE WHEN $9::boolean THEN COALESCE(released_at, NOW()) ELSE released_at END,
                relayed_at = CASE $10::text WHEN 'sent' THEN NOW() WHEN 'unsent' THEN NULL ELSE relayed_at END,
                finished_at = CASE WHEN COALESCE($2::text, state) IN ('done', 'failed')
                                   THEN COALESCE(finished_at, NOW()) ELSE NULL END,
                updated_at = NOW()
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [
          id,
          change.state ?? null,
          change.batchId !== undefined,
          change.batchId ?? null,
          change.txHash ?? null,
          change.error !== undefined,
          change.error ?? null,
          change.stages === undefined ? null : JSON.stringify(change.stages),
          change.released === true,
          change.relayed ?? null,
        ],
      );
      return result.rows[0] ? rowOf(result.rows[0]) : null;
    } catch (error) {
      if (isOneOpenPerNode(error)) return 'busy';
      throw error;
    }
  }
}
