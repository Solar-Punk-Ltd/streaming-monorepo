import type { Pool } from 'pg';

import type { FundingTransferKind, FundingTransferState } from '@streaming-monorepo/contracts';

/**
 * One transfer the web2 admin asked the manager to broadcast, as `funding_transfers` (migration 050) holds it. A row
 * is written before the broadcast and keyed by the admin's request id, so the same request is answered from here
 * and never sent twice, a manager that stopped mid-way included.
 */
export interface FundingTransferRow {
  requestId: string;
  nodeId: string;
  kind: FundingTransferKind;
  /** The node's wallet, `0x` and 40 hex digits in lower case. */
  toAddress: string;
  /** Wei for xDAI, PLUR for xBZZ, as a decimal string. */
  amount: string;
  /** The address the transaction is signed by, recovered from it. */
  sender: string;
  /** keccak256 of the signed transaction, known before it is sent. */
  txHash: string;
  state: FundingTransferState;
  /** Why it failed or is unknown, in a sentence, or null. */
  error: string | null;
  blockNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a later reading changes on a row. */
export type FundingTransferPatch = Pick<FundingTransferRow, 'state' | 'error' | 'blockNumber' | 'updatedAt'>;

/** Where the manager journals funding transfers: the database, or an in-memory one in the unit tests. */
export interface FundingTransferJournal {
  find(requestId: string): Promise<FundingTransferRow | null>;
  /** Writes the row, and answers false without writing when its request id is journalled already. */
  insert(row: FundingTransferRow): Promise<boolean>;
  update(requestId: string, patch: FundingTransferPatch): Promise<void>;
}

interface Row {
  request_id: string;
  node_id: string;
  kind: FundingTransferKind;
  to_address: string;
  amount: string;
  sender: string;
  tx_hash: string;
  state: FundingTransferState;
  error: string | null;
  block_number: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'request_id, node_id, kind, to_address, amount::text AS amount, sender, tx_hash, state, error, block_number::text AS block_number, created_at, updated_at';

function rowOf(row: Row): FundingTransferRow {
  return {
    requestId: row.request_id,
    nodeId: row.node_id,
    kind: row.kind,
    toAddress: row.to_address,
    amount: row.amount,
    sender: row.sender,
    txHash: row.tx_hash,
    state: row.state,
    error: row.error,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresFundingTransferJournal implements FundingTransferJournal {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async find(requestId: string): Promise<FundingTransferRow | null> {
    const result = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM funding_transfers WHERE request_id = $1`, [
      requestId,
    ]);
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }

  async insert(row: FundingTransferRow): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO funding_transfers
         (request_id, node_id, kind, to_address, amount, sender, tx_hash, state, error, block_number, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        row.requestId,
        row.nodeId,
        row.kind,
        row.toAddress,
        row.amount,
        row.sender,
        row.txHash,
        row.state,
        row.error,
        row.blockNumber,
        row.createdAt,
        row.updatedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async update(requestId: string, patch: FundingTransferPatch): Promise<void> {
    await this.pool.query(
      `UPDATE funding_transfers SET state = $2, error = $3, block_number = $4, updated_at = $5 WHERE request_id = $1`,
      [requestId, patch.state, patch.error, patch.blockNumber, patch.updatedAt],
    );
  }
}
