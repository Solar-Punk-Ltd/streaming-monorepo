import {
  ARCHIVE_MAX_DEPTH,
  ARCHIVE_SIZING_MARGIN,
  archiveBatchCostPlur,
  archiveChunksWithMargin,
  archiveDepthChoices,
  archiveEffectiveBytes,
  archiveEffectiveChunks,
  smallestArchiveDepthFor,
} from '@streaming-monorepo/contracts';

import type { FundingPostage } from './funding.js';
import { SECONDS_PER_DAY } from './stampQuote.js';

/**
 * Archiving a recording: the API copies the chosen qualities of a finished recording, chunk by chunk, onto an archive
 * stamp, an immutable batch on the brand's catalogue node, so the recording outlives the mutable batches of the stage
 * that made it. The copy is byte for byte, so every address stays what it was, and the catalogue, the viewer and the
 * export read an archived recording as before. `docs/architecture/web2-admin.md`, "Archiving a recording", is the
 * design.
 *
 * One job exists at a time for the whole admin, an export or an archive. An archive that a user paused, or that waits
 * for a user to confirm a purchase, gives its place up, so an export can run meanwhile.
 *
 * The routes, all behind the session, with ownership checked in the API:
 *
 * - `GET {@link ARCHIVE_PATH}` answers {@link ArchiveCurrentResponse}, the job for the widget.
 * - `POST archiveActionPath(id)` takes {@link ArchiveActionRequest} and answers {@link ArchiveCurrentResponse}, or 409
 *   {@link ArchiveRefusedAnswer}.
 * - `GET streamArchivePath(streamId)` answers {@link ArchiveOptionsResponse}, what the panel and the stream's archive
 *   card offer.
 * - `POST streamArchivePath(streamId)` takes {@link ArchiveStartRequest} and answers 202
 *   {@link ArchiveCurrentResponse}, or 409 {@link ArchiveRefusedAnswer}.
 * - `PUT streamArchiveListingPath(streamId)` takes {@link ArchiveListingRequest} and answers
 *   {@link ArchiveOptionsResponse}.
 * - `GET {@link ARCHIVE_STAMPS_PATH}` answers {@link ArchiveStampsResponse}, for the Stamps tab's group and the buy
 *   dialog.
 * - `POST {@link ARCHIVE_STAMP_PURCHASES_PATH}` takes {@link ArchiveBuyChoice}, starts a purchase from the Stamps tab,
 *   and answers 202 {@link ArchiveStampPurchase}, or 409 {@link ArchiveRefusedAnswer}. The API forwards it to the
 *   manager's funding API.
 * - `GET archiveStampPurchasePath(id)` answers {@link ArchiveStampPurchase}.
 * - `POST archiveConfirmPurchasePath(id)` takes {@link ArchiveBuyChoice}, the confirm of the stamp the archive `id`
 *   waits to buy, and answers {@link ArchiveCurrentResponse}, or 409 {@link ArchiveRefusedAnswer}: `not_now` when `id`
 *   is not the current archive's. The job owns that purchase: the API asks the manager, and the job goes through
 *   `buying` and `waiting_usable` to `copying`.
 * - `GET {@link ARCHIVE_STREAMS_PATH}` answers {@link ArchiveStreamsResponse}, the Archive page.
 *
 * The stream list and a stream's own answer carry `archive`, a {@link StreamArchiveSummary}, for the badge.
 */

/** Where the console reads the archive job on the server. */
export const ARCHIVE_PATH = '/api/archive';

/** The archive stamps with their room, and what a purchase needs. */
export const ARCHIVE_STAMPS_PATH = `${ARCHIVE_PATH}/stamps`;

/** Where a purchase from the Stamps tab is started. */
export const ARCHIVE_STAMP_PURCHASES_PATH = `${ARCHIVE_PATH}/stamp-purchases`;

/** The streams that have an archive, for the Archive page. */
export const ARCHIVE_STREAMS_PATH = `${ARCHIVE_PATH}/streams`;

/** One purchase, by its id. */
export function archiveStampPurchasePath(purchaseId: string): string {
  return `${ARCHIVE_STAMP_PURCHASES_PATH}/${encodeURIComponent(purchaseId)}`;
}

/** The options for one stream, and where an archive of it is started: GET answers the options, POST starts. */
export function streamArchivePath(streamId: string): string {
  return `/api/streams/${encodeURIComponent(streamId)}/archive`;
}

/** PUT an `ArchiveListingRequest`: the "List only archived qualities" switch of one stream. */
export function streamArchiveListingPath(streamId: string): string {
  return `${streamArchivePath(streamId)}/listing`;
}

/** POST an `ArchiveActionRequest`. */
export function archiveActionPath(jobId: string): string {
  return `${ARCHIVE_PATH}/${encodeURIComponent(jobId)}/actions`;
}

/** POST an `ArchiveBuyChoice`: the confirm of the stamp the archive `jobId` waits to buy. */
export function archiveConfirmPurchasePath(jobId: string): string {
  return `${ARCHIVE_PATH}/${encodeURIComponent(jobId)}/confirm-purchase`;
}

// What a stream shows

/**
 * One quality's copy:
 * - `none`: nothing of it was copied.
 * - `partial`: a copy stopped before it was complete. What was copied stays on Swarm.
 * - `complete`: every chunk is on the archive stamp, and Bee reported each synced.
 * - `reduced`: complete, but some parity chunks were lost before the copy. The recording plays, with less protection.
 * - `outdated`: the stream recorded again after the copy, so its playlist is another one now.
 * - `unlisted`: complete, on a stamp the manager no longer lists, so it cannot be topped up from the admin. The
 *   recording stays on Swarm until the stamp expires, so it counts as archived.
 * - `outdated`: the stream recorded again after the copy, so its playlist is another one now.
 * - `expired`: the stamp it was copied onto has expired, by its reading or its time to live.
 */
export type QualityArchiveState = 'none' | 'partial' | 'complete' | 'reduced' | 'unlisted' | 'outdated' | 'expired';

/** A stream's archive as a whole, in the same words: its best quality decides, as {@link streamArchiveState} says. */
export type StreamArchiveState = QualityArchiveState;

/** The states in which a quality plays from its archive stamp. */
export const ARCHIVED_STATES: readonly QualityArchiveState[] = ['complete', 'reduced', 'unlisted'];

/** Whether a quality in this state plays from its archive stamp. */
export function isArchived(state: QualityArchiveState): boolean {
  return ARCHIVED_STATES.includes(state);
}

const STATE_RANK: Readonly<Record<QualityArchiveState, number>> = {
  complete: 6,
  reduced: 5,
  unlisted: 4,
  outdated: 3,
  expired: 2,
  partial: 1,
  none: 0,
};

/**
 * A stream's state from its qualities': the best of them, in the order complete, reduced, unlisted, outdated, expired,
 * partial, none. One archived quality makes the stream archived, whatever the others are.
 */
export function streamArchiveState(qualities: readonly QualityArchiveState[]): StreamArchiveState {
  let best: QualityArchiveState = 'none';
  for (const state of qualities) if (STATE_RANK[state] > STATE_RANK[best]) best = state;
  return best;
}

/** What the stream list's badge says for each state, null for no badge. */
export const ARCHIVE_BADGE_TEXT: Readonly<Record<StreamArchiveState, string | null>> = {
  none: null,
  partial: 'Archive incomplete',
  complete: 'Archived',
  reduced: 'Archived, reduced protection',
  unlisted: 'Archive stamp not listed',
  outdated: 'Archive outdated',
  expired: 'Archive expired',
};

/** What the stream's archive card and the Archive page say of a copy in the `unlisted` state. */
export const ARCHIVE_UNLISTED_TEXT =
  "The manager no longer lists this archive stamp, so it can't be topped up here. Its recordings stay on Swarm until the stamp expires.";

/** A stream's archive, as the stream list and the stream's own answer carry it. */
export interface StreamArchiveSummary {
  state: StreamArchiveState;
  /** The names of the qualities that play from an archive stamp, such as `1080p`, or `source`. */
  archived: string[];
  /** Whether the catalogue lists only those qualities: the "List only archived qualities" switch. */
  archivedOnly: boolean;
}

/** One quality of a stream, on the panel and on the stream's archive card. */
export interface ArchiveQuality {
  /** What `ArchiveStartRequest.renditions` names: the rung's name, or `source`. */
  rendition: string;
  /** What the panel shows: the rung's name, or `Source`. */
  label: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  state: QualityArchiveState;
  /** The stamp its copy is on, without `0x`, and that stamp's label. Null while nothing was copied. */
  batchId: string | null;
  batchLabel: string | null;
  /** What the copy holds, once there is one. */
  chunks: number | null;
  bytes: number | null;
  /** Parity chunks that were lost before the copy, 0 unless `reduced`. */
  parityMissing: number;
  completedAt: string | null;
  completedBy: string | null;
  /** The size before any copy, from the bitrate and length, parity included. An upper bound. */
  estimatedChunks: number | null;
  estimatedBytes: number | null;
  /** What copying it is expected to cost the catalogue node's chequebook, a range in PLUR. */
  estimatedBzzLowPlur: string | null;
  estimatedBzzHighPlur: string | null;
  /** How long copying it is expected to take, from the rate the last archive measured. */
  estimatedSeconds: number | null;
  /** Null when it can be archived now; otherwise the sentence that says why not. */
  unavailable: string | null;
}

// Archive stamps

/** One archive stamp, on the Stamps tab's group and in the panel's list. */
export interface ArchiveStamp {
  /** The batch, 64 hex digits without `0x`, in lower case. */
  batchId: string;
  label: string | null;
  /**
   * The node that holds it, as the funding inventory names it, and that node's name. It is the catalogue node for a
   * stamp bought here, whose group on the Stamps tab the stamp sits in beside the catalogue batch. Null when the
   * manager's inventory was not read.
   */
  nodeId: string | null;
  nodeLabel: string | null;
  depth: number;
  immutable: boolean;
  /** The manager's word for what the batch is worth now, as `StageStampState` of `packages/contracts`. */
  state: string;
  ttlSeconds: number | null;
  /** Its fullest bucket's share of what one bucket holds. An immutable batch refuses a chunk once this reaches 1. */
  fillRatio: number | null;
  /** True only for a usable, unexpired stamp on the catalogue node. Any other is topped up, never written. */
  writable: boolean;
  designatedAt: string;
  /** What a batch of this depth holds, in chunks. */
  effectiveChunks: number;
  /** The stamps used, the sum of the batch's bucket counts as the node reports them, or null when it was not read. */
  chunksStamped: number | null;
  /** What it still holds: `effectiveChunks` less `chunksStamped`, never under 0, or null when it was not read. */
  roomChunks: number | null;
  /** How many qualities have their copy on it. */
  qualitiesArchived: number;
  /** Whether its time left is under the warning threshold. */
  expiresSoon: boolean;
}

/**
 * Whether a stamp holds `chunks` more, with the sizing margin: it can be written and its room, as the node last gave
 * it, is enough. A stamp whose room was not read fits nothing.
 */
export function archiveStampFits(stamp: Pick<ArchiveStamp, 'writable' | 'roomChunks'>, chunks: number): boolean {
  return stamp.writable && stamp.roomChunks !== null && stamp.roomChunks >= archiveChunksWithMargin(chunks);
}

/** What a buy dialog needs beside the stamps: the price, the paying wallet and the bounds. Null fields were not read. */
export interface ArchiveBuyTerms {
  postage: FundingPostage | null;
  /** The catalogue node's wallet, which pays: xBZZ for the batch, xDAI for the gas. */
  walletXbzzPlur: string | null;
  walletXdaiWei: string | null;
  /** How long a new stamp lasts unless the user says otherwise, `ARCHIVE_BUY_DEFAULT_DAYS`. */
  defaultDays: number;
  /** The least a new stamp lasts, {@link ARCHIVE_BUY_MIN_DAYS}. */
  minimumDays: number;
}

/** `GET /api/archive/stamps`. */
export interface ArchiveStampsResponse {
  /** The catalogue node's name, or null when the manager designated none. */
  nodeName: string | null;
  stamps: ArchiveStamp[];
  /** The purchases that are still running, newest first. */
  purchases: ArchiveStampPurchase[];
  /**
   * What the buy dialog prices with, or null when the price or the paying wallet could not be read, with
   * `buyUnavailable` saying why. Whether the manager offers purchases at all is not known beforehand: the button stays
   * enabled, and a manager that offers none makes the purchase route answer `purchases_not_offered`, whose sentence
   * the dialog shows.
   */
  buy: ArchiveBuyTerms | null;
  buyUnavailable: string | null;
  /** The days under which a stamp's time left is worth a warning, `ARCHIVE_TTL_WARNING_DAYS`. */
  ttlWarningDays: number;
}

// Buying a stamp

/** The least a new archive stamp lasts, in days. */
export const ARCHIVE_BUY_MIN_DAYS = 2;

/** One depth a buy dialog offers, with what it holds and costs for the days chosen. */
export interface ArchiveBuyQuoteRow {
  depth: number;
  effectiveBytes: number;
  effectiveChunks: number;
  /** What the purchase gives each chunk, in PLUR, for every block of the days. */
  amountPerChunkPlur: string;
  /** What the node pays for the batch, in PLUR: the amount per chunk for each of its `2^depth` stamps. */
  costPlur: string;
}

/** What a buy dialog shows: one row per depth offered, shallowest first, and the depth it starts on. */
export interface ArchiveBuyQuote {
  /** The chunks to make room for, the recording's with its margin, or null when no recording is being sized. */
  chunksNeeded: number | null;
  /**
   * The depth the dialog starts on: the smallest that holds the recording, or the shallowest of the table when no
   * recording is being sized. Null when no depth holds it. The user can pick any deeper row.
   */
  defaultDepth: number | null;
  rows: ArchiveBuyQuoteRow[];
}

/**
 * The rows of a buy dialog for `days` at `postage`'s price. With `chunks`, a recording's measured chunk count, the
 * rows start at the smallest depth that holds it with the sizing margin and go on to the deepest, so a user can buy a
 * bigger stamp than the recording needs. Without, as on the Stamps tab, they are every depth. The blocks are rounded
 * up, so the days are never short. `days` is a whole number of {@link ARCHIVE_BUY_MIN_DAYS} or more, or it throws.
 */
export function archiveBuyQuote(input: {
  chunks?: number | null;
  days: number;
  postage: FundingPostage;
}): ArchiveBuyQuote {
  const { days, postage } = input;
  const amountPerChunkPlur = archiveBuyAmountPerChunkPlur(days, postage);
  const chunks = input.chunks ?? null;
  const depths = chunks === null ? archiveDepthChoices() : archiveDepthChoices(chunks);
  return {
    chunksNeeded: chunks === null ? null : archiveChunksWithMargin(chunks),
    defaultDepth: chunks === null ? (depths[0] ?? null) : smallestArchiveDepthFor(chunks),
    rows: depths.map((depth) => ({
      depth,
      effectiveBytes: archiveEffectiveBytes(depth),
      effectiveChunks: archiveEffectiveChunks(depth),
      amountPerChunkPlur,
      costPlur: archiveBatchCostPlur(depth, amountPerChunkPlur),
    })),
  };
}

/**
 * The amount a purchase gives each chunk for `days` at `postage`'s price, in PLUR: the price of every block of the
 * days, the blocks rounded up. The buy dialog's rows and the API's check of a choice both use it.
 */
export function archiveBuyAmountPerChunkPlur(days: number, postage: FundingPostage): string {
  if (!Number.isSafeInteger(days) || days < ARCHIVE_BUY_MIN_DAYS) {
    throw new RangeError(`days must be a whole number of ${ARCHIVE_BUY_MIN_DAYS} or more`);
  }
  const seconds = BigInt(days) * BigInt(SECONDS_PER_DAY);
  const blockSeconds = BigInt(postage.blockSeconds);
  const blocks = (seconds + blockSeconds - 1n) / blockSeconds;
  return (blocks * BigInt(postage.pricePerChunkPerBlockPlur)).toString();
}

/**
 * What the user chose in the buy dialog, and what a purchase is started with: the depth, the days, a label, and the
 * cost the dialog showed for them. The API works the amount out again from the depth and the days at the price it
 * reads then. When that cost is another than `costPlur`, the price moved since the dialog priced the stamp, and the
 * purchase is refused with `price_moved` and the new cost, so what is spent is what a user confirmed.
 */
export interface ArchiveBuyChoice {
  depth: number;
  /** A whole number of {@link ARCHIVE_BUY_MIN_DAYS} or more. */
  days: number;
  /** 1 to 64 characters once trimmed, or null. */
  label: string | null;
  /** The cost the dialog's row showed, in PLUR. */
  costPlur: string;
}

/**
 * Why a choice cannot be bought, one sentence, or null. The depth is one the table names and, with `chunksNeeded`,
 * holds the recording; the days are {@link ARCHIVE_BUY_MIN_DAYS} or more; the cost is the one the price gives now; and
 * the wallet holds it, and some xDAI for the gas. A wallet that was not read refuses nothing here: the manager checks
 * again.
 */
export function archiveBuyProblem(
  choice: ArchiveBuyChoice,
  terms: Pick<ArchiveBuyTerms, 'postage' | 'walletXbzzPlur' | 'walletXdaiWei'>,
  chunksNeeded: number | null = null,
): string | null {
  const holds = archiveEffectiveChunks(choice.depth);
  if (holds === 0) return `An archive stamp's depth is 17 to ${ARCHIVE_MAX_DEPTH}.`;
  if (chunksNeeded !== null && holds < chunksNeeded) {
    return `A stamp of depth ${choice.depth} holds ${holds} chunks, and this recording needs ${chunksNeeded}.`;
  }
  if (!Number.isSafeInteger(choice.days) || choice.days < ARCHIVE_BUY_MIN_DAYS) {
    return `A new archive stamp lasts ${ARCHIVE_BUY_MIN_DAYS} days or more.`;
  }
  if (terms.postage === null) return 'The price of postage could not be read, so the stamp cannot be priced now.';
  const cost = archiveBatchCostPlur(choice.depth, archiveBuyAmountPerChunkPlur(choice.days, terms.postage));
  if (cost !== choice.costPlur) {
    return `The price of postage moved, and this stamp now costs ${cost} PLUR. Confirm it again at that cost.`;
  }
  if (terms.walletXbzzPlur !== null && BigInt(terms.walletXbzzPlur) < BigInt(cost)) {
    const missing = (BigInt(cost) - BigInt(terms.walletXbzzPlur)).toString();
    return `The catalogue node's wallet is ${missing} PLUR short of the stamp's cost. Send it xBZZ on the Balance tab.`;
  }
  if (terms.walletXdaiWei !== null && BigInt(terms.walletXdaiWei) === 0n) {
    return "The catalogue node's wallet holds no xDAI for the gas. Send it xDAI on the Balance tab.";
  }
  return null;
}

/**
 * What the wallet is short of for a cost, in PLUR, or null when it holds the cost or was not read. The panel shows it
 * beside a stamp an archive waits to buy.
 */
export function archiveWalletShortfallPlur(costPlur: string, walletXbzzPlur: string | null): string | null {
  if (walletXbzzPlur === null) return null;
  const missing = BigInt(costPlur) - BigInt(walletXbzzPlur);
  return missing > 0n ? missing.toString() : null;
}

/** What the dialog says when the manager offers no purchases, as one older than archive stamps answers a 404. */
export const ARCHIVE_PURCHASES_NOT_OFFERED =
  'The manager does not offer stamp purchases. A manager older than this page does not buy archive stamps.';

/**
 * Where a purchase stands:
 * - `buying`: the manager was asked, and the node's transaction is not mined yet.
 * - `waiting_usable`: the batch is bought, and the node has not seen enough blocks to stamp with it.
 * - `usable`: the batch is an archive stamp and can be written.
 * - `failed`: nothing was bought, and `error` says why.
 */
export type ArchiveStampPurchaseState = 'buying' | 'waiting_usable' | 'usable' | 'failed';

/** One purchase, from the Stamps tab or from an archive job. */
export interface ArchiveStampPurchase {
  /** Its id, which is the request id the manager's funding API knows it by. */
  id: string;
  depth: number;
  /** The days the user chose. */
  days: number;
  amountPerChunkPlur: string;
  costPlur: string;
  label: string | null;
  state: ArchiveStampPurchaseState;
  /** The batch, 64 hex digits without `0x`, once the node answered with it. */
  batchId: string | null;
  error: string | null;
  /** Who started it, as the audit log names them. */
  startedBy: string;
  startedAt: string;
}

// The job

/**
 * - `measuring`: each segment's root is read, which gives the chunks to copy and proves that root is on Swarm. A
 *   chunk deeper in a segment that cannot be read shows while copying, as the `unreadable` pause.
 * - `awaiting_purchase`: the user chose to buy a new stamp, the size is known, and the buy dialog waits for a confirm,
 *   which is a POST to `archiveConfirmPurchasePath(id)`.
 * - `buying`, `waiting_usable`: the purchase runs, then the batch becomes usable.
 * - `copying`: chunks are read through the catalogue node and posted to it under the archive stamp.
 * - `verifying`: every chunk was posted, and the job waits for Bee to report each one synced.
 * - `paused`: stopped, with a reason, until someone decides.
 * - `waiting`: the stream went live again, and the job continues by itself once it is a recording again.
 * - `done`: every chosen quality is complete, or complete with reduced protection.
 */
export type ArchiveJobState =
  | 'measuring'
  | 'awaiting_purchase'
  | 'buying'
  | 'waiting_usable'
  | 'copying'
  | 'verifying'
  | 'paused'
  | 'waiting'
  | 'done';

/**
 * Why an archive paused:
 * - `user`: someone pressed Pause.
 * - `unreadable`: a data or tree chunk was neither read nor rebuilt from its parity, after retries.
 * - `live`: the stream went live again, so its recording is changing.
 * - `batch`: the stamp is full, expired, removed, not writable or lacks room for what is left.
 * - `node`: the catalogue node does not answer, or another node was designated.
 * - `funds`: the catalogue node's chequebook is under `ARCHIVE_CHEQUEBOOK_FLOOR_BZZ`.
 * - `problem`: anything else, in `pauseMessage`: a tag that stopped moving, a purchase that failed.
 */
export type ArchivePauseReason = 'user' | 'unreadable' | 'live' | 'batch' | 'node' | 'funds' | 'problem';

/** Whether a pause asks for a decision: every reason but a user's own Pause. */
export function archivePauseNeedsDecision(reason: ArchivePauseReason | null): boolean {
  return reason !== null && reason !== 'user';
}

/**
 * Whether an archive in this state holds the one place a job has, so no export and no other archive can start. A
 * finished one holds nothing. One a user paused, and one waiting for a user to confirm a purchase, give the place up:
 * an export can run meanwhile, and Resume, or the confirm, takes the place again once it is free.
 */
export function archiveHoldsPlace(state: ArchiveJobState, pauseReason: ArchivePauseReason | null): boolean {
  if (state === 'done' || state === 'awaiting_purchase') return false;
  if (state === 'paused') return pauseReason !== 'user';
  return true;
}

/**
 * What a user can do to the archive:
 * - `pause`: stop after the chunks in flight. The place is given up.
 * - `resume`: carry on; after `unreadable`, `batch`, `node`, `funds` and `problem` it tries again.
 * - `wait`: after `live`, carry on by itself once the stream is a recording again.
 * - `use_stamp`: copy onto this archive stamp, in place of the one chosen or of a purchase.
 * - `buy_new`: go to the buy dialog, in place of the stamp chosen.
 * - `cancel`: stop. What was copied stays on Swarm, and its qualities show as partial.
 * - `dismiss`: close the widget of a finished archive, for the user who asks only.
 */
export type ArchiveAction = 'pause' | 'resume' | 'wait' | 'use_stamp' | 'buy_new' | 'cancel' | 'dismiss';

export const ARCHIVE_ACTIONS: readonly ArchiveAction[] = [
  'pause',
  'resume',
  'wait',
  'use_stamp',
  'buy_new',
  'cancel',
  'dismiss',
];

/** `POST /api/archive/:id/actions`. */
export type ArchiveActionRequest =
  | { action: 'pause' | 'resume' | 'wait' | 'buy_new' | 'cancel' | 'dismiss' }
  | { action: 'use_stamp'; batchId: string };

/** How one quality's copy went, once it ended. */
export type ArchiveItemResult = 'complete' | 'reduced';

/** One chosen quality of the job. They are copied one after another, in the order chosen. */
export interface ArchiveJobItem {
  rendition: string;
  label: string;
  state: 'waiting' | 'measuring' | 'copying' | 'verifying' | 'done';
  result: ArchiveItemResult | null;
  /** Segments in the recording, once its playlist was read. */
  segmentsTotal: number | null;
  segmentsDone: number;
  /** The chunks to copy, an upper bound from the measured sizes, once measured. */
  chunksTotal: number | null;
  chunksCopied: number;
  /** Chunks the network had lost that were brought back from their parity. */
  chunksRebuilt: number;
  /** Parity chunks that could not be read, and were left out. */
  parityMissing: number;
  /**
   * Posts Bee reports settled, of those made under this quality's tag: the tag's `synced` and `seen` together. The
   * quality is complete when no data or tree chunk failed, the tag's `split` equals the posts made, and this equals
   * the `split`.
   */
  chunksSynced: number;
  /** The posts made under the tag, a chunk posted again after a resume counted again. */
  postsMade: number;
  bytesCopied: number;
}

/** Where the job copies to: an archive stamp, or one being bought for it. */
export type ArchiveJobTarget =
  | { kind: 'stamp'; batchId: string; label: string | null }
  | { kind: 'purchase'; purchase: ArchiveStampPurchase | null };

/**
 * The stamp an archive in `awaiting_purchase` proposes, which the buy dialog opens on: the recording's measured
 * chunks, the smallest depth that holds them with the margin, the default days, what that costs now, and what the
 * paying wallet is short of. The user can pick a deeper stamp and other days in the dialog.
 */
export interface ArchivePurchaseProposal {
  /** The measured chunks of every chosen quality together, which the dialog's rows start from. */
  chunkCount: number;
  /** The smallest depth that holds them, or null when no depth does. */
  depth: number | null;
  days: number;
  /** The cost of that depth for those days at the price now, or null when the price was not read or no depth fits. */
  costPlur: string | null;
  /** What the catalogue node's wallet lacks of that cost, or null when it holds it or was not read. */
  shortfallPlur: string | null;
  terms: ArchiveBuyTerms;
}

/** The archive on the server, as every user sees it. */
export interface ArchiveJobSummary {
  id: string;
  streamId: string;
  streamTitle: string;
  state: ArchiveJobState;
  /** Set while `paused`, null otherwise. */
  pauseReason: ArchivePauseReason | null;
  /** The sentence that says why it paused, while `paused`. */
  pauseMessage: string | null;
  pausedAt: string | null;
  /** Whether it holds the one place a job has, as {@link archiveHoldsPlace} says. */
  holdsPlace: boolean;
  target: ArchiveJobTarget;
  /** Set while `awaiting_purchase`, null otherwise. */
  proposal: ArchivePurchaseProposal | null;
  items: ArchiveJobItem[];
  /** The chunks of every chosen quality together, once all are measured. */
  chunksTotal: number | null;
  chunksCopied: number;
  bytesCopied: number;
  /** The rate of the copy now, and null before it has one. */
  chunksPerSecond: number | null;
  /** From the chunks left and the rate, or the last job's rate before this one has one. Null when neither is known. */
  secondsLeft: number | null;
  /** What the copy is expected to cost the catalogue node's chequebook, a range in PLUR, once measured. */
  bzzEstimateLowPlur: string | null;
  bzzEstimateHighPlur: string | null;
  /** What the chequebook can still pay, in PLUR, as the manager last read it. */
  chequebookAvailablePlur: string | null;
  /** What the chequebook went down by, once done. The catalogue's own writes share it, so it is approximate. */
  bzzSpentPlur: string | null;
  /** Who started it, as the audit log names them. */
  startedBy: string;
  /** Whether the user asking started it: the panel comes to front for them when it needs a decision. */
  startedByYou: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Whether the user asking closed its widget. Only a finished archive can be closed. */
  dismissed: boolean;
  /** What can be done to it now, as the API decides. */
  actions: ArchiveAction[];
}

/** `GET /api/archive`: the archive on the server, or null when there is none. */
export interface ArchiveCurrentResponse {
  archive: ArchiveJobSummary | null;
}

export type ArchiveRefusalProblem =
  | 'busy'
  | 'not_finished'
  | 'nothing_to_archive'
  | 'no_node'
  | 'no_stamp'
  | 'stamp_unusable'
  | 'purchase_refused'
  | 'purchases_not_offered'
  | 'price_moved'
  | 'not_now';

export interface ArchiveRefusal {
  problem: ArchiveRefusalProblem;
  message: string;
}

/** `GET /api/streams/:id/archive`: what the panel and the stream's archive card offer for one stream. */
export interface ArchiveOptionsResponse {
  streamId: string;
  title: string;
  /** The day the broadcast started, in UTC: `YYYY-MM-DD`. */
  date: string | null;
  qualities: ArchiveQuality[];
  /** The archive stamps that can be written, with their room: where a new copy can go. */
  stamps: ArchiveStamp[];
  /**
   * The archive stamps that hold a copy of this stream, whole or not, each once and whatever their state: a full one, one
   * left on a node that is the catalogue node no longer, one that expired. The card warns from these when one runs out
   * soon. A stamp the manager no longer lists is in neither list.
   */
  holdingStamps: ArchiveStamp[];
  /** What buying a new stamp needs, or null when none can be bought now. */
  buy: ArchiveBuyTerms | null;
  /**
   * What the catalogue node's chequebook can pay now, in PLUR, as the manager's inventory reads it: the same reading
   * the job's funds check uses. Null when it could not be read. The panel warns before a start when the high end of
   * the picked qualities' estimate is above it; the copy would then pause for funds once the chequebook runs low.
   */
  chequebookAvailablePlur: string | null;
  summary: StreamArchiveSummary;
  /** Whether the switch is offered: one quality plays from an archive stamp. */
  canListArchivedOnly: boolean;
  /** A stage batch that holds a quality with no archive has expired, so the switch is worth turning on. */
  archivedOnlyHint: string | null;
  /** Why no archive of this stream can start now, or null. */
  refusal: ArchiveRefusal | null;
  /** The archive on the server, of this stream or another. */
  current: ArchiveJobSummary | null;
}

/** `POST /api/streams/:id/archive`. The qualities are copied in the order named. */
export interface ArchiveStartRequest {
  renditions: string[];
  /** An archive stamp to copy onto, or a new one, sized and confirmed after the job has measured. */
  target: { batchId: string } | { buyNew: true };
}

/** `PUT /api/streams/:id/archive/listing`. */
export interface ArchiveListingRequest {
  archivedOnly: boolean;
}

/** The 409 the API answers when an archive or a purchase cannot start, or an action cannot be done now. */
export interface ArchiveRefusedAnswer {
  error: 'archive_refused';
  problem: ArchiveRefusalProblem;
  message: string;
}

// The Archive page

/** One stream that has an archive. */
export interface ArchivedStream {
  streamId: string;
  title: string;
  /** The day the broadcast started, in UTC: `YYYY-MM-DD`. */
  date: string | null;
  summary: StreamArchiveSummary;
  /** Every quality that has a copy, whole or not. */
  qualities: Array<
    Pick<ArchiveQuality, 'rendition' | 'label' | 'state' | 'batchId' | 'batchLabel' | 'bytes' | 'parityMissing'> & {
      /** The time left on the stamp its copy is on, or null when the manager did not read it. */
      batchTtlSeconds: number | null;
    }
  >;
  /** The bytes of every archived quality together. */
  bytes: number;
  /** When and by whom its newest copy was completed. */
  archivedAt: string | null;
  archivedBy: string | null;
}

/** `GET /api/archive/streams`: only streams with an archive, newest copy first. */
export interface ArchiveStreamsResponse {
  streams: ArchivedStream[];
}

/** The room a recording is given beside its measured chunks when a stamp is sized or checked for it. */
export const ARCHIVE_ROOM_MARGIN = ARCHIVE_SIZING_MARGIN;
