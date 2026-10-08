import type { Pool } from 'pg';

import type { FundingStampOperationKind, FundingTransferState } from '@streaming-monorepo/contracts';

/**
 * One stamp operation the web2 admin asked the manager for, as `funding_stamp_operations` (migration 052) holds it. A
 * row is written before the node is asked and keyed by the admin's request id, so the same request is answered from
 * here and the node is never asked twice, a manager that stopped mid-way included.
 */
export interface FundingStampOperationRow {
  requestId: string;
  kind: FundingStampOperationKind;
  nodeId: string;
  /** `0x` and 64 hex digits in lower case. */
  batchId: string;
  /** The batch's depth when the operation was asked for, which the node and the postage contract both reported. */
  expectedDepth: number;
  /** A dilution's depth after, one or two steps deeper; null for a top-up. */
  newDepth: number | null;
  /** A top-up's PLUR for each chunk, as a decimal string; null for a dilution. */
  amountPerChunkPlur: string | null;
  /** A top-up's xBZZ, `amountPerChunkPlur × 2^expectedDepth` in PLUR; null for a dilution, which costs gas alone. */
  costPlur: string | null;
  /** The batch's `normalisedBalance` in the postage contract before the node was asked, as a decimal string. */
  normalisedBalanceBefore: string;
  /** The transaction the node answered with, or null while it answered none. */
  txHash: string | null;
  state: FundingTransferState;
  /** Why it failed or is unknown, in a sentence, or null. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a later answer or reading changes on a row. */
export type FundingStampOperationPatch = Pick<FundingStampOperationRow, 'state' | 'txHash' | 'error' | 'updatedAt'>;

/** Where the manager journals stamp operations: the database, or an in-memory one in the unit tests. */
export interface FundingStampOperationJournal {
  find(requestId: string): Promise<FundingStampOperationRow | null>;
  /** Writes the row, and answers false without writing when its request id is journalled already. */
  insert(row: FundingStampOperationRow): Promise<boolean>;
  /**
   * Writes the patch only while the row is still in state `from`, and answers whether it did. The node's answer and
   * the status route's reading of the chain can both settle an `unknown` row; whichever comes second finds it moved
   * and leaves it.
   */
  update(requestId: string, from: FundingTransferState, patch: FundingStampOperationPatch): Promise<boolean>;
}

interface Row {
  request_id: string;
  kind: FundingStampOperationKind;
  node_id: string;
  batch_id: string;
  expected_depth: number;
  new_depth: number | null;
  amount_per_chunk: string | null;
  cost: string | null;
  normalised_balance_before: string;
  tx_hash: string | null;
  state: FundingTransferState;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = [
  'request_id',
  'kind',
  'node_id',
  'batch_id',
  'expected_depth',
  'new_depth',
  'amount_per_chunk::text AS amount_per_chunk',
  'cost::text AS cost',
  'normalised_balance_before::text AS normalised_balance_before',
  'tx_hash',
  'state',
  'error',
  'created_at',
  'updated_at',
].join(', ');

function rowOf(row: Row): FundingStampOperationRow {
  return {
    requestId: row.request_id,
    kind: row.kind,
    nodeId: row.node_id,
    batchId: row.batch_id,
    expectedDepth: Number(row.expected_depth),
    newDepth: row.new_depth === null ? null : Number(row.new_depth),
    amountPerChunkPlur: row.amount_per_chunk,
    costPlur: row.cost,
    normalisedBalanceBefore: row.normalised_balance_before,
    txHash: row.tx_hash,
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresFundingStampOperationJournal implements FundingStampOperationJournal {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async find(requestId: string): Promise<FundingStampOperationRow | null> {
    const result = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM funding_stamp_operations WHERE request_id = $1`, [
      requestId,
    ]);
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  async insert(row: FundingStampOperationRow): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO funding_stamp_operations
         (request_id, kind, node_id, batch_id, expected_depth, new_depth, amount_per_chunk, cost,
          normalised_balance_before, tx_hash, state, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10, $11, $12, $13, $14)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        row.requestId,
        row.kind,
        row.nodeId,
        row.batchId,
        row.expectedDepth,
        row.newDepth,
        row.amountPerChunkPlur,
        row.costPlur,
        row.normalisedBalanceBefore,
        row.txHash,
        row.state,
        row.error,
        row.createdAt,
        row.updatedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async update(requestId: string, from: FundingTransferState, patch: FundingStampOperationPatch): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE funding_stamp_operations SET state = $3, tx_hash = $4, error = $5, updated_at = $6
        WHERE request_id = $1 AND state = $2`,
      [requestId, from, patch.state, patch.txHash, patch.error, patch.updatedAt],
    );
    return result.rowCount === 1;
  }
}
