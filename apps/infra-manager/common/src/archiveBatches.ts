import type { CatalogueBatchLike, CataloguePushState, CatalogueReading } from './catalogueNode.js';
import { shortHex } from './displayFormat.js';
import type { StampState } from './stampHealth.js';

/**
 * The brand's archive batches: immutable batches on the catalogue node that the web2 admin copies finished recordings
 * onto, so a recording outlives the mutable batches of the stage that made it. The admin buys one through the funding
 * API (`fundingStampPurchaseRequestSchema` in `packages/contracts`), and the manager records it here on purchase. A
 * batch bought another way is adopted on the Manager settings page. The manager pushes every archive batch to the
 * admin inside the catalogue stamp record (`archiveBatches` in `catalogueStampRecordSchema`). `docs/features/stages.md`
 * in the manager is the page, and `docs/architecture/web2-admin.md` at the repository root, "Archiving a recording",
 * says what the admin does with them.
 *
 * The routes, all behind the operator's session:
 *
 * - `GET /manager-settings/archive-batches` answers {@link ArchiveBatchesAnswer}.
 * - `PUT /manager-settings/archive-batches/:batchId` takes {@link ArchiveBatchAdopt}, adopts a batch the catalogue
 *   node holds, and answers {@link ArchiveBatchesAnswer}. It answers 422 with the sentence of
 *   {@link archiveBatchProblem} when the batch cannot be one, and 409 when `expectedRevision` is behind.
 * - `DELETE /manager-settings/archive-batches/:batchId` takes {@link ArchiveBatchRemove}, takes off the list an
 *   expired batch, one its node no longer holds, or one whose deployment is gone, and answers
 *   {@link ArchiveBatchesAnswer}, with the same 409. It answers 422 with the sentence of {@link archiveRemoveProblem}
 *   for a batch that has not expired, or whose node did not say: the admin would show its recordings as expired while
 *   they are paid for and on Swarm. It answers 404 for a batch that is no archive batch. A batch whose deployment is
 *   gone keeps its recordings on Swarm until it expires. An adopt brings a removed batch back.
 *
 * `:batchId` is 64 hex digits without `0x`. Every change raises the revision and pushes the catalogue stamp record.
 *
 * While no catalogue node is designated the record is cleared as it is today, the archive batches with it. The rows
 * stay, and are pushed again with the next designation. Designating the catalogue's own batch refuses a batch that is
 * an archive batch, with {@link catalogueIsArchiveBatchRefusal}.
 *
 * The funding API reaches the archive batches through `manager/src/domain/stages/archiveBatchPorts.ts`.
 */

/** How an archive batch came to be one: bought through the funding API, or adopted on the settings page. */
export const ARCHIVE_BATCH_SOURCES = ['purchase', 'adopted'] as const;
export type ArchiveBatchSource = (typeof ARCHIVE_BATCH_SOURCES)[number];

/** The longest label an archive batch carries, the same as `ARCHIVE_BATCH_LABEL_MAX_LENGTH` in `packages/contracts`. */
export const ARCHIVE_LABEL_MAX_LENGTH = 64;

/**
 * How long a purchase whose answer the manager lost may stay `unknown` before it is `failed`: thirty minutes from the
 * request, the time the funding API's other operations get.
 */
export const ARCHIVE_PURCHASE_SETTLE_MS = 30 * 60 * 1000;

/** One archive batch as the manager keeps it. */
export interface ArchiveBatchDesignation {
  /** The batch, 64 hex digits without `0x`, in lower case. */
  batchId: string;
  /** The deployment whose Bee node holds the batch, and so the only node that can stamp with it. */
  profileName: string;
  /**
   * The batch's depth as its node last reported it: the depth a purchase bought or an adopt read, then each
   * reading's. The catalogue stamp record carries it while the node does not answer.
   */
  depth: number;
  /** The name its buyer or adopter gave it, or null. */
  label: string | null;
  source: ArchiveBatchSource;
  /** The funding API request that bought it, or null for an adopted one. */
  purchaseRequestId: string | null;
  /** When it became an archive batch, ISO 8601. */
  designatedAt: string;
  /** Who adopted it, or null for one the admin bought. */
  designatedBy: string | null;
}

/** One row of the settings card: the designation with what the manager last read about the batch. */
export interface ArchiveBatchRow extends ArchiveBatchDesignation {
  /** The manager's last reading of the batch on its node, or null before any. */
  reading: CatalogueReading | null;
  /**
   * True only for a batch whose deployment is the designated catalogue node, that the node calls usable and that has
   * not expired, so the admin can stamp with it. False for a batch left on a deployment that is the catalogue node no
   * longer: it stays listed and can be topped up, and nothing is copied onto it. A batch whose deployment was deleted
   * stays listed too, with its state `unknown` and this false.
   */
  writable: boolean;
}

/** A batch the catalogue node holds that is no archive batch yet, with why it cannot be adopted, or null when it can. */
export interface ArchiveBatchCandidate {
  /** The batch, 64 hex digits without `0x`, in lower case. */
  batchId: string;
  /** The label the node keeps for it, or null. */
  nodeLabel: string | null;
  depth: number | null;
  immutable: boolean | null;
  ttlSeconds: number | null;
  problem: string | null;
}

/** What `GET /manager-settings/archive-batches` answers, and what an adopt or a removal answers. */
export interface ArchiveBatchesAnswer {
  /** The designated catalogue node's deployment, or null when none is designated, in which case nothing is adopted. */
  catalogueProfileName: string | null;
  /** Every archive batch, in the order they were designated. */
  batches: ArchiveBatchRow[];
  /** The other batches the catalogue node holds. Empty when the node did not answer, with `candidatesError` saying so. */
  candidates: ArchiveBatchCandidate[];
  /** Why the candidates could not be read, one sentence, or null. */
  candidatesError: string | null;
  /** The revision an adopt or a removal names. One is refused once another has moved past it. */
  revision: number;
  /** The last push of the catalogue stamp record, which carries the archive batches, or null before any. */
  lastPush: CataloguePushState | null;
}

/** What `PUT /manager-settings/archive-batches/:batchId` takes. */
export interface ArchiveBatchAdopt {
  expectedRevision: number;
  /** The name to give it, 1 to {@link ARCHIVE_LABEL_MAX_LENGTH} characters once trimmed, or null for none. */
  label: string | null;
}

/** What `DELETE /manager-settings/archive-batches/:batchId` takes. */
export interface ArchiveBatchRemove {
  expectedRevision: number;
}

export const ARCHIVE_NO_CATALOGUE_NODE_REFUSAL =
  'No catalogue node is designated, and an archive batch is a batch on the catalogue node. Designate the catalogue node first.';

export const ARCHIVE_MUTABLE_REFUSAL =
  'This batch is mutable. Once one of its buckets fills, a mutable batch overwrites its oldest chunks, which would take a recording apart. An archive batch is immutable.';

export const ARCHIVE_KIND_UNKNOWN_REFUSAL =
  'The node did not report whether this batch is immutable, and a mutable one would overwrite the chunks of a recording once it fills. Adopt a batch whose kind the node reports as immutable.';

export const ARCHIVE_EXPIRED_REFUSAL =
  'This batch has expired, and nothing written with it stays on the network. Adopt a batch with life left.';

export const ARCHIVE_NOT_HELD_REFUSAL =
  'The catalogue node does not hold this batch. Adopt one of the batches its Storage and funding card lists.';

export const ARCHIVE_UNREACHABLE_REFUSAL =
  'The catalogue node did not answer, so whether this batch is immutable could not be checked. Try again once the node answers.';

export const ARCHIVE_ALREADY_REFUSAL = 'This batch is already an archive batch.';

export const ARCHIVE_REMOVE_LIVE_REFUSAL =
  'This batch has not expired. Its recordings are paid for and on Swarm, and the web2 admin would show them as expired once the batch is off the list. A batch is removed once it has expired.';

export const ARCHIVE_REMOVE_UNREAD_REFUSAL =
  'The node did not say whether this batch has expired, so it stays on the list. Try again once the node answers.';

/**
 * Why an archive batch cannot be taken off the list, one sentence, or null. Only one the node reports as expired, or
 * as gone from it, is removed, and one whose deployment is gone, which has no node left to say: its recordings stay on
 * Swarm until the batch expires. `state` is the manager's last reading of the batch, or null before any.
 */
export function archiveRemoveProblem(
  state: StampState | null,
  { deploymentGone = false }: { deploymentGone?: boolean } = {},
): string | null {
  if (deploymentGone) return null;
  if (state === 'expired' || state === 'gone') return null;
  if (state === null || state === 'unknown') return ARCHIVE_REMOVE_UNREAD_REFUSAL;
  return ARCHIVE_REMOVE_LIVE_REFUSAL;
}

/** Why an archive batch cannot be designated as the catalogue's own batch. */
export function catalogueIsArchiveBatchRefusal(batchId: string): string {
  return `Batch ${shortHex(batchId)} is an archive batch, which recordings fill. A full immutable batch takes no new catalogue slot, so the catalogue keeps a batch of its own.`;
}

export const ARCHIVE_UNKNOWN_REFUSAL = 'There is no archive batch with this id.';

export const ARCHIVE_NO_DEPTH_REFUSAL = 'The node reported no depth for this batch that a batch can have.';

/** Why the catalogue's own batch, the pinned one or the one a move left, is no archive batch. */
export function archiveIsCatalogueBatchRefusal(batchId: string): string {
  return `Batch ${shortHex(batchId)} holds the catalogue. Recordings fill a batch, and a full immutable batch takes no new catalogue slot, so the catalogue keeps a batch of its own.`;
}

/** Why a label is refused, one sentence, or null. Null and a label of 1 to the maximum characters once trimmed pass. */
export function archiveLabelProblem(label: string | null): string | null {
  if (label === null) return null;
  const trimmed = label.trim();
  if (trimmed === '') return 'A label has at least one character, or leave it out.';
  if (trimmed.length > ARCHIVE_LABEL_MAX_LENGTH) return `A label has at most ${ARCHIVE_LABEL_MAX_LENGTH} characters.`;
  return null;
}

/** What decides whether a batch the catalogue node holds can be adopted, beside the node's own words about it. */
export interface ArchiveBatchContext {
  /** The batch asked about, 64 hex digits without `0x`, in lower case. */
  batchId: string;
  /** The catalogue's pinned batch and the one a pending move left, each in the same form, without the absent ones. */
  catalogueBatchIds: readonly string[];
  /** The batches that are archive batches already, in the same form. */
  archiveBatchIds: readonly string[];
}

/**
 * Why a batch the catalogue node holds cannot be an archive batch, one sentence, or null. It has to be immutable, and
 * said so by the node, with life left, and neither the catalogue's own batch nor an archive batch already. Its depth
 * is its buyer's choice: an archive batch has no minimum.
 */
export function archiveBatchProblem(stamp: CatalogueBatchLike, context: ArchiveBatchContext): string | null {
  if (context.archiveBatchIds.includes(context.batchId)) return ARCHIVE_ALREADY_REFUSAL;
  if (context.catalogueBatchIds.includes(context.batchId)) return archiveIsCatalogueBatchRefusal(context.batchId);
  if (stamp.exists === false) return ARCHIVE_NOT_HELD_REFUSAL;
  if (typeof stamp.immutableFlag !== 'boolean') return ARCHIVE_KIND_UNKNOWN_REFUSAL;
  if (!stamp.immutableFlag) return ARCHIVE_MUTABLE_REFUSAL;
  if (stamp.batchTTL === 0) return ARCHIVE_EXPIRED_REFUSAL;
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the label a purchase's batch carries on its node starts with. */
export const ARCHIVE_PURCHASE_NODE_LABEL_PREFIX = 'archive-';

/** How many hex digits of the request id the node label carries: its first twelve. */
export const ARCHIVE_PURCHASE_NODE_LABEL_HEX = 12;

/**
 * The label a purchase's batch carries on its node: the prefix and the first twelve hex digits of the purchase's
 * request id, in lower case. A new batch's id is known only once the node answers, so a purchase whose answer was lost
 * is found again by this label among the node's batches. The journal keeps the label unique. The name a person gave
 * the batch is kept in the manager, never on the node.
 */
export function archivePurchaseNodeLabel(requestId: string): string {
  const id = requestId.toLowerCase();
  if (!UUID.test(id)) throw new Error('A purchase request id is a UUID.');
  return `${ARCHIVE_PURCHASE_NODE_LABEL_PREFIX}${id.replaceAll('-', '').slice(0, ARCHIVE_PURCHASE_NODE_LABEL_HEX)}`;
}

/** The fields of bee's `/stamps` entry that decide whether a batch is the one a purchase bought. */
export interface PurchasedBatchLike {
  label?: string | null;
  depth?: number | null;
  immutableFlag?: boolean | null;
}

/** What a settle knows of the purchase and of the batches that cannot be it. */
export interface ArchivePurchaseSettleContext {
  /** The batch asked about, 64 hex digits without `0x`, in lower case. */
  batchId: string;
  /** The label the purchase gave its batch on the node, as {@link archivePurchaseNodeLabel} made it. */
  nodeLabel: string;
  /** The depth the purchase asked for. */
  depth: number;
  /** The catalogue's pinned batch and the one a pending move left, in the same form, without the absent ones. */
  catalogueBatchIds: readonly string[];
  /** The batches that are archive batches already, in the same form. */
  archiveBatchIds: readonly string[];
}

/**
 * Whether a batch the node lists is the one a purchase with a lost answer bought: it carries exactly the purchase's
 * label, has the purchase's depth and is immutable, and is neither the catalogue's batch nor an archive batch already.
 */
export function isPurchasedArchiveBatch(stamp: PurchasedBatchLike, context: ArchivePurchaseSettleContext): boolean {
  if (stamp.label !== context.nodeLabel) return false;
  if (stamp.depth !== context.depth || stamp.immutableFlag !== true) return false;
  return !context.catalogueBatchIds.includes(context.batchId) && !context.archiveBatchIds.includes(context.batchId);
}
