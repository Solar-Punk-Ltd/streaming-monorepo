import type { Pool } from 'pg';

import type { FundingTransferState } from '@streaming-monorepo/contracts';

/**
 * One archive stamp purchase the web2 admin asked the manager for, as `funding_stamp_purchases` (migration 055) holds
 * it. A row is written before the node is asked and keyed by the admin's request id, so the same request is answered
 * from here and the node never buys twice, a manager that stopped mid-way included.
 */
export interface FundingStampPurchaseRow {
  requestId: string;
  /** The inventory's opaque id of the catalogue node that buys the batch. */
  nodeId: string;
  /** The batch's depth, 17 to 41. */
  depth: number;
  /** The PLUR each of the batch's chunks is given, as a decimal string. */
  amountPerChunkPlur: string;
  /** What the batch costs, `amountPerChunkPlur × 2^depth` in PLUR, paid in xBZZ from the node's wallet. */
  costPlur: string;
  /** The name the batch carries in the manager and the admin, or null. */
  label: string | null;
  /**
   * The label the batch carries on its node, `archive-` and the first twelve hex digits of the request id, by which a
   * lost answer is found again.
   */
  nodeLabel: string;
  /** The batch, `0x` and 64 hex digits in lower case, or null until the node answered or the row was settled. */
  batchId: string | null;
  /** The transaction the node answered with, or null while it answered none. */
  txHash: string | null;
  state: FundingTransferState;
  /** Why it failed or is unknown, in a sentence, or null. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * When a confirmed purchase's batch was made an archive batch, or null until it was. Once it is set the batch is
   * never designated again, so one taken off the list stays off it.
   */
  recordedAt: Date | null;
}

/** What a later answer or reading changes on a row. */
export type FundingStampPurchasePatch = Pick<
  FundingStampPurchaseRow,
  'state' | 'batchId' | 'txHash' | 'error' | 'updatedAt'
>;

/**
 * What an insert came to: the row written; nothing written because the request id is journalled already; nothing
 * written because another purchase on the same node is still being settled, of which the table holds one at a time;
 * or nothing written because another purchase's node label, the first twelve hex digits of its request id, is this
 * one's too.
 */
export type FundingStampPurchaseInsert = 'inserted' | 'request_taken' | 'node_busy' | 'label_taken';

/** Where the manager journals stamp purchases: the database, or an in-memory one in the unit tests. */
export interface FundingStampPurchaseJournal {
  find(requestId: string): Promise<FundingStampPurchaseRow | null>;
  /** The purchase on this node that is still being settled, `unknown` or `submitted`, or null. */
  openOn(nodeId: string): Promise<FundingStampPurchaseRow | null>;
  /** Writes the row, unless its request id is journalled already or another purchase is open on its node. */
  insert(row: FundingStampPurchaseRow): Promise<FundingStampPurchaseInsert>;
  /**
   * Writes the patch only while the row is still in state `from`, and answers whether it did. The node's answer and
   * the status route's reading of the node's batches can both settle an `unknown` row; whichever comes second finds it
   * moved and leaves it.
   */
  update(requestId: string, from: FundingTransferState, patch: FundingStampPurchasePatch): Promise<boolean>;
  /** Marks a confirmed purchase's batch as made an archive batch, once, and answers whether it did. */
  markRecorded(requestId: string, at: Date): Promise<boolean>;
  /**
   * The purchases neither recorded nor failed: still open, or confirmed with a batch not made an archive batch yet.
   * Each holds a place on the catalogue stamp record's list of archive batches.
   */
  unrecorded(): Promise<FundingStampPurchaseRow[]>;
}

interface Row {
  request_id: string;
  node_id: string;
  depth: number;
  amount_per_chunk: string;
  cost: string;
  label: string | null;
  node_label: string;
  batch_id: string | null;
  tx_hash: string | null;
  state: FundingTransferState;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  recorded_at: Date | null;
}

const COLUMNS = [
  'request_id',
  'node_id',
  'depth',
  'amount_per_chunk::text AS amount_per_chunk',
  'cost::text AS cost',
  'label',
  'node_label',
  'batch_id',
  'tx_hash',
  'state',
  'error',
  'created_at',
  'updated_at',
  'recorded_at',
].join(', ');

/** Migration 055's partial unique index, which holds one open purchase per node. */
const ONE_OPEN_PER_NODE = 'funding_stamp_purchases_one_open_per_node';

/** Migration 055's unique constraint on the label a purchase's batch carries on its node. */
const ONE_PURCHASE_PER_NODE_LABEL = 'funding_stamp_purchases_node_label_key';

/** PostgreSQL's code for a unique violation. */
const UNIQUE_VIOLATION = '23505';

function rowOf(row: Row): FundingStampPurchaseRow {
  return {
    requestId: row.request_id,
    nodeId: row.node_id,
    depth: Number(row.depth),
    amountPerChunkPlur: row.amount_per_chunk,
    costPlur: row.cost,
    label: row.label,
    nodeLabel: row.node_label,
    batchId: row.batch_id,
    txHash: row.tx_hash,
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recordedAt: row.recorded_at,
  };
}

/** The unique constraint a failed insert met, or null for any other failure. */
function uniqueViolationOf(err: unknown): string | null {
  const { code, constraint } = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    constraint?: unknown;
  };
  return code === UNIQUE_VIOLATION && typeof constraint === 'string' ? constraint : null;
}

export class PostgresFundingStampPurchaseJournal implements FundingStampPurchaseJournal {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async find(requestId: string): Promise<FundingStampPurchaseRow | null> {
    const result = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM funding_stamp_purchases WHERE request_id = $1`, [
      requestId,
    ]);
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  async openOn(nodeId: string): Promise<FundingStampPurchaseRow | null> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM funding_stamp_purchases
        WHERE node_id = $1 AND state IN ('unknown', 'submitted')
        ORDER BY created_at, request_id
        LIMIT 1`,
      [nodeId],
    );
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  async insert(row: FundingStampPurchaseRow): Promise<FundingStampPurchaseInsert> {
    try {
      const result = await this.pool.query(
        `INSERT INTO funding_stamp_purchases
           (request_id, node_id, depth, amount_per_chunk, cost, label, node_label, batch_id, tx_hash, state, error,
            created_at, updated_at, recorded_at)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          row.requestId,
          row.nodeId,
          row.depth,
          row.amountPerChunkPlur,
          row.costPlur,
          row.label,
          row.nodeLabel,
          row.batchId,
          row.txHash,
          row.state,
          row.error,
          row.createdAt,
          row.updatedAt,
          row.recordedAt,
        ],
      );
      return result.rowCount === 1 ? 'inserted' : 'request_taken';
    } catch (err) {
      const violated = uniqueViolationOf(err);
      if (violated === ONE_OPEN_PER_NODE) return 'node_busy';
      if (violated === ONE_PURCHASE_PER_NODE_LABEL) return 'label_taken';
      throw err;
    }
  }

  async update(requestId: string, from: FundingTransferState, patch: FundingStampPurchasePatch): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE funding_stamp_purchases SET state = $3, batch_id = $4, tx_hash = $5, error = $6, updated_at = $7
        WHERE request_id = $1 AND state = $2`,
      [requestId, from, patch.state, patch.batchId, patch.txHash, patch.error, patch.updatedAt],
    );
    return result.rowCount === 1;
  }

  async markRecorded(requestId: string, at: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE funding_stamp_purchases SET recorded_at = $2
        WHERE request_id = $1 AND state = 'confirmed' AND recorded_at IS NULL`,
      [requestId, at],
    );
    return result.rowCount === 1;
  }

  async unrecorded(): Promise<FundingStampPurchaseRow[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM funding_stamp_purchases
        WHERE state <> 'failed' AND recorded_at IS NULL
        ORDER BY created_at, request_id`,
    );
    return result.rows.map(rowOf);
  }
}
