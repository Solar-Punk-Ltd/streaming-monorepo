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
 * designation (`cleared`), or the batch the catalogue is written with is `expired` or `gone`.
 */
export const CATALOGUE_WRITE_PROBLEMS = ['none', 'cleared', 'expired', 'gone'] as const;
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
}

export interface CatalogueStampResponse {
  /** The designated batch: null until the manager designates one, and again once it clears the designation. */
  catalogueStamp: CatalogueStampSummary | null;
  catalogueWrite: CatalogueWriteStatus;
}
