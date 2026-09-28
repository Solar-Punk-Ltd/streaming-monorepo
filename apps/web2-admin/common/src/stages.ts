/**
 * The stages the console lists, and the brand's catalogue stamp. The manager pushes both into the admin
 * (`docs/architecture/stages.md`); these are what the console reads back. Neither carries the SRT passphrase, the
 * uploader's token or its hash, nor the catalogue node's Bee API address.
 */

import type {
  StageChequebookHealth,
  StageEngine,
  StageKind,
  StageReadinessTone,
  StageStampState,
} from '@streaming-monorepo/contracts';

export {
  STAGE_CHEQUEBOOK_HEALTHS,
  STAGE_ENGINES,
  STAGE_KINDS,
  STAGE_READINESS_TONES,
  STAGE_STAMP_STATES,
  STAMP_EXPIRY_WARNING_SECONDS,
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

/** Null until the manager designates a catalogue batch, and again once it clears the designation. */
export interface CatalogueStampResponse {
  catalogueStamp: CatalogueStampSummary | null;
}
