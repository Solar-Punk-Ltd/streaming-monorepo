import type { FundingItemState, FundingTransferKind } from '@streaming-monorepo/web2-admin-common';
import { Pool, PoolClient } from 'pg';

/**
 * The states an item is open in: the manager has not answered for it yet (`queued`) or the chain holds it (`submitted`).
 * An open item holds up a new send, which would sign over its nonce, whatever its age.
 */
export const OPEN_STATES: readonly FundingItemState[] = ['queued', 'submitted'];

export function isOpen(state: FundingItemState): boolean {
  return OPEN_STATES.includes(state);
}

/**
 * How long an `unknown` item still holds up a new send, counted from when the manager answered its relay: the
 * manager's `FUNDING_UNKNOWN_AFTER_MS` (apps/infra-manager/manager/src/domain/funding/FundingChainService.ts), mirrored
 * here and kept equal to it. The manager answers `unknown` in two cases: when the answer of `eth_sendRawTransaction` was
 * lost, and the transaction may well sit in the chain's pool at its nonce; and once it has no receipt and the chain has
 * not held the transaction for this long since the manager journalled it. Only after this long can the next send safely
 * reuse its nonce, so that at most one of the two is ever mined.
 *
 * The manager counts from its own journal row, written when the relay reaches it, which may be long after the admin
 * journalled the item (the manager was out of reach, or never received it and it was relayed again). So the admin
 * counts from `relayed_at`, which it writes once the manager's answer to a relay is back: at or after the manager's own
 * moment, so the admin's window never ends before the manager's. That is the safe side: a window that ends late only
 * holds a send back longer, one that ends early pays a node twice.
 */
export const FUNDING_UNKNOWN_SETTLES_AFTER_MS = 30 * 60 * 1000;

/**
 * When an `unknown` item's window starts: when the manager first answered for it, to a relay or, for a relay whose
 * answer was lost, to the status read that found it. `relayedAt` is null while the item is `queued`, before the
 * manager has answered for it, and stays null on an item failed before it ever did (the manager refused the relay, or
 * it was never sent after one before it failed). Every write that moves a `queued` item to one of the manager's states
 * sets it, so the service never writes an `unknown` item without it; the journal's moment is only a backstop for a row
 * written otherwise, so that no item holds a send forever.
 */
function windowStart(row: Pick<FundingTransferRow, 'relayedAt' | 'createdAt'>): Date {
  return row.relayedAt ?? row.createdAt;
}

/**
 * Whether an item holds up a new send at `now`: while it is open, and while it is `unknown` and the manager answered its
 * relay at most {@link FUNDING_UNKNOWN_SETTLES_AFTER_MS} before. Every other item is settled for that gate:
 * `confirmed`, `failed`, and `unknown` for longer than that. A `submitted` item that the manager's own 30-minute rule
 * turns `unknown` was answered more than 30 minutes before, so it settles at once.
 */
export function holdsSend(row: Pick<FundingTransferRow, 'state' | 'relayedAt' | 'createdAt'>, now: number): boolean {
  if (isOpen(row.state)) return true;
  return row.state === 'unknown' && now - windowStart(row).getTime() <= FUNDING_UNKNOWN_SETTLES_AFTER_MS;
}

/** The oldest moment the manager can have answered an `unknown` item's relay at and it still hold up a send at `now`. */
export function unknownCutoff(now: Date): Date {
  return new Date(now.getTime() - FUNDING_UNKNOWN_SETTLES_AFTER_MS);
}

/**
 * Whether the refresh still asks the manager about an item: while it is open, and while it is watched, settled for the
 * gate but not for good (`unknown`, or `failed` with no block by the chain's node), since a late receipt may still
 * turn it `confirmed`. Nothing else changes once written.
 */
export function isAsked(row: Pick<FundingTransferRow, 'state' | 'watched'>): boolean {
  return isOpen(row.state) || row.watched;
}

/** One row of `funding_transfers`, migration 016. */
export interface FundingTransferRow {
  requestId: string;
  bulkId: string;
  nodeId: string;
  nodeLabel: string;
  toAddress: string;
  kind: FundingTransferKind;
  /** Base units, as a decimal string. */
  amount: string;
  nonce: number;
  /** The signed transaction. Kept for a relay again, byte for byte; never answered, logged or audited. */
  rawTransaction: string;
  txHash: string;
  state: FundingItemState;
  error: string | null;
  blockNumber: number | null;
  /** Settled for the gate, but still asked about: `unknown`, or `failed` with no block by the chain's node. */
  watched: boolean;
  /**
   * When the admin last recorded the manager's answer to a relay of it, or first found by a status read a relay whose
   * answer was lost, by the service's clock. Null while the item is `queued`, and on an item failed before the manager
   * ever answered for it.
   * An `unknown` item's 30 minutes count from it ({@link FUNDING_UNKNOWN_SETTLES_AFTER_MS}).
   */
  relayedAt: Date | null;
  requestedByUserId: string | null;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** An item as the send journals it, before any relay: `queued`, with no error and no block, not watched, not relayed. */
export type NewFundingTransfer = Omit<
  FundingTransferRow,
  'state' | 'error' | 'blockNumber' | 'watched' | 'relayedAt' | 'createdAt' | 'updatedAt'
>;

/**
 * What an answer of the manager, or the admin's own refusal, moves on an item. The hash is never among it: the one
 * journalled is the hash of the bytes signed, which the chain mines them under. `blockNumber` left out keeps the one
 * recorded.
 */
export interface FundingTransferUpdate {
  state: FundingItemState;
  error: string | null;
  blockNumber?: number | null;
  /** Whether the item stays asked about once settled for the gate (see {@link isAsked}). */
  watched: boolean;
  /** Set when this records the manager's answer to a relay: the moment that answer came back. Left out keeps it. */
  relayedAt?: Date;
}

/** What a send that tried the lock got: its result, or nothing because another send holds the lock. */
export type SendLockOutcome<T> = { locked: false } | { locked: true; result: T };

/** Where the funding service journals the items it signs: Postgres, or memory in the unit tests. */
export interface FundingTransferStore {
  /**
   * Runs `work` while holding the one lock every send takes, or answers `{ locked: false }` without running it when
   * another send holds the lock, in this process or another. Taken without waiting, so two sends at once never both
   * get past the check that no item holds up a send.
   */
  withSendLock<T>(work: () => Promise<T>): Promise<SendLockOutcome<T>>;
  /** Whether any item of any send holds up a new one at `now` ({@link holdsSend}). */
  hasUnsettled(now: Date): Promise<boolean>;
  /** The sends with an item that holds up a new one at `now`, the latest first, `limit` of them at most. */
  openBulkIds(limit: number, now: Date): Promise<string[]>;
  /** The sends with an item still asked about, open or watched, the latest first, `limit` of them at most. */
  askedBulkIds(limit: number): Promise<string[]>;
  /** Journals every item of a send, `queued`, all of them or none. */
  insertAll(items: readonly NewFundingTransfer[]): Promise<void>;
  /** The items of a send in nonce order, empty for a bulk id never sent. */
  listBulk(bulkId: string): Promise<FundingTransferRow[]>;
  /**
   * Records what moved on one item, only while it is still asked about (open or watched), and answers the row as it
   * now stands. Null when it is settled for good, or gone, and then nothing is written: such an item never changes.
   */
  update(requestId: string, update: FundingTransferUpdate): Promise<FundingTransferRow | null>;
}

interface Row {
  request_id: string;
  bulk_id: string;
  node_id: string;
  node_label: string;
  to_address: string;
  kind: FundingTransferKind;
  amount: string;
  nonce: number;
  raw_transaction: string;
  tx_hash: string;
  state: FundingItemState;
  error: string | null;
  block_number: number | null;
  watched: boolean;
  relayed_at: Date | null;
  requested_by_user_id: string | null;
  requested_by: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `request_id::text AS request_id, bulk_id::text AS bulk_id, node_id, node_label, to_address, kind,
  amount::text AS amount, nonce, raw_transaction, tx_hash, state, error, block_number,
  watched, relayed_at, requested_by_user_id::text AS requested_by_user_id, requested_by, created_at, updated_at`;

/** {@link OPEN_STATES} in SQL. */
const OPEN_SQL = `state IN ('queued', 'submitted')`;

/**
 * {@link holdsSend} in SQL, with the cutoff ({@link unknownCutoff}) as the parameter it names. It implies migration
 * 016's partial index predicate, `state IN ('queued', 'submitted', 'unknown')`, so the index serves it; a partial index
 * cannot hold the age itself, since its predicate cannot call `now()`.
 */
function holdsSendSql(cutoff: string): string {
  return `(${OPEN_SQL} OR (state = 'unknown' AND COALESCE(relayed_at, created_at) >= ${cutoff}))`;
}

/** {@link isAsked} in SQL. */
const ASKED_SQL = `(${OPEN_SQL} OR watched)`;

/** The key of the advisory lock every send takes, by its name, as the manager names its own. */
const SEND_LOCK_NAME = 'web2-admin:funding-send';

function rowOf(row: Row): FundingTransferRow {
  return {
    requestId: row.request_id,
    bulkId: row.bulk_id,
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    toAddress: row.to_address,
    kind: row.kind,
    amount: row.amount,
    nonce: Number(row.nonce),
    rawTransaction: row.raw_transaction,
    txHash: row.tx_hash,
    state: row.state,
    error: row.error,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    watched: row.watched,
    relayedAt: row.relayed_at,
    requestedByUserId: row.requested_by_user_id,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

/**
 * The funding journal, migration 016. The send lock is a session advisory lock, taken with `pg_try_advisory_lock` on a
 * connection of its own and released on it when the work is over: one send at a time across every process on the
 * database, and a process that dies while it holds the lock drops it with its connection.
 */
export class FundingTransferRepository implements FundingTransferStore {
  constructor(private readonly pool: Pool) {}

  async withSendLock<T>(work: () => Promise<T>): Promise<SendLockOutcome<T>> {
    const client = await this.pool.connect();
    let held = false;
    try {
      const taken = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
        SEND_LOCK_NAME,
      ]);
      held = taken.rows[0]?.locked === true;
      if (!held) return { locked: false };
      return { locked: true, result: await work() };
    } finally {
      if (held) {
        // A connection whose unlock failed is not handed back with the lock on it: destroying it drops the lock.
        const unlocked = await client
          .query('SELECT pg_advisory_unlock(hashtext($1))', [SEND_LOCK_NAME])
          .then(() => true)
          .catch(() => false);
        client.release(unlocked ? undefined : true);
      } else {
        client.release();
      }
    }
  }

  async hasUnsettled(now: Date): Promise<boolean> {
    const result = await this.pool.query<{ unsettled: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM funding_transfers WHERE ${holdsSendSql('$1')}) AS unsettled`,
      [unknownCutoff(now)],
    );
    return result.rows[0]?.unsettled === true;
  }

  openBulkIds(limit: number, now: Date): Promise<string[]> {
    return this.bulkIdsWhere(holdsSendSql('$2'), limit, [unknownCutoff(now)]);
  }

  askedBulkIds(limit: number): Promise<string[]> {
    return this.bulkIdsWhere(ASKED_SQL, limit);
  }

  private async bulkIdsWhere(predicate: string, limit: number, params: unknown[] = []): Promise<string[]> {
    const result = await this.pool.query<{ bulk_id: string }>(
      `SELECT bulk_id::text AS bulk_id FROM funding_transfers
        WHERE ${predicate}
        GROUP BY bulk_id
        ORDER BY MAX(created_at) DESC, bulk_id
        LIMIT $1`,
      [limit, ...params],
    );
    return result.rows.map((row) => row.bulk_id);
  }

  async insertAll(items: readonly NewFundingTransfer[]): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      for (const item of items) {
        await client.query(
          `INSERT INTO funding_transfers
             (request_id, bulk_id, node_id, node_label, to_address, kind, amount, nonce, raw_transaction, tx_hash,
              state, requested_by_user_id, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, 'queued', $11, $12)`,
          [
            item.requestId,
            item.bulkId,
            item.nodeId,
            item.nodeLabel,
            item.toAddress,
            item.kind,
            item.amount,
            item.nonce,
            item.rawTransaction,
            item.txHash,
            item.requestedByUserId,
            item.requestedBy,
          ],
        );
      }
    });
  }

  async listBulk(bulkId: string): Promise<FundingTransferRow[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM funding_transfers WHERE bulk_id = $1 ORDER BY nonce ASC`,
      [bulkId],
    );
    return result.rows.map(rowOf);
  }

  async update(requestId: string, update: FundingTransferUpdate): Promise<FundingTransferRow | null> {
    const result = await this.pool.query<Row>(
      `UPDATE funding_transfers
          SET state = $2,
              error = $3,
              block_number = CASE WHEN $4::boolean THEN $5::bigint ELSE block_number END,
              watched = $6,
              relayed_at = COALESCE($7, relayed_at),
              updated_at = NOW()
        WHERE request_id = $1 AND ${ASKED_SQL}
        RETURNING ${COLUMNS}`,
      [
        requestId,
        update.state,
        update.error,
        update.blockNumber !== undefined,
        update.blockNumber ?? null,
        update.watched,
        update.relayedAt ?? null,
      ],
    );
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }
}
