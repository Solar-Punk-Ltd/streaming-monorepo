import type { Pool } from 'pg';

import type {
  FundingBatchPurchasePurpose,
  FundingPurchaseApplyState,
  FundingPurchaseStep,
  FundingTransferState,
} from '@streaming-monorepo/contracts';

/**
 * One batch purchase the web2 admin asked the manager for, for a rung, for the catalogue or as an archive stamp, as
 * `funding_stamp_purchases` holds it (migrations 055 and 056). A row is written before the node is asked and keyed by
 * the admin's request id, so the same request is answered from here and the node never buys twice, a manager that
 * stopped mid-way included. The follow-up writes each step here, so a manager that restarts goes on from the step the
 * row holds.
 */
export interface FundingStampPurchaseRow {
  requestId: string;
  /** What the batch is for, which decides where the follow-up puts it. */
  purpose: FundingBatchPurchasePurpose;
  /** The inventory's opaque id of the node that buys the batch. */
  nodeId: string;
  /** The batch's depth. */
  depth: number;
  /** The PLUR each of the batch's chunks is given, as a decimal string. */
  amountPerChunkPlur: string;
  /** What the batch costs, `amountPerChunkPlur × 2^depth` in PLUR, paid in xBZZ from the node's wallet. */
  costPlur: string;
  /** The kind the purchase asked for: true for a catalogue batch and an archive stamp, either for a rung's. */
  immutable: boolean;
  /** The name the batch carries in the manager and the admin, or null. */
  label: string | null;
  /**
   * The label the batch carries on its node, the purpose, a hyphen and the first twelve hex digits of the request id,
   * by which a lost answer is found again.
   */
  nodeLabel: string;
  /**
   * The batch that held the purchase's role when it was asked for, `0x` and 64 hex digits in lower case, or null for
   * none, and for an archive stamp.
   */
  replacesBatchId: string | null;
  /** The batch, `0x` and 64 hex digits in lower case, or null until the node answered or the row was settled. */
  batchId: string | null;
  /** The transaction the node answered with, or null while it answered none. */
  txHash: string | null;
  state: FundingTransferState;
  /** Where the purchase and its follow-up stand. */
  step: FundingPurchaseStep;
  /** Why it failed or is unknown, in a sentence, or null. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** When the purchase became confirmed, which the hour of waiting for a usable batch is counted from. */
  boughtAt: Date | null;
  /** When the batch was set on its rung or stage, or designated for the catalogue. */
  setAt: Date | null;
  /** For a catalogue purchase, the batch the catalogue was designated with before, `0x` and 64 hex digits, or null. */
  previousBatchId: string | null;
  /** When that batch was released, on the admin's word that its move was done. */
  releasedAt: Date | null;
  /**
   * For an archive stamp, when its batch was made an archive batch, or null until it was. Once it is set the batch is
   * never designated again, so one taken off the list stays off it. Null for the other purposes.
   */
  recordedAt: Date | null;
}

/** What the node's answer, or a reading of its batches, changes on a row while the purchase is being bought. */
export type FundingStampPurchasePatch = Pick<
  FundingStampPurchaseRow,
  'state' | 'batchId' | 'txHash' | 'error' | 'updatedAt' | 'step' | 'boughtAt'
>;

/** What the follow-up changes on a row once the batch is bought: the step and what came with it. */
export type FundingPurchaseStepPatch = Pick<
  FundingStampPurchaseRow,
  'step' | 'error' | 'updatedAt' | 'setAt' | 'previousBatchId' | 'releasedAt'
>;

/** One stage whose uploader follows the rung a purchase bought for, as `funding_purchase_stages` holds it. */
export interface FundingPurchaseStageRow {
  /** The deployment's `instance_id`. */
  stageId: string;
  /** The deployment's name when the batch was set. */
  name: string;
  /** Where the follow-up takes it, from 0. */
  position: number;
  apply: FundingPurchaseApplyState;
  /** A sentence about the state where there is one, or null. */
  message: string | null;
  /** When the admin asked for its restart while it waited for a broadcast, or null. */
  forcedAt: Date | null;
  updatedAt: Date;
}

/** What a look at a stage changes on its row. */
export type FundingPurchaseStagePatch = Pick<FundingPurchaseStageRow, 'apply' | 'message' | 'updatedAt'> & {
  /** Written when given; kept otherwise. */
  forcedAt?: Date;
};

/**
 * What an insert came to: the row written; nothing written because the request id is journalled already; nothing
 * written because another purchase on the same node is still being bought or waits for its batch to become usable, of
 * which the table holds one at a time; or nothing written because another purchase's node label is this one's too.
 */
export type FundingStampPurchaseInsert = 'inserted' | 'request_taken' | 'node_busy' | 'label_taken';

/** Where the manager journals batch purchases and their follow-up: the database, or an in-memory one in the tests. */
export interface FundingStampPurchaseJournal {
  find(requestId: string): Promise<FundingStampPurchaseRow | null>;
  /**
   * The purchase on this node that is still under way, being bought (`unknown` or `submitted`) or waiting for its
   * batch to become usable, or null.
   */
  openOn(nodeId: string): Promise<FundingStampPurchaseRow | null>;
  /** Writes the row, unless its request id is journalled already or another purchase is under way on its node. */
  insert(row: FundingStampPurchaseRow): Promise<FundingStampPurchaseInsert>;
  /**
   * Writes the patch only while the row is still in state `from`, and answers whether it did. The node's answer and a
   * reading of the node's batches can both settle an `unknown` row; whichever comes second finds it moved and leaves
   * it.
   */
  update(requestId: string, from: FundingTransferState, patch: FundingStampPurchasePatch): Promise<boolean>;
  /** Writes the step patch only while the row is still at step `from`, and answers whether it did. */
  advance(requestId: string, from: FundingPurchaseStep, patch: FundingPurchaseStepPatch): Promise<boolean>;
  /** Marks a confirmed archive stamp's batch as made an archive batch, once, and answers whether it did. */
  markRecorded(requestId: string, at: Date): Promise<boolean>;
  /**
   * The archive stamp purchases neither recorded nor failed: still open, or confirmed with a batch not made an archive
   * batch yet. Each holds a place on the catalogue stamp record's list of archive batches.
   */
  unrecorded(): Promise<FundingStampPurchaseRow[]>;
  /** The purchases the follow-up has something left to do for: being bought, waiting for a usable batch, or set. */
  following(): Promise<FundingStampPurchaseRow[]>;
  /** The stages of a rung purchase, in the order the follow-up takes them. */
  stagesOf(requestId: string): Promise<FundingPurchaseStageRow[]>;
  /** Writes the stages a rung purchase set its batch for, leaving any written already as they are. */
  addStages(requestId: string, stages: readonly FundingPurchaseStageRow[]): Promise<void>;
  /** Writes what a look at one stage came to. */
  updateStage(requestId: string, stageId: string, patch: FundingPurchaseStagePatch): Promise<void>;
}

interface Row {
  request_id: string;
  purpose: FundingBatchPurchasePurpose;
  node_id: string;
  depth: number;
  amount_per_chunk: string;
  cost: string;
  immutable: boolean;
  label: string | null;
  node_label: string;
  replaces_batch_id: string | null;
  batch_id: string | null;
  tx_hash: string | null;
  state: FundingTransferState;
  step: FundingPurchaseStep;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  bought_at: Date | null;
  set_at: Date | null;
  previous_batch_id: string | null;
  released_at: Date | null;
  recorded_at: Date | null;
}

const COLUMNS = [
  'request_id',
  'purpose',
  'node_id',
  'depth',
  'amount_per_chunk::text AS amount_per_chunk',
  'cost::text AS cost',
  'immutable',
  'label',
  'node_label',
  'replaces_batch_id',
  'batch_id',
  'tx_hash',
  'state',
  'step',
  'error',
  'created_at',
  'updated_at',
  'bought_at',
  'set_at',
  'previous_batch_id',
  'released_at',
  'recorded_at',
].join(', ');

interface StageRow {
  stage_id: string;
  stage_name: string;
  position: number;
  apply: FundingPurchaseApplyState;
  message: string | null;
  forced_at: Date | null;
  updated_at: Date;
}

/** Migration 056's partial unique index, which holds one purchase under way per node. */
const ONE_OPEN_PER_NODE = 'funding_stamp_purchases_one_open_per_node';

/** Migration 055's unique constraint on the label a purchase's batch carries on its node. */
const ONE_PURCHASE_PER_NODE_LABEL = 'funding_stamp_purchases_node_label_key';

/** PostgreSQL's code for a unique violation. */
const UNIQUE_VIOLATION = '23505';

function rowOf(row: Row): FundingStampPurchaseRow {
  return {
    requestId: row.request_id,
    purpose: row.purpose,
    nodeId: row.node_id,
    depth: Number(row.depth),
    amountPerChunkPlur: row.amount_per_chunk,
    costPlur: row.cost,
    immutable: row.immutable,
    label: row.label,
    nodeLabel: row.node_label,
    replacesBatchId: row.replaces_batch_id,
    batchId: row.batch_id,
    txHash: row.tx_hash,
    state: row.state,
    step: row.step,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    boughtAt: row.bought_at,
    setAt: row.set_at,
    previousBatchId: row.previous_batch_id,
    releasedAt: row.released_at,
    recordedAt: row.recorded_at,
  };
}

function stageRowOf(row: StageRow): FundingPurchaseStageRow {
  return {
    stageId: row.stage_id,
    name: row.stage_name,
    position: Number(row.position),
    apply: row.apply,
    message: row.message,
    forcedAt: row.forced_at,
    updatedAt: row.updated_at,
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
        WHERE node_id = $1 AND (state IN ('unknown', 'submitted') OR step = 'waiting_usable')
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
           (request_id, purpose, node_id, depth, amount_per_chunk, cost, immutable, label, node_label,
            replaces_batch_id, batch_id, tx_hash, state, step, error, created_at, updated_at, bought_at, set_at,
            previous_batch_id, released_at, recorded_at)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21, $22)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          row.requestId,
          row.purpose,
          row.nodeId,
          row.depth,
          row.amountPerChunkPlur,
          row.costPlur,
          row.immutable,
          row.label,
          row.nodeLabel,
          row.replacesBatchId,
          row.batchId,
          row.txHash,
          row.state,
          row.step,
          row.error,
          row.createdAt,
          row.updatedAt,
          row.boughtAt,
          row.setAt,
          row.previousBatchId,
          row.releasedAt,
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
      `UPDATE funding_stamp_purchases
          SET state = $3, batch_id = $4, tx_hash = $5, error = $6, updated_at = $7, step = $8, bought_at = $9
        WHERE request_id = $1 AND state = $2`,
      [
        requestId,
        from,
        patch.state,
        patch.batchId,
        patch.txHash,
        patch.error,
        patch.updatedAt,
        patch.step,
        patch.boughtAt,
      ],
    );
    return result.rowCount === 1;
  }

  async advance(requestId: string, from: FundingPurchaseStep, patch: FundingPurchaseStepPatch): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE funding_stamp_purchases
          SET step = $3, error = $4, updated_at = $5, set_at = $6, previous_batch_id = $7, released_at = $8
        WHERE request_id = $1 AND step = $2`,
      [requestId, from, patch.step, patch.error, patch.updatedAt, patch.setAt, patch.previousBatchId, patch.releasedAt],
    );
    return result.rowCount === 1;
  }

  async markRecorded(requestId: string, at: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE funding_stamp_purchases SET recorded_at = $2
        WHERE request_id = $1 AND purpose = 'archive' AND state = 'confirmed' AND recorded_at IS NULL`,
      [requestId, at],
    );
    return result.rowCount === 1;
  }

  async unrecorded(): Promise<FundingStampPurchaseRow[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM funding_stamp_purchases
        WHERE purpose = 'archive' AND state <> 'failed' AND recorded_at IS NULL
        ORDER BY created_at, request_id`,
    );
    return result.rows.map(rowOf);
  }

  async following(): Promise<FundingStampPurchaseRow[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM funding_stamp_purchases
        WHERE step IN ('buying', 'waiting_usable', 'set')
        ORDER BY created_at, request_id`,
    );
    return result.rows.map(rowOf);
  }

  async stagesOf(requestId: string): Promise<FundingPurchaseStageRow[]> {
    const result = await this.pool.query<StageRow>(
      `SELECT stage_id, stage_name, position, apply, message, forced_at, updated_at
         FROM funding_purchase_stages
        WHERE request_id = $1
        ORDER BY position`,
      [requestId],
    );
    return result.rows.map(stageRowOf);
  }

  async addStages(requestId: string, stages: readonly FundingPurchaseStageRow[]): Promise<void> {
    for (const stage of stages) {
      await this.pool.query(
        `INSERT INTO funding_purchase_stages
           (request_id, stage_id, stage_name, position, apply, message, forced_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          requestId,
          stage.stageId,
          stage.name,
          stage.position,
          stage.apply,
          stage.message,
          stage.forcedAt,
          stage.updatedAt,
        ],
      );
    }
  }

  async updateStage(requestId: string, stageId: string, patch: FundingPurchaseStagePatch): Promise<void> {
    await this.pool.query(
      `UPDATE funding_purchase_stages
          SET apply = $3, message = $4, updated_at = $5, forced_at = COALESCE($6, forced_at)
        WHERE request_id = $1 AND stage_id = $2`,
      [requestId, stageId, patch.apply, patch.message, patch.updatedAt, patch.forcedAt ?? null],
    );
  }
}
