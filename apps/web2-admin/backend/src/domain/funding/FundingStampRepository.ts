import type { FundingStampOperationRequest } from '@streaming-monorepo/contracts';
import type {
  FundingDiluteSteps,
  FundingItemState,
  FundingStampOperationKind,
} from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import {
  holdsSend,
  inTransaction,
  isOpen,
  type SendLockOutcome,
  unknownCutoff,
  withAdvisoryLock,
} from './FundingTransferRepository.js';

/**
 * Whether the refresh still asks the manager about a stamp item: while it is open (`queued` or `submitted`), and
 * while it is `unknown`, which the manager reads from the chain for its 30 minutes and then calls `confirmed` or
 * `failed`. A `confirmed` or `failed` stamp item is settled for good: the manager never changes either, since it
 * reads only an unknown operation from the chain. Nothing else changes once written.
 */
export function isStampAsked(row: Pick<FundingStampRow, 'state'>): boolean {
  return isOpen(row.state) || row.state === 'unknown';
}

/**
 * Whether a stamp item holds up a new stamp bulk at `now`, by the rule an item of a send holds up a send
 * ({@link holdsSend}): while it is open, and while it is `unknown` and the manager answered its relay at most 30
 * minutes before. An operation still under way moves the balances and the depths the next bulk is checked against.
 */
export function holdsStampBulk(row: Pick<FundingStampRow, 'state' | 'relayedAt' | 'createdAt'>, now: number): boolean {
  return holdsSend(row, now);
}

/** One row of `funding_stamp_operations`, migration 018. */
export interface FundingStampRow {
  requestId: string;
  bulkId: string;
  /** The item's place in its request, from 0: the order it is relayed in. */
  position: number;
  nodeId: string;
  nodeLabel: string;
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  kind: FundingStampOperationKind;
  /** The days a top-up buys, or null for a dilution. */
  days: number | null;
  /** The steps a dilution takes, or null for a top-up. */
  steps: FundingDiluteSteps | null;
  /** The depth the page showed and the admin checked, which the manager holds the batch to. */
  expectedDepth: number;
  /** A dilution's depth after it, `expectedDepth + steps`, or null for a top-up. */
  newDepth: number | null;
  /** What a top-up adds to each chunk, PLUR as a decimal string, or null for a dilution. */
  amountPerChunkPlur: string | null;
  /** What a top-up takes from the node's wallet, PLUR as a decimal string, or null for a dilution. */
  costPlur: string | null;
  state: FundingItemState;
  /** The hash the manager answered, or null until it answered one. */
  txHash: string | null;
  error: string | null;
  /**
   * When the admin recorded the manager's first answer for it, to a relay or to the status read that found a relay
   * whose answer was lost, by the service's clock. Null while the item is `queued`, and on an item failed before the
   * manager ever answered for it. An `unknown` item's 30 minutes count from it.
   */
  relayedAt: Date | null;
  requestedByUserId: string | null;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** An item as a request journals it, before any relay: `queued`, with no hash, no error, not relayed. */
export type NewFundingStampOperation = Omit<
  FundingStampRow,
  'state' | 'txHash' | 'error' | 'relayedAt' | 'createdAt' | 'updatedAt'
>;

/** What an answer of the manager, or the admin's own refusal, moves on an item. */
export interface FundingStampUpdate {
  state: FundingItemState;
  error: string | null;
  /** The hash the manager answered. Left out or null keeps the one recorded: a hash, once known, stays. */
  txHash?: string | null;
  /** Set when this records the manager's first answer for the item: the moment that answer came back. */
  relayedAt?: Date;
}

/** What a request that tried the stamp lock got: its result, or nothing because another request holds the lock. */
export type StampLockOutcome<T> = SendLockOutcome<T>;

/**
 * The manager's request of a journalled item, `POST /api/admin-funding/stamp-operations`: built from the journal
 * alone, so every relay of an item, a relay again after `unknown_request` among them, sends the same fields under the
 * same request id, and the manager takes it for the same operation.
 */
export function stampRequestOf(row: FundingStampRow): FundingStampOperationRequest {
  const { requestId, nodeId, batchId, expectedDepth } = row;
  if (row.kind === 'topup') {
    if (row.amountPerChunkPlur === null) throw new Error(`Stamp operation ${requestId} is a top-up with no amount.`);
    return { requestId, kind: 'topup', nodeId, batchId, expectedDepth, amountPerChunkPlur: row.amountPerChunkPlur };
  }
  if (row.newDepth === null) throw new Error(`Stamp operation ${requestId} is a dilution with no new depth.`);
  return { requestId, kind: 'dilute', nodeId, batchId, expectedDepth, newDepth: row.newDepth };
}

/** Where the stamp service journals the operations it relays: Postgres, or memory in the unit tests. */
export interface FundingStampStore {
  /**
   * Runs `work` while holding the one lock every stamp request takes, or answers `{ locked: false }` without running
   * it when another request holds it, in this process or another. Taken without waiting, so two requests at once never
   * both get past the check that no item holds up a bulk. Not the send lock: a send and a stamp bulk do not hold each
   * other up.
   */
  withStampLock<T>(work: () => Promise<T>): Promise<StampLockOutcome<T>>;
  /** Whether any item of any stamp bulk holds up a new one at `now` ({@link holdsStampBulk}). */
  hasUnsettled(now: Date): Promise<boolean>;
  /** The stamp bulks with an item that holds up a new one at `now`, the latest first, `limit` of them at most. */
  openBulkIds(limit: number, now: Date): Promise<string[]>;
  /** The stamp bulks with an item still asked about ({@link isStampAsked}), the latest first, `limit` at most. */
  askedBulkIds(limit: number): Promise<string[]>;
  /** Journals every item of a request, `queued`, all of them or none. */
  insertAll(items: readonly NewFundingStampOperation[]): Promise<void>;
  /** The items of a stamp bulk in their order, empty for a bulk id never journalled. */
  listBulk(bulkId: string): Promise<FundingStampRow[]>;
  /**
   * Records what moved on one item, only while it is still asked about, and answers the row as it now stands. Null
   * when it is settled for good, or gone, and then nothing is written: such an item never changes.
   */
  update(requestId: string, update: FundingStampUpdate): Promise<FundingStampRow | null>;
}

interface Row {
  request_id: string;
  bulk_id: string;
  position: number;
  node_id: string;
  node_label: string;
  batch_id: string;
  kind: FundingStampOperationKind;
  days: number | null;
  steps: number | null;
  expected_depth: number;
  new_depth: number | null;
  amount_per_chunk_plur: string | null;
  cost_plur: string | null;
  state: FundingItemState;
  tx_hash: string | null;
  error: string | null;
  relayed_at: Date | null;
  requested_by_user_id: string | null;
  requested_by: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `request_id::text AS request_id, bulk_id::text AS bulk_id, position, node_id, node_label, batch_id,
  kind, days, steps, expected_depth, new_depth, amount_per_chunk_plur::text AS amount_per_chunk_plur,
  cost_plur::text AS cost_plur, state, tx_hash, error, relayed_at,
  requested_by_user_id::text AS requested_by_user_id, requested_by, created_at, updated_at`;

/** The columns a request writes, in the order {@link valuesOf} answers them. */
const INSERTED = `request_id, bulk_id, position, node_id, node_label, batch_id, kind, days, steps, expected_depth,
  new_depth, amount_per_chunk_plur, cost_plur, state, requested_by_user_id, requested_by`;

/** {@link OPEN_SQL} of the transfers, on this table: queued or submitted. */
const OPEN_SQL = `state IN ('queued', 'submitted')`;

/**
 * {@link holdsStampBulk} in SQL, with the cutoff ({@link unknownCutoff}) as the parameter it names. It implies
 * migration 018's partial index predicate, `state IN ('queued', 'submitted', 'unknown')`, so the index serves it.
 */
function holdsBulkSql(cutoff: string): string {
  return `(${OPEN_SQL} OR (state = 'unknown' AND COALESCE(relayed_at, created_at) >= ${cutoff}))`;
}

/** {@link isStampAsked} in SQL: exactly migration 018's partial index predicate. */
const ASKED_SQL = `state IN ('queued', 'submitted', 'unknown')`;

/** The key of the advisory lock every stamp request takes, by its name, beside the send lock's. */
const STAMP_LOCK_NAME = 'web2-admin:funding-stamps';

function rowOf(row: Row): FundingStampRow {
  return {
    requestId: row.request_id,
    bulkId: row.bulk_id,
    position: Number(row.position),
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    batchId: row.batch_id,
    kind: row.kind,
    days: row.days === null ? null : Number(row.days),
    steps: row.steps === 1 || row.steps === 2 ? row.steps : null,
    expectedDepth: Number(row.expected_depth),
    newDepth: row.new_depth === null ? null : Number(row.new_depth),
    amountPerChunkPlur: row.amount_per_chunk_plur,
    costPlur: row.cost_plur,
    state: row.state,
    txHash: row.tx_hash,
    error: row.error,
    relayedAt: row.relayed_at,
    requestedByUserId: row.requested_by_user_id,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The values of one item, in the order of {@link INSERTED}. */
function valuesOf(item: NewFundingStampOperation): unknown[] {
  return [
    item.requestId,
    item.bulkId,
    item.position,
    item.nodeId,
    item.nodeLabel,
    item.batchId,
    item.kind,
    item.days,
    item.steps,
    item.expectedDepth,
    item.newDepth,
    item.amountPerChunkPlur,
    item.costPlur,
    'queued',
    item.requestedByUserId,
    item.requestedBy,
  ];
}

/**
 * The stamp journal, migration 018. The stamp lock is a session advisory lock of its own ({@link withAdvisoryLock}):
 * one stamp request at a time across every process on the database, whatever a send does meanwhile.
 */
export class FundingStampRepository implements FundingStampStore {
  constructor(private readonly pool: Pool) {}

  withStampLock<T>(work: () => Promise<T>): Promise<StampLockOutcome<T>> {
    return withAdvisoryLock(this.pool, STAMP_LOCK_NAME, work);
  }

  async hasUnsettled(now: Date): Promise<boolean> {
    const result = await this.pool.query<{ unsettled: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM funding_stamp_operations WHERE ${holdsBulkSql('$1')}) AS unsettled`,
      [unknownCutoff(now)],
    );
    return result.rows[0]?.unsettled === true;
  }

  openBulkIds(limit: number, now: Date): Promise<string[]> {
    return this.bulkIdsWhere(holdsBulkSql('$2'), limit, [unknownCutoff(now)]);
  }

  askedBulkIds(limit: number): Promise<string[]> {
    return this.bulkIdsWhere(ASKED_SQL, limit);
  }

  private async bulkIdsWhere(predicate: string, limit: number, params: unknown[] = []): Promise<string[]> {
    const result = await this.pool.query<{ bulk_id: string }>(
      `SELECT bulk_id::text AS bulk_id FROM funding_stamp_operations
        WHERE ${predicate}
        GROUP BY bulk_id
        ORDER BY MAX(created_at) DESC, bulk_id
        LIMIT $1`,
      [limit, ...params],
    );
    return result.rows.map((row) => row.bulk_id);
  }

  async insertAll(items: readonly NewFundingStampOperation[]): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      for (const item of items) {
        await client.query(
          `INSERT INTO funding_stamp_operations (${INSERTED})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, $13::numeric, $14, $15, $16)`,
          valuesOf(item),
        );
      }
    });
  }

  async listBulk(bulkId: string): Promise<FundingStampRow[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM funding_stamp_operations WHERE bulk_id = $1 ORDER BY position ASC`,
      [bulkId],
    );
    return result.rows.map(rowOf);
  }

  async update(requestId: string, update: FundingStampUpdate): Promise<FundingStampRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE funding_stamp_operations
          SET state = $2,
              error = $3,
              tx_hash = COALESCE($4, tx_hash),
              relayed_at = COALESCE($5, relayed_at),
              updated_at = NOW()
        WHERE request_id = $1 AND ${ASKED_SQL}
        RETURNING ${COLUMNS}`,
      [requestId, update.state, update.error, update.txHash ?? null, update.relayedAt ?? null],
    );
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }
}
