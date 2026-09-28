/**
 * The stages the console lists, and the brand's catalogue stamp. The manager pushes both into the admin
 * (`docs/architecture/stages.md`); these are what the console reads back. Neither carries the SRT passphrase, the
 * uploader's token or its hash, nor the catalogue node's Bee API address.
 */

import type {
  AdminTokenKind,
  StageChequebookHealth,
  StageEngine,
  StageKind,
  StageReadinessTone,
  StageStampState,
} from '@streaming-monorepo/contracts';

export {
  ADMIN_TOKEN_KINDS,
  STAGE_CHEQUEBOOK_HEALTHS,
  STAGE_ENGINES,
  STAGE_KINDS,
  STAGE_READINESS_TONES,
  STAGE_STAMP_STATES,
  STAMP_EXPIRY_WARNING_SECONDS,
  sameFeedOwner,
  type AdminTokenKind,
  type StageChequebookHealth,
  type StageEngine,
  type StageKind,
  type StageReadinessTone,
  type StageStampState,
} from '@streaming-monorepo/contracts';

/** A batch as the manager last read it from its node. */
export interface StageStampReading {
  batchId: string;
  state: StageStampState;
  /** Seconds left, when the node said. Negative when the node could not work it out. */
  ttlSeconds: number | null;
  /** How full the fullest bucket is, 0 to 1, when the node said enough to tell. */
  fillRatio: number | null;
  immutable: boolean | null;
}

export interface StageRungSummary {
  name: string;
  stamp: StageStampReading | null;
  chequebook: { health: StageChequebookHealth; availableBzz: string | null } | null;
}

/** One stage on `GET /api/stages`. */
export interface StageSummary {
  stageId: string;
  name: string;
  kind: StageKind;
  engine: StageEngine;
  /** Whether the admin takes streams on this stage's engine: SRS only, in this round. */
  supported: boolean;
  stackVersion: string | null;
  /** The deployment's status in the manager's words. */
  status: string;
  /** The address the stage's feeds are signed as. */
  owner: string;
  ingest: {
    host: string;
    srtPort: number;
    rtmpPort: number;
    rtmpPublic: boolean;
    /** Whether encoders need an SRT passphrase. The passphrase itself is never listed. */
    hasSrtPassphrase: boolean;
  };
  rungs: StageRungSummary[];
  /** The uploader's health, or null when the manager could not read it. */
  uploader: { state: string; reasons: string[] } | null;
  /** The manager's verdict on the stage, shown as it is. */
  readiness: { tone: StageReadinessTone; reasons: string[] };
  /**
   * Which token the stage's uploader presents to the admin: a token of its `own`, which the admin answers only about
   * the stage's streams, or the `shared` `INTERNAL_API_TOKEN`, still taken while the stages move over. Null when the
   * manager pushed no token. Never the token or its hash.
   */
  adminTokenKind: AdminTokenKind | null;
  /** When the manager read what this says. */
  observedAt: string;
  /** When the admin last stored a record for the stage. */
  receivedAt: string;
  /** When the manager saw the stage's deployment gone, by its clock, or null. A retired stage takes no new streams. */
  retiredAt: string | null;
}

export interface StageListResponse {
  stages: StageSummary[];
}

/** The brand's catalogue batch on its dedicated node, as `GET /api/catalogue-stamp` answers it. */
export interface CatalogueStampSummary {
  nodeName: string;
  batchId: string;
  immutable: boolean;
  depth: number;
  state: StageStampState;
  ttlSeconds: number | null;
  fillRatio: number | null;
  designatedAt: string;
  observedAt: string;
  receivedAt: string;
}

/**
 * How full the catalogue batch may get before My Streams warns. An immutable batch refuses a write into a full
 * bucket, and the catalogue's next write would be that one.
 */
export const CATALOGUE_FILL_WARNING_RATIO = 0.9;

/**
 * Why the admin refuses to write the catalogue: the manager has designated no batch (`none`) or cleared the
 * designation (`cleared`), or the batch the catalogue is written with is `expired` (by its state, or by the time to
 * live it had when the manager last read it), `gone`, or `mutable`, which would overwrite the catalogue's oldest
 * slots once it fills.
 */
export const CATALOGUE_WRITE_PROBLEMS = ['none', 'cleared', 'expired', 'gone', 'mutable'] as const;
export type CatalogueWriteProblem = (typeof CATALOGUE_WRITE_PROBLEMS)[number];

/** The batch the catalogue is written with, as the manager last read it. */
export interface CatalogueBatchReading {
  batchId: string;
  nodeName: string;
  state: StageStampState;
  ttlSeconds: number | null;
  fillRatio: number | null;
  /** When the manager read it. For a batch the manager no longer designates, that reading only ages. */
  observedAt: string;
}

/**
 * What the next catalogue write does. The admin writes with the batch it pinned on its first write, which is the
 * designated one unless the manager has designated another since the feed got history: then it keeps the pinned one
 * until the catalogue is moved, and `moveWaitingTo` names the designated batch.
 */
export interface CatalogueWriteStatus {
  /** The batch the catalogue is written with, or null when there is none to write with. */
  batch: CatalogueBatchReading | null;
  /** Why the admin refuses to publish, unpublish or reconcile, in the sentence it refuses with; null when it writes. */
  refusal: { problem: CatalogueWriteProblem; message: string } | null;
  /** The designated batch the catalogue waits to be moved to, or null when it is written with the designated one. */
  moveWaitingTo: string | null;
  /**
   * The writes of this feed stamped by a batch the admin never recorded: the env file's, before the catalogue stamp.
   * They need moving to the catalogue batch before that batch expires, since the viewer stops at the first slot it
   * cannot read. Null when there are none.
   */
  unrecordedHistory: { writes: number } | null;
}

/**
 * Why a move of the catalogue to the designated batch cannot start now:
 *
 * - `disabled`: `CATALOGUE_MOVE_ENABLED` is off on this installation, which it is until the move has been tried on a
 *   real node.
 * - `none`, `cleared`: the manager designates no batch to move to.
 * - `nothing`: every slot is already under the designated batch, by the admin's record.
 * - `target`: the designated batch is expired, gone or mutable.
 * - `lapsed`: the batch the catalogue is written with is expired or gone, and some slots have no recorded bytes, so
 *   there is nothing left to read them from.
 * - `changed`: only a start is refused with it: the batch it names is not the one the manager designates now.
 */
export const CATALOGUE_MOVE_PROBLEMS = [
  'disabled',
  'none',
  'cleared',
  'nothing',
  'target',
  'lapsed',
  'changed',
] as const;
export type CatalogueMoveProblem = (typeof CATALOGUE_MOVE_PROBLEMS)[number];

export const CATALOGUE_MOVE_STATES = ['running', 'done', 'failed'] as const;
export type CatalogueMoveState = (typeof CATALOGUE_MOVE_STATES)[number];

/** One move of the catalogue's history to another batch, as the console shows it. */
export interface CatalogueMoveSummary {
  id: string;
  state: CatalogueMoveState;
  targetBatchId: string;
  /** The batch the catalogue was written with when the move started, or null when none was pinned yet. */
  fromBatchId: string | null;
  /** Slots stamped under the target batch so far: every slot below this index. */
  slotsDone: number;
  /** The feed's slots as the job last counted them, 0 to its head. */
  slotsTotal: number | null;
  /** Slots uploaded again, and slots already under the target batch. */
  restamped: number;
  skipped: number;
  /** Thumbnails uploaded again: every one a stream or the latest entry names, once the move is done. */
  thumbnails: number;
  /** Why a failed move stopped. */
  error: string | null;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * The catalogue move as the Stages page reads it: whether one is waiting and can start, why it cannot, and the latest
 * move, running or finished.
 */
export interface CatalogueMoveStatus {
  /** Whether `CATALOGUE_MOVE_ENABLED` is on. */
  enabled: boolean;
  /**
   * The move the history waits for, or null when none does: the designated batch differs from the one the catalogue
   * is written with, or some writes were stamped by a batch the admin never recorded.
   */
  waiting: { targetBatchId: string; fromBatchId: string | null; slots: number } | null;
  /** Why the waiting move cannot start now, in the sentence the start is refused with; null when it can. */
  refusal: { problem: CatalogueMoveProblem; message: string } | null;
  /** The latest move of this feed, or null before the first. */
  latest: CatalogueMoveSummary | null;
  /** The batch the manager designates now, or null when none is designated. */
  designatedBatchId: string | null;
  /** The batch the catalogue is written with, or null before the first write pins one. */
  pinnedBatchId: string | null;
}

/** What `POST /api/catalogue-stamp/move` takes: the batch the operator saw named, which must be the designated one. */
export interface CatalogueMoveRequest {
  targetBatchId: string;
}

export interface CatalogueStampResponse {
  /** The designated batch: null until the manager designates one, and again once it clears the designation. */
  catalogueStamp: CatalogueStampSummary | null;
  catalogueWrite: CatalogueWriteStatus;
  catalogueMove: CatalogueMoveStatus;
}
