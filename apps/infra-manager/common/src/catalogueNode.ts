import { ABR_NODE_POOL_GROUP_KIND } from './abrLadder.js';
import { shortHex } from './displayFormat.js';
import { isBeeNodeOnly, type StampGatedProfile } from './stampGating.js';
import type { StampState } from './stampHealth.js';

/**
 * The brand's catalogue node: a Bee-only deployment this manager runs, designated on the Manager settings page, with
 * one immutable batch of its own pinned by id. The web2 admin writes the brand's catalogue through that node and that
 * batch, and the manager pushes the catalogue stamp record there (`catalogueStampRecordSchema` in
 * `packages/contracts`). `docs/features/stages.md` in the manager is the page, and `docs/architecture/stages.md` at
 * the repository root says why the catalogue gets a batch of its own.
 */

/** The designation, as `GET /manager-settings/catalogue-node` answers it. */
export interface CatalogueDesignation {
  /** The deployment whose Bee node holds the batch. */
  profileName: string;
  /** The pinned batch, 64 hex digits without `0x`, in lower case. */
  batchId: string;
  /** When it was designated, ISO 8601. */
  designatedAt: string;
  /** Who designated it. */
  designatedBy: string | null;
}

/** What the manager last read about the pinned batch on its node. */
export interface CatalogueReading {
  /** The batch read, which is the pinned one unless the designation changed since. */
  batchId: string;
  state: StampState;
  ttlSeconds: number | null;
  fillRatio: number | null;
  immutable: boolean | null;
  depth: number | null;
  /** When it was read, ISO 8601. */
  readAt: string;
}

/**
 * The calls the manager makes for the catalogue: a `PUT` of the record or a `DELETE` of it. Every one comes to one
 * code, which is what the log and the card say, never what the admin answered, its address or a token.
 */
export const CATALOGUE_PUSH_OUTCOMES = [
  /** The admin stored the record. */
  'stored',
  /** The admin holds a record read later than this one, and kept it. */
  'older-ignored',
  /** The admin cleared the catalogue stamp it held. */
  'cleared',
  /** The admin held nothing to clear, or held a record read after the clear. */
  'not-cleared',
  /** The admin refused the link's token. */
  'refused-token',
  /** The admin refused the record itself. */
  'refused-record',
  /** Nothing answered in time, or the answer stopped arriving. */
  'unreachable',
  /** The address answered with a redirect, which the manager does not follow. */
  'redirected',
  /** Something answered that is not a web2 admin taking catalogue stamp records. */
  'not-admin',
  /** The manager has no web2 admin link, or its link stores no token. */
  'skipped-no-link',
  /** The designated deployment is not there any more. */
  'skipped-no-node',
  /** The record could not be put together, for the reason the log gives. */
  'skipped-no-record',
] as const;
export type CataloguePushOutcome = (typeof CATALOGUE_PUSH_OUTCOMES)[number];

/** What each outcome is called on the card. */
export const CATALOGUE_PUSH_OUTCOME_TEXT: Readonly<Record<CataloguePushOutcome, string>> = {
  stored: 'stored',
  'older-ignored': 'the admin kept a newer reading',
  cleared: 'cleared',
  'not-cleared': 'nothing to clear',
  'refused-token': 'token refused',
  'refused-record': 'record refused',
  unreachable: 'admin unreachable',
  redirected: 'redirected, not followed',
  'not-admin': 'not a web2 admin',
  'skipped-no-link': 'not sent (the manager has no admin link with a token)',
  'skipped-no-node': 'not sent (the designated deployment is gone)',
  'skipped-no-record': 'not sent (the record is incomplete)',
};

/** The last call of either kind, as the manager keeps it in memory. */
export interface CataloguePushState {
  kind: 'store' | 'clear';
  outcome: CataloguePushOutcome;
  /** When the call ended, ISO 8601. */
  at: string;
}

/**
 * The batch the catalogue is moving from, while a move is pending: the one pinned before the move, which holds the
 * catalogue's history until the web2 admin has stamped every slot again under the pinned batch, and which a release
 * takes out.
 */
export interface CatalogueMove {
  /** The deployment whose Bee node holds that batch. */
  profileName: string;
  /** The batch, 64 hex digits without `0x`, in lower case. */
  batchId: string;
  /** When the move was made, ISO 8601. */
  startedAt: string;
  /** Who made it. */
  startedBy: string | null;
  /** The manager's last reading of that batch, or null before any. It is read, never pushed to the admin. */
  reading: CatalogueReading | null;
}

/** What `GET /manager-settings/catalogue-node` answers, and what a save, a clear or a release answers. */
export interface CatalogueNodeAnswer {
  /** Null when no catalogue node is designated, never or since a clear. */
  designation: CatalogueDesignation | null;
  /**
   * The deployment and the batch the catalogue is pinned to, which stay recorded after a clear, or null before the
   * first designation. This batch can be designated again at any time, another one only as a move, and while a move
   * is pending none but the one moved from. This deployment is not removed.
   */
  pinned: { profileName: string; batchId: string } | null;
  /** The batch the catalogue is moving from, or null while no move is pending. Its deployment is not removed either. */
  movingFrom: CatalogueMove | null;
  /** The last release of a batch moved from, kept after it, or null before any. */
  lastRelease: { at: string; by: string | null } | null;
  /** The revision a save, a clear or a release names. One is refused once another has moved past it. */
  revision: number;
  /** The manager's last reading of the pinned batch, or null before any. */
  reading: CatalogueReading | null;
  /** The last push or clear, or null before any since the manager started. */
  lastPush: CataloguePushState | null;
}

/** What `PUT /manager-settings/catalogue-node` takes. */
export interface CatalogueNodeSave {
  expectedRevision: number;
  profileName: string;
  batchId: string;
  /**
   * True to move the catalogue to this batch while another one is pinned: without it a batch other than the pinned
   * one is refused. For the pinned batch itself, or before any designation, it changes nothing.
   */
  move?: boolean;
}

/** What `DELETE /manager-settings/catalogue-node` takes. */
export interface CatalogueNodeClear {
  expectedRevision: number;
}

/** What `POST /manager-settings/catalogue-node/release` takes. */
export interface CatalogueNodeRelease {
  expectedRevision: number;
}

/** The fields of a deployment that decide whether it can be the catalogue node. */
export interface CatalogueNodeCandidate extends StampGatedProfile {
  name: string;
  status: string;
}

/** Why a batch cannot be the catalogue's, when the node answers that it holds it. */
export const CATALOGUE_MUTABLE_REFUSAL =
  'This batch is mutable. Once one of its buckets fills, a mutable batch overwrites its oldest chunks, and the catalogue’s oldest slots are the ones a viewer walks first, so one overwritten slot hides every entry after it. Designate an immutable batch.';
export const CATALOGUE_KIND_UNKNOWN_REFUSAL =
  'The node did not report whether this batch is immutable, and a mutable one would overwrite the catalogue’s oldest slots once it fills. Designate a batch whose kind the node reports as immutable.';
export const CATALOGUE_EXPIRED_REFUSAL =
  'This batch has expired, and nothing written with it stays on the network. Designate a batch with life left.';
export const CATALOGUE_NOT_HELD_REFUSAL =
  'The node does not hold this batch. Designate one of the batches its Storage and funding card lists.';
export const CATALOGUE_UNREACHABLE_REFUSAL =
  'The node did not answer, so whether this batch is immutable could not be checked. Try again once the node answers.';
/**
 * The shallowest batch a designation takes. An immutable batch refuses a chunk whose bucket is full, and a catalogue
 * slot is written again at the same address, so the first slot refused freezes the catalogue for every stage until
 * the batch is diluted. At depth 17 that comes after about 2,600 chunks, at depth 18 after about 18,000.
 */
export const MIN_CATALOGUE_DEPTH = 18;

/**
 * Why a new batch shallower than {@link MIN_CATALOGUE_DEPTH} cannot be the catalogue's. The batch already pinned is
 * not held to it, nor a move back to the batch moved from, so a designation made before the minimum keeps working.
 */
export function catalogueShallowBatchRefusal(depth: number): string {
  return `This batch has depth ${depth}. Its buckets are small enough that the catalogue would stop taking new slots after a few thousand writes, for every stage. Designate a batch of depth ${MIN_CATALOGUE_DEPTH} or more.`;
}

/**
 * Why a batch cannot both hold the catalogue and stamp an ABR uploader's segments, which a designation and a pool
 * string are both refused with: segments fill the batch the catalogue's slots live in.
 */
export const CATALOGUE_SEGMENT_BATCH_REFUSAL =
  'The brand’s catalogue and an ABR uploader’s segments cannot share a batch or a node, since segments fill the batch the catalogue’s slots live in. Give each a batch and a node of its own.';

/**
 * Why a designation of another batch than the pinned one is refused when it is not confirmed as a move. The
 * catalogue's slots are stamped by the pinned batch, and moving them to another is an action of its own, which the
 * web2 admin carries out.
 */
export function catalogueMoveRefusal(pinnedBatchId: string, batchId: string): string {
  return `Batch ${shortHex(batchId)} would move the catalogue off batch ${shortHex(pinnedBatchId)}, whose slots the web2 admin then stamps again under the new batch, so it is saved only when confirmed as a move.`;
}

/**
 * Why a third batch is refused while a move is pending: the batch moved from still holds the catalogue's history
 * until the admin reports the move done, and a release takes it out first.
 */
export function catalogueReleaseFirstRefusal(movingFromBatchId: string): string {
  return `The catalogue is still moving off batch ${shortHex(movingFromBatchId)}, so release the previous batch first, once the web2 admin reports the move done, before moving it to another.`;
}

/** Why a release is refused when no move is pending. */
export const CATALOGUE_NO_MOVE_REFUSAL =
  'No move of the catalogue is pending, so there is no previous batch to release.';

/**
 * Why this deployment cannot be the catalogue node, one sentence, or null. It has to be nothing but a Bee node, and
 * not a rung of an ABR node pool, whose batches pay for segments.
 */
export function catalogueNodeProblem(profile: CatalogueNodeCandidate, groupKind: string | null): string | null {
  if (!isBeeNodeOnly(profile)) {
    return `${profile.name} runs more than a Bee node. The catalogue node is a deployment that is nothing but a Bee node, so no stage's uploads share it.`;
  }
  if (groupKind === ABR_NODE_POOL_GROUP_KIND) {
    return `${profile.name} is a rung of an ABR node pool, whose batches pay for a stream's segments. The catalogue node is a Bee-only deployment of its own.`;
  }
  if (profile.status === 'REMOVING') return `${profile.name} is being removed.`;
  return null;
}

/** The fields of bee's `/stamps` entry that decide whether a batch can be the catalogue's. */
export interface CatalogueBatchLike {
  batchTTL: number;
  usable?: boolean;
  exists?: boolean;
  immutableFlag?: boolean | null;
}

/**
 * Why a batch the node holds cannot be the catalogue's, one sentence, or null. Only an immutable batch, and one the
 * node says is immutable: a node that does not say is refused, since the kind that fails is the one it might be.
 */
export function catalogueBatchProblem(stamp: CatalogueBatchLike): string | null {
  if (stamp.exists === false) return CATALOGUE_NOT_HELD_REFUSAL;
  if (typeof stamp.immutableFlag !== 'boolean') return CATALOGUE_KIND_UNKNOWN_REFUSAL;
  if (!stamp.immutableFlag) return CATALOGUE_MUTABLE_REFUSAL;
  if (stamp.batchTTL === 0) return CATALOGUE_EXPIRED_REFUSAL;
  return null;
}

/** The card's line: what the last call came to and how long ago, in whole seconds. */
export function cataloguePushLine(state: CataloguePushState | null, now: number): string {
  if (!state) return 'Web2 admin: not sent yet';
  const seconds = Math.max(0, Math.round((now - Date.parse(state.at)) / 1000));
  return `Web2 admin: ${CATALOGUE_PUSH_OUTCOME_TEXT[state.outcome]} ${seconds} s ago`;
}
