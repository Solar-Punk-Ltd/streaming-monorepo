import type { StampState } from '@streaming-infra-manager/common';
import type { FundingPurchaseApplyState } from '@streaming-monorepo/contracts';

/**
 * The seam between a batch purchase of the funding API and the parts of the manager that put a bought batch to use.
 * The purchase, its journal, its routes and the follow-up that runs in the background are one part of the manager.
 * Setting a batch on a rung or a stage, applying a stage, and designating and releasing the catalogue batch are
 * another, which the manager's own console already drives. Each is built against these ports and tested with a fake
 * of the other side. `docs/features/postage-stamps.md`, "Bought from the admin", is the page.
 *
 * The stage side implements {@link PurchasedRungBatches}, {@link PurchaseStageApplier} and
 * {@link PurchasedCatalogueBatches}. The funding side calls them, and implements nothing here.
 *
 * A batch id here is 64 hex digits without `0x`, in lower case, as the manager keeps one. A node is named by the
 * deployment whose own Bee node it is, as the archive batches' ports name one.
 */

/** The batch that holds a role now, and the manager's verdict on it. */
export interface RoleBatchReading {
  /** The batch set on the rung or the stage, or the designated catalogue batch; null when none is. */
  batchId: string | null;
  /** The verdict the deployment's page gives: `none` with no batch, `unknown` when the node did not answer. */
  state: StampState;
}

/** One stage whose pool string names the rung a purchase bought for. */
export interface PurchaseFollower {
  /** The deployment's `instance_id`. */
  stageId: string;
  name: string;
  /**
   * Whether the stage's pool string is the pool's own, so it took the new batch when the batch was set. False for a
   * string pasted from elsewhere that names this rung's node, which the manager leaves as it is.
   */
  following: boolean;
}

/** What the funding side asks about a rung's batch, and tells of one it bought. */
export interface PurchasedRungBatches {
  /**
   * The batch set on this deployment's Bee node now, a rung's or a single-node stage's own, with its verdict. The
   * purchase's checks read it before anything is journalled.
   */
  current(profileName: string): Promise<RoleBatchReading>;

  /**
   * Sets a usable batch on the deployment as the manager's own buy form sets one, which writes the stored pool string
   * of every uploader that follows the rung, and answers every stage whose pool string names this rung's node, in the
   * order the follow-up takes them. A single-node stage answers itself, following. It is idempotent on `batchId`: a
   * batch set already changes nothing and answers the same stages. It leaves a batch another hand set meanwhile and
   * rejects with a sentence, and the purchase then stops as failed with it.
   */
  set(input: { profileName: string; batchId: string; requestId: string }): Promise<PurchaseFollower[]>;
}

/** One look at one stage, and what came of it. */
export interface PurchaseStageLook {
  apply: FundingPurchaseApplyState;
  /** A sentence about the state where there is one to say, or null. */
  message: string | null;
}

/** What the funding side asks of one stage after a rung purchase set its batch. */
export interface PurchaseStageApplier {
  /**
   * Looks at one stage and moves it one step, never more:
   * - the uploader runs and pays with `batchId`: `applied`;
   * - the stage does not run: `stopped`;
   * - its pool string is another than the pool's own: `not_following`;
   * - an Apply of it is under way: `applying`;
   * - the running uploader is behind on another saved setting beside the batch: `waiting_settings`, naming the keys;
   * - a broadcast is live, read twice `PURCHASE_LIVE_READ_GAP_MS` apart: `waiting_live`;
   * - whether one is live cannot be told: `waiting_unknown`;
   * - otherwise it starts the stage's settings Apply, the one the manager's console runs, and answers `applying`.
   *
   * With `force`, a live broadcast and one that cannot be told are passed over and the Apply starts: the admin's
   * Restart now. `force` changes nothing else, so settings that wait still answer `waiting_settings`.
   *
   * An Apply that did not go through answers `failed` with its reason, for that stage and that batch, and the next
   * look starts it again only when the follow-up was asked to check again. The look keeps that in the process, so a
   * manager that restarted starts the Apply once more where one is due. It never rejects for a stage's own trouble; it rejects only when the stage
   * could not be read at all, and the follow-up then looks again at its next turn.
   */
  look(input: { stageId: string; batchId: string; force: boolean; retryFailed: boolean }): Promise<PurchaseStageLook>;
}

/** What the funding side asks about the catalogue batch, and tells of one it bought. */
export interface PurchasedCatalogueBatches {
  /** The designated catalogue batch on this deployment's node, with its verdict; `none` when none is designated. */
  current(profileName: string): Promise<RoleBatchReading>;

  /**
   * Designates a usable batch as the catalogue batch, as a move from the batch designated before, with every check
   * the manager's own designation makes, and pushes the catalogue stamp record. It answers the batch it moved from,
   * null when none was designated. It is idempotent on `batchId`. It rejects with the designation's own sentence
   * when a check refuses, a move still pending among them, and the purchase then stops as failed with it.
   */
  designate(input: {
    profileName: string;
    batchId: string;
    requestId: string;
  }): Promise<{ previousBatchId: string | null }>;

  /**
   * Releases the batch this purchase's designation moved from, as the manager's own Release does, logged with the
   * request id in place of a user. It is idempotent: a batch released already resolves. It rejects when the
   * designation has moved on to another batch than `batchId` since.
   */
  release(input: { batchId: string; previousBatchId: string; requestId: string }): Promise<void>;
}
