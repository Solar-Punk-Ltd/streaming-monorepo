import {
  FUNDING_CATALOGUE_PURCHASE_MIN_DEPTH,
  FUNDING_PURCHASE_MAX_DEPTH,
  FUNDING_PURCHASE_MIN_DEPTH,
  type FundingBatchPurchasePurpose,
  type FundingNode,
  type FundingPostage,
  type FundingPurchaseApplyState,
  type StageStampState,
  fundingPurchaseRestartable,
} from '@streaming-monorepo/contracts';

import { FUNDING_PATH } from './funding.js';
import { SECONDS_PER_DAY } from './stampQuote.js';

/**
 * Buying a new batch from the Stamps tab of the Funding page, in place of a rung's batch or of the catalogue batch
 * that expired, that its node holds no more, or that was never set. The node that holds the role buys it and pays
 * for it from its own wallet, through the manager, and the manager and the admin then put it to use by themselves:
 * a rung's batch is set on the rung and its stages' uploaders are restarted, and the catalogue is moved onto its new
 * batch. `docs/architecture/funding.md`, "Buying a new batch", is the design.
 *
 * An archive stamp is bought on the same tab through `archive.ts`, which keeps its own dialog and its own records.
 */

/** GET lists the purchases a node's row shows, as {@link BatchPurchasesResponse} says; POST starts one. */
export const FUNDING_BATCH_PURCHASES_ADMIN_PATH = `${FUNDING_PATH}/batch-purchases`;

/** GET: one purchase. */
export function fundingBatchPurchaseAdminPath(purchaseId: string): string {
  return `${FUNDING_BATCH_PURCHASES_ADMIN_PATH}/${encodeURIComponent(purchaseId)}`;
}

/** POST a {@link BatchPurchaseRestartRequest}: restart now a stage that waits for a broadcast to end. */
export function fundingBatchPurchaseRestartAdminPath(purchaseId: string): string {
  return `${fundingBatchPurchaseAdminPath(purchaseId)}/restart`;
}

/** POST, no body: take up again what stopped after the batch was bought. Nothing is bought a second time. */
export function fundingBatchPurchaseCheckAdminPath(purchaseId: string): string {
  return `${fundingBatchPurchaseAdminPath(purchaseId)}/check`;
}

/** What the Stamps tab's Buy new buys for: a rung, or a single-node stage's own node, and the catalogue. */
export type BuyablePurpose = Exclude<FundingBatchPurchasePurpose, 'archive'>;

/** The least a new batch lasts. Bee sells none for less than a day, and a day leaves no time to use it. */
export const BATCH_BUY_MIN_DAYS = 2;

/** The days the buy dialog opens with. */
export const BATCH_BUY_DEFAULT_DAYS = 30;

/** The bytes one chunk holds. */
const CHUNK_BYTES = 4096;

/**
 * Whether a node's row offers Buy new: the manager offers a replacement for it, and its batch no longer pays. That is
 * a node with no batch set, one whose batch has no time left, and one whose batch its node holds no more. A batch that
 * is ending or full keeps the top-up and the dilution it has, and a batch the manager could not read offers nothing
 * until it is read.
 */
export function batchOffersPurchase(node: Pick<FundingNode, 'batch' | 'replacement'>): boolean {
  if (node.replacement === null || node.replacement === undefined) return false;
  if (node.batch === null || node.batch === undefined) return true;
  if (node.batch.state !== undefined) return node.batch.state === 'expired' || node.batch.state === 'gone';
  return node.batch.ttlSeconds === 0;
}

/** The purpose a node's replacement is bought for: `catalogue` for the catalogue node, `rung` for any other. */
export function batchPurchasePurpose(isCatalogueNode: boolean): BuyablePurpose {
  return isCatalogueNode ? 'catalogue' : 'rung';
}

/** The depths a purchase of a purpose takes, least and most. */
export function batchBuyDepthRange(purpose: BuyablePurpose): readonly [number, number] {
  return purpose === 'catalogue'
    ? [FUNDING_CATALOGUE_PURCHASE_MIN_DEPTH, FUNDING_PURCHASE_MAX_DEPTH]
    : [FUNDING_PURCHASE_MIN_DEPTH, FUNDING_PURCHASE_MAX_DEPTH];
}

/**
 * The amount a purchase gives each chunk for `days` at `postage`'s price, in PLUR: the price of every block of the
 * days, the blocks rounded up, so the days are never short. `days` is a whole number of {@link BATCH_BUY_MIN_DAYS}
 * or more, or it throws.
 */
export function batchBuyAmountPerChunkPlur(days: number, postage: FundingPostage): string {
  if (!Number.isSafeInteger(days) || days < BATCH_BUY_MIN_DAYS) {
    throw new RangeError(`days must be a whole number of ${BATCH_BUY_MIN_DAYS} or more`);
  }
  const seconds = BigInt(days) * BigInt(SECONDS_PER_DAY);
  const blockSeconds = BigInt(postage.blockSeconds);
  const blocks = (seconds + blockSeconds - 1n) / blockSeconds;
  return (blocks * BigInt(postage.pricePerChunkPerBlockPlur)).toString();
}

/** What a batch of `depth` costs at an amount for each chunk, in PLUR: the amount for every one of its `2^depth`. */
export function batchBuyCostPlur(depth: number, amountPerChunkPlur: string): string {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 255) throw new RangeError('depth must be 0 to 255');
  return (BigInt(amountPerChunkPlur) << BigInt(depth)).toString();
}

/** What the buy dialog's calculator shows for a depth and a number of days. */
export interface BatchBuyQuote {
  amountPerChunkPlur: string;
  /** What the node's wallet pays in xBZZ, in PLUR. The gas comes on top, in xDAI. */
  costPlur: string;
  /** The life the batch starts with at today's price, in seconds. A price that rises shortens it. */
  ttlSeconds: number;
  /** The chunks the batch holds, `2^depth`, and the same in bytes. Its fullest bucket fills long before these. */
  chunks: number;
  bytes: number;
  /** What the wallet is short of for the cost, in PLUR; null when it holds the cost or was not read. */
  shortfallPlur: string | null;
}

/** The calculator's row for a depth and a number of days at today's price, against the paying wallet. */
export function batchBuyQuote(input: {
  depth: number;
  days: number;
  postage: FundingPostage;
  walletXbzzPlur: string | null;
}): BatchBuyQuote {
  const amountPerChunkPlur = batchBuyAmountPerChunkPlur(input.days, input.postage);
  const costPlur = batchBuyCostPlur(input.depth, amountPerChunkPlur);
  const blocks = BigInt(amountPerChunkPlur) / BigInt(input.postage.pricePerChunkPerBlockPlur);
  const chunks = 2 ** input.depth;
  const missing = input.walletXbzzPlur === null ? null : BigInt(costPlur) - BigInt(input.walletXbzzPlur);
  return {
    amountPerChunkPlur,
    costPlur,
    ttlSeconds: Number(blocks) * input.postage.blockSeconds,
    chunks,
    bytes: chunks * CHUNK_BYTES,
    shortfallPlur: missing !== null && missing > 0n ? missing.toString() : null,
  };
}

/**
 * What the user chose in the buy dialog, and what a purchase is started with: the depth, the kind, the days, and the
 * cost the dialog showed for them. The API works the amount out again from the depth and the days at the price it
 * reads then. When that cost is another than `costPlur`, the price moved since the dialog priced the batch, and the
 * purchase is refused with the new cost, so what is spent is what a user confirmed.
 */
export interface BatchBuyChoice {
  depth: number;
  /** True for a batch that refuses an upload into a full bucket. The catalogue's is always immutable. */
  immutable: boolean;
  /** A whole number of {@link BATCH_BUY_MIN_DAYS} or more. */
  days: number;
  /** The cost the dialog showed, in PLUR. */
  costPlur: string;
}

/** What a choice is checked against: the price of postage and the paying node's wallet, each null when not read. */
export interface BatchBuyTerms {
  postage: FundingPostage | null;
  walletXbzzPlur: string | null;
  walletXdaiWei: string | null;
}

/**
 * Why a choice cannot be bought, one sentence, or null. The depth is one the purpose takes; a catalogue batch is
 * immutable; the days are {@link BATCH_BUY_MIN_DAYS} or more; the cost is the one the price gives now; and the wallet
 * holds it, and some xDAI for the gas. A wallet that was not read refuses nothing here: the manager checks again.
 */
export function batchBuyProblem(purpose: BuyablePurpose, choice: BatchBuyChoice, terms: BatchBuyTerms): string | null {
  const [least, most] = batchBuyDepthRange(purpose);
  if (!Number.isSafeInteger(choice.depth) || choice.depth < least || choice.depth > most) {
    return purpose === 'catalogue'
      ? `A catalogue batch's depth is ${least} to ${most}.`
      : `A batch's depth is ${least} to ${most}.`;
  }
  if (purpose === 'catalogue' && !choice.immutable) return 'The catalogue is written with an immutable batch.';
  if (!Number.isSafeInteger(choice.days) || choice.days < BATCH_BUY_MIN_DAYS) {
    return `A new batch lasts ${BATCH_BUY_MIN_DAYS} days or more.`;
  }
  if (terms.postage === null) return 'The price of postage could not be read, so the batch cannot be priced now.';
  const cost = batchBuyCostPlur(choice.depth, batchBuyAmountPerChunkPlur(choice.days, terms.postage));
  if (cost !== choice.costPlur) {
    return `The price of postage moved, and this batch now costs ${cost} PLUR. Confirm it again at that cost.`;
  }
  if (terms.walletXbzzPlur !== null && BigInt(terms.walletXbzzPlur) < BigInt(cost)) {
    const missing = (BigInt(cost) - BigInt(terms.walletXbzzPlur)).toString();
    return `The node's wallet is ${missing} PLUR short of the batch's cost. Send it xBZZ on the Balance tab.`;
  }
  if (terms.walletXdaiWei !== null && BigInt(terms.walletXdaiWei) === 0n) {
    return "The node's wallet holds no xDAI for the gas. Send it xDAI on the Balance tab.";
  }
  return null;
}

/**
 * `POST /api/funding/batch-purchases`: buy a batch in place of the one a node pays with. `nodeId` is the node of the
 * Funding page's row, and `replacesBatchId` the batch that row showed, 64 hex digits with `0x`, or null for a row
 * with no batch; a row whose batch changed since is refused. A confirm comes first and no password, since the node
 * pays from its own wallet and nothing leaves the brand wallet.
 */
export interface BatchPurchaseRequest extends BatchBuyChoice {
  purpose: BuyablePurpose;
  nodeId: string;
  replacesBatchId: string | null;
}

/**
 * Where a purchase stands:
 * - `buying`: the manager was asked, and the node's transaction is not mined yet.
 * - `waiting_usable`: the batch is bought, and the node has not seen enough blocks to stamp with it.
 * - `restarting`: a rung's batch is set, and the uploaders of its stages are being restarted, as `stages` says.
 * - `moving`: the catalogue batch is designated, and the catalogue is being moved onto it, as `move` says.
 * - `done`: the batch pays for uploads on every stage that takes it, or the catalogue is written with it.
 * - `failed`: nothing was bought, or what followed the purchase stopped, and `error` says which.
 */
export type BatchPurchaseState = 'buying' | 'waiting_usable' | 'restarting' | 'moving' | 'done' | 'failed';

/** The states in which a purchase is under way, and its node's row offers no other. */
export const BATCH_PURCHASE_OPEN_STATES: readonly BatchPurchaseState[] = [
  'buying',
  'waiting_usable',
  'restarting',
  'moving',
];

/** One stage whose uploader takes a rung's new batch, and where its restart stands, in the manager's words. */
export interface BatchPurchaseStage {
  stageId: string;
  name: string;
  apply: FundingPurchaseApplyState;
  message: string | null;
}

/** What a stage's line says for each state of its restart. */
export const BATCH_PURCHASE_APPLY_TEXT: Readonly<Record<FundingPurchaseApplyState, string>> = {
  pending: 'Waiting for its turn.',
  waiting_live: 'A broadcast is live. The uploader restarts when it ends.',
  waiting_unknown: 'The manager cannot tell whether a broadcast is live, and waits.',
  waiting_settings: 'Other saved settings wait on this stage. Apply them in the manager, and the batch goes with them.',
  applying: 'The uploader is restarting.',
  applied: 'The uploader pays with the new batch.',
  failed: 'The restart did not go through.',
  not_following: "This stage's pool string is set by hand. Set the new batch on it in the manager.",
  stopped: 'The stage is stopped. It takes the new batch at its next start.',
};

/** Whether a stage's line offers Restart now: only while it waits for a broadcast, live or untold. */
export function batchPurchaseStageRestartable(stage: Pick<BatchPurchaseStage, 'apply'>): boolean {
  return fundingPurchaseRestartable(stage.apply);
}

/** What the confirm of Restart now says. */
export const BATCH_PURCHASE_RESTART_CONFIRM =
  'A live broadcast pauses while the uploader restarts: seconds for a short one, up to about five minutes for a long one. The recording is kept.';

/** `POST /api/funding/batch-purchases/:id/restart`. */
export interface BatchPurchaseRestartRequest {
  stageId: string;
}

/** A stream whose thumbnail the move cleared, because it could not be read after the old batch lapsed. */
export interface ClearedThumbnail {
  streamId: string;
  title: string;
}

/**
 * The move of the catalogue onto a bought batch, which the admin starts by itself once the manager designates it:
 * - `waiting`: the move has not started, and `message` says why when something holds it.
 * - `running`: slots are being stamped again, `slotsDone` of `slotsTotal`.
 * - `failed`: the move stopped, and `message` says why. A check starts it again from where it stopped.
 * - `done`: the catalogue is written with the new batch.
 *
 * `released` is true once the manager released the batch the catalogue moved from.
 */
export interface BatchPurchaseMove {
  state: 'waiting' | 'running' | 'failed' | 'done';
  slotsDone: number;
  slotsTotal: number | null;
  message: string | null;
  clearedThumbnails: ClearedThumbnail[];
  released: boolean;
}

/** One purchase, as the Stamps tab shows it on its node's row. */
export interface BatchPurchase {
  /** Its id, which is the request id the manager's funding API knows it by. */
  id: string;
  purpose: BuyablePurpose;
  nodeId: string;
  /** The node's name for a person, as the Funding page's row had it. */
  nodeLabel: string;
  depth: number;
  immutable: boolean;
  /** The days the user chose. */
  days: number;
  amountPerChunkPlur: string;
  costPlur: string;
  /** The batch it was bought in place of, 64 hex digits with `0x`, or null. */
  replacesBatchId: string | null;
  state: BatchPurchaseState;
  /** The batch, 64 hex digits with `0x`, once the node answered with it. */
  batchId: string | null;
  /**
   * Why a failed purchase stopped. On a done catalogue purchase, why the manager refused to release the batch the
   * catalogue moved from: the catalogue is written with the new batch, and the previous one is released in the
   * manager. Null otherwise.
   */
  error: string | null;
  /** The stages of a rung purchase, empty before the batch is set and for the catalogue. */
  stages: BatchPurchaseStage[];
  /** The move of a catalogue purchase, null before the batch is designated and for a rung. */
  move: BatchPurchaseMove | null;
  /** Whether Check again is offered: the purchase is `failed` with its batch bought, or a stage's restart failed. */
  canCheckAgain: boolean;
  /**
   * The state of the bought batch on its node, as the manager last answered it: its status's `batchState`, which the
   * admin reads with every list for a failed purchase that holds its node. Absent while there is no batch, and while
   * the manager has not said.
   */
  batchState?: StageStampState;
  /** Who started it, as the audit log names them. */
  startedBy: string;
  startedAt: string;
}

/**
 * Whether the batch a purchase bought has run out: its node holds it no more, or it has no time left. An absent
 * state says neither, so a batch the manager could not read has not run out.
 */
export function boughtBatchRanOut(purchase: Pick<BatchPurchase, 'batchState'>): boolean {
  return purchase.batchState === 'expired' || purchase.batchState === 'gone';
}

/**
 * Whether a purchase holds its node, so the node's row offers no Buy new: it is under way, or it failed with its
 * batch bought and that batch has not run out. The batch was paid for and never put to use, Check again puts it to
 * use, and a second purchase would pay twice. Once the bought batch has run out there is nothing left to check, and
 * the row offers Buy new again.
 */
export function batchPurchaseHoldsNode(
  purchase: Pick<BatchPurchase, 'state' | 'canCheckAgain' | 'batchState'>,
): boolean {
  if (BATCH_PURCHASE_OPEN_STATES.includes(purchase.state)) return true;
  return purchase.state === 'failed' && purchase.canCheckAgain && !boughtBatchRanOut(purchase);
}

/**
 * Whether a purchase's row offers Check again: the backend offers it, and the purchase did not fail with a bought
 * batch that has run out since, which no check can put to use.
 */
export function batchPurchaseOffersCheck(
  purchase: Pick<BatchPurchase, 'state' | 'canCheckAgain' | 'batchState'>,
): boolean {
  return purchase.canCheckAgain && !(purchase.state === 'failed' && boughtBatchRanOut(purchase));
}

/**
 * `GET /api/funding/batch-purchases`: the purchases under way, the ones that started or ended in the last day, and,
 * whatever its age, a purchase that failed with its batch bought, for as long as no later purchase of its node is
 * done. That batch was paid for and never put to use, so its row keeps Check again in place of Buy new while the
 * batch has not run out ({@link batchPurchaseHoldsNode}).
 */
export interface BatchPurchasesResponse {
  purchases: BatchPurchase[];
}

/** What the dialog says when the manager offers no purchases of this kind, as an older one answers a 404. */
export const BATCH_PURCHASES_NOT_OFFERED =
  'The manager does not offer batch purchases. A manager older than this page buys batches on its own pages.';

/** What a row says in place of Buy new while the catalogue move is switched off on this installation. */
export const BATCH_PURCHASE_MOVE_OFF =
  'A new catalogue batch is put to use by a move of the catalogue, which is switched off on this installation.';
