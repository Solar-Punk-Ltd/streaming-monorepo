import type { FundingChequebookOperationRequest } from '@streaming-monorepo/contracts';
import type { FundingChequebookDirection, FundingItemState } from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import { inTransaction, isOpen, type SendLockOutcome, withAdvisoryLock } from './FundingTransferRepository.js';

/**
 * How long a `submitted` or `unknown` chequebook item still holds up a new chequebook bulk, counted from when the
 * manager answered its relay: the manager's receipt budget, `RECEIPT_POLL_BUDGET_MS`
 * (apps/infra-manager/common/src/chequebookOperations.ts), the 30 minutes it keeps reading the chain for a submitted
 * move's receipt, mirrored here and kept equal to it. Past it, the manager may hold the move so until an operator
 * settles it in the manager's console, after a crash in the middle of it, say. Letting the next bulk through then is
 * safe: the manager refuses a second move on a node while one is in flight there, `conflict`, and the item is still
 * asked about.
 */
export const FUNDING_CHEQUEBOOK_SETTLES_AFTER_MS = 30 * 60 * 1000;

/**
 * Whether the refresh still asks the manager about a chequebook item: while it is `queued`, until the manager has it,
 * and while it is `submitted` or `unknown`, which the manager settles from the chain, or an operator in the manager's
 * console. A `confirmed` or `failed` chequebook item is settled for good: the manager changes neither, as it changes
 * no stamp operation's. Nothing else changes once written.
 */
export function isChequebookAsked(row: Pick<FundingChequebookRow, 'state'>): boolean {
  return isOpen(row.state) || row.state === 'unknown';
}

/**
 * Whether a chequebook item holds up a new chequebook bulk at `now`: while it is `queued`, whatever its age, since the
 * manager may not have it yet; and while it is `submitted` or `unknown` and the manager answered its relay at most
 * {@link FUNDING_CHEQUEBOOK_SETTLES_AFTER_MS} before. A move still under way changes the balances the next bulk is
 * checked against. Every other item is settled for that gate: `confirmed`, `failed`, and `submitted` or `unknown` for
 * longer than that, which is still asked about ({@link isChequebookAsked}).
 */
export function holdsChequebookBulk(
  row: Pick<FundingChequebookRow, 'state' | 'relayedAt' | 'createdAt'>,
  now: number,
): boolean {
  if (row.state === 'queued') return true;
  if (row.state !== 'submitted' && row.state !== 'unknown') return false;
  // When the manager first answered for it. `createdAt` stands in only for a row written otherwise, as for a send.
  const answeredAt = row.relayedAt ?? row.createdAt;
  return now - answeredAt.getTime() <= FUNDING_CHEQUEBOOK_SETTLES_AFTER_MS;
}

/** The oldest moment the manager can have answered a relay at and its item still hold up a bulk at `now`. */
export function chequebookCutoff(now: Date): Date {
  return new Date(now.getTime() - FUNDING_CHEQUEBOOK_SETTLES_AFTER_MS);
}

/** One row of `funding_chequebook_operations`, migration 019. */
export interface FundingChequebookRow {
  requestId: string;
  bulkId: string;
  /** The item's place in its request, from 0: the order it is relayed in. */
  position: number;
  nodeId: string;
  nodeLabel: string;
  direction: FundingChequebookDirection;
  /** What moves, PLUR as a decimal string, more than nothing and 30 digits at most. */
  amountPlur: string;
  /** The available balance the request brings the chequebook to, PLUR as a decimal string. */
  targetPlur: string;
  /**
   * The chequebook's available balance the move was worked out from, PLUR as a decimal string: of the page's and the
   * one read when the request came in, the larger for a deposit and the smaller for a withdrawal. The move brings it
   * to the target.
   */
  availablePlur: string;
  state: FundingItemState;
  /** The hash the manager answered, or null until it answered one. */
  txHash: string | null;
  error: string | null;
  /**
   * When the admin recorded the manager's first answer for it, to a relay or to the status read that found a relay
   * whose answer was lost, by the service's clock; and its answer to a relay again, for an item `submitted` with no
   * hash that the manager then held nothing under. Null while the item is `queued`, and on an item failed before the
   * manager ever answered for it. A `submitted` or `unknown` item's 30 minutes count from it.
   */
  relayedAt: Date | null;
  requestedByUserId: string | null;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** An item as a request journals it, before any relay: `queued`, with no hash, no error, not relayed. */
export type NewFundingChequebookOperation = Omit<
  FundingChequebookRow,
  'state' | 'txHash' | 'error' | 'relayedAt' | 'createdAt' | 'updatedAt'
>;

/** What an answer of the manager, or the admin's own refusal, moves on an item. */
export interface FundingChequebookUpdate {
  state: FundingItemState;
  error: string | null;
  /** The hash the manager answered. Left out or null keeps the one recorded: a hash, once known, stays. */
  txHash?: string | null;
  /** Set when this records the manager's first answer for the item: the moment that answer came back. */
  relayedAt?: Date;
}

/** What a request that tried the chequebook lock got: its result, or nothing because another request holds it. */
export type ChequebookLockOutcome<T> = SendLockOutcome<T>;

/**
 * The manager's request of a journalled item, `POST /api/admin-funding/chequebook-operations`: built from the journal
 * alone, so every relay of an item, a relay again after `unknown_request` among them, sends the same fields under the
 * same request id, and the manager takes it for the same operation.
 */
export function chequebookRequestOf(row: FundingChequebookRow): FundingChequebookOperationRequest {
  return { requestId: row.requestId, nodeId: row.nodeId, direction: row.direction, amountPlur: row.amountPlur };
}

/** Where the chequebook service journals the operations it relays: Postgres, or memory in the unit tests. */
export interface FundingChequebookStore {
  /**
   * Runs `work` while holding the one lock every chequebook request takes, or answers `{ locked: false }` without
   * running it when another request holds it, in this process or another. Taken without waiting, so two requests at
   * once never both get past the check that no item holds up a bulk. Neither the send lock nor the stamp lock: a
   * chequebook bulk, a stamp bulk and a send do not hold each other up.
   */
  withChequebookLock<T>(work: () => Promise<T>): Promise<ChequebookLockOutcome<T>>;
  /** Whether any item of any chequebook bulk holds up a new one at `now` ({@link holdsChequebookBulk}). */
  hasUnsettled(now: Date): Promise<boolean>;
  /** The chequebook bulks with an item that holds up a new one at `now`, the latest first, `limit` of them at most. */
  openBulkIds(limit: number, now: Date): Promise<string[]>;
  /** The chequebook bulks with an item still asked about ({@link isChequebookAsked}), the latest first, `limit` at most. */
  askedBulkIds(limit: number): Promise<string[]>;
  /** Journals every item of a request, `queued`, all of them or none. */
  insertAll(items: readonly NewFundingChequebookOperation[]): Promise<void>;
  /** The items of a chequebook bulk in their order, empty for a bulk id never journalled. */
  listBulk(bulkId: string): Promise<FundingChequebookRow[]>;
  /**
   * Records what moved on one item, only while it is still asked about, and answers the row as it now stands. Null
   * when it is settled for good, or gone, and then nothing is written: such an item never changes.
   */
  update(requestId: string, update: FundingChequebookUpdate): Promise<FundingChequebookRow | null>;
}

interface Row {
  request_id: string;
  bulk_id: string;
  position: number;
  node_id: string;
  node_label: string;
  direction: FundingChequebookDirection;
  amount_plur: string;
  target_plur: string;
  available_plur: string;
  state: FundingItemState;
  tx_hash: string | null;
  error: string | null;
  relayed_at: Date | null;
  requested_by_user_id: string | null;
  requested_by: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `request_id::text AS request_id, bulk_id::text AS bulk_id, position, node_id, node_label, direction,
  amount_plur::text AS amount_plur, target_plur::text AS target_plur, available_plur::text AS available_plur, state,
  tx_hash, error, relayed_at, requested_by_user_id::text AS requested_by_user_id, requested_by, created_at,
  updated_at`;

/** The columns a request writes, in the order {@link valuesOf} answers them. */
const INSERTED = `request_id, bulk_id, position, node_id, node_label, direction, amount_plur, target_plur,
  available_plur, state, requested_by_user_id, requested_by`;

/**
 * {@link holdsChequebookBulk} in SQL, with the cutoff ({@link chequebookCutoff}) as the parameter it names. It implies
 * migration 019's partial index predicate, `state IN ('queued', 'submitted', 'unknown')`, so the index serves it.
 */
function holdsBulkSql(cutoff: string): string {
  return `(state = 'queued' OR (state IN ('submitted', 'unknown') AND COALESCE(relayed_at, created_at) >= ${cutoff}))`;
}

/** {@link isChequebookAsked} in SQL: exactly migration 019's partial index predicate. */
const ASKED_SQL = `state IN ('queued', 'submitted', 'unknown')`;

/** The key of the advisory lock every chequebook request takes, by its name, beside the send and stamp locks'. */
const CHEQUEBOOK_LOCK_NAME = 'web2-admin:funding-chequebooks';

function rowOf(row: Row): FundingChequebookRow {
  return {
    requestId: row.request_id,
    bulkId: row.bulk_id,
    position: Number(row.position),
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    direction: row.direction,
    amountPlur: row.amount_plur,
    targetPlur: row.target_plur,
    availablePlur: row.available_plur,
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
function valuesOf(item: NewFundingChequebookOperation): unknown[] {
  return [
    item.requestId,
    item.bulkId,
    item.position,
    item.nodeId,
    item.nodeLabel,
    item.direction,
    item.amountPlur,
    item.targetPlur,
    item.availablePlur,
    'queued',
    item.requestedByUserId,
    item.requestedBy,
  ];
}

/**
 * The chequebook journal, migration 019. The chequebook lock is a session advisory lock of its own
 * ({@link withAdvisoryLock}): one chequebook request at a time across every process on the database, whatever a send
 * or a stamp request does meanwhile.
 */
export class FundingChequebookRepository implements FundingChequebookStore {
  constructor(private readonly pool: Pool) {}

  withChequebookLock<T>(work: () => Promise<T>): Promise<ChequebookLockOutcome<T>> {
    return withAdvisoryLock(this.pool, CHEQUEBOOK_LOCK_NAME, work);
  }

  async hasUnsettled(now: Date): Promise<boolean> {
    const result = await this.pool.query<{ unsettled: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM funding_chequebook_operations WHERE ${holdsBulkSql('$1')}) AS unsettled`,
      [chequebookCutoff(now)],
    );
    return result.rows[0]?.unsettled === true;
  }

  openBulkIds(limit: number, now: Date): Promise<string[]> {
    return this.bulkIdsWhere(holdsBulkSql('$2'), limit, [chequebookCutoff(now)]);
  }

  askedBulkIds(limit: number): Promise<string[]> {
    return this.bulkIdsWhere(ASKED_SQL, limit);
  }

  private async bulkIdsWhere(predicate: string, limit: number, params: unknown[] = []): Promise<string[]> {
    const result = await this.pool.query<{ bulk_id: string }>(
      `SELECT bulk_id::text AS bulk_id FROM funding_chequebook_operations
        WHERE ${predicate}
        GROUP BY bulk_id
        ORDER BY MAX(created_at) DESC, bulk_id
        LIMIT $1`,
      [limit, ...params],
    );
    return result.rows.map((row) => row.bulk_id);
  }

  async insertAll(items: readonly NewFundingChequebookOperation[]): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      for (const item of items) {
        await client.query(
          `INSERT INTO funding_chequebook_operations (${INSERTED})
           VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10, $11, $12)`,
          valuesOf(item),
        );
      }
    });
  }

  async listBulk(bulkId: string): Promise<FundingChequebookRow[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM funding_chequebook_operations WHERE bulk_id = $1 ORDER BY position ASC`,
      [bulkId],
    );
    return result.rows.map(rowOf);
  }

  async update(requestId: string, update: FundingChequebookUpdate): Promise<FundingChequebookRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE funding_chequebook_operations
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
