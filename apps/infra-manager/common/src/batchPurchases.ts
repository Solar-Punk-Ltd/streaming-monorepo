import {
  type FundingBatchPurchasePurpose,
  type FundingPurchaseApplyState,
  type FundingPurchaseCatalogue,
  type FundingPurchaseStep,
  fundingPurchaseApplySettled,
} from '@streaming-monorepo/contracts';

import type { StampState } from './stampHealth.js';

/**
 * The rules of a batch purchase the funding API takes, for a rung, for the catalogue or as an archive stamp, that the
 * manager's API and its follow-up share. `packages/contracts/src/funding.ts` is the contract with the admin, and
 * `docs/features/postage-stamps.md`, "Bought from the admin", the page.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The hex digits of the request id a purchase's label on its node carries. */
export const PURCHASE_NODE_LABEL_HEX = 12;

/** What a purchase's label on its node is: the purpose, a hyphen and twelve hex digits. */
export const PURCHASE_NODE_LABEL_PATTERN = /^(rung|catalogue|archive)-[0-9a-f]{12}$/;

/**
 * The label a purchase's batch carries on its node: the purpose, a hyphen and the first twelve hex digits of the
 * purchase's request id, in lower case. A new batch's id is known only once the node answers, so a purchase whose
 * answer was lost is found again by this label among the node's batches. The journal keeps the label unique. An
 * archive stamp's is the label `archivePurchaseNodeLabel` gives it.
 */
export function purchaseNodeLabel(purpose: FundingBatchPurchasePurpose, requestId: string): string {
  const id = requestId.toLowerCase();
  if (!UUID.test(id)) throw new Error('A purchase request id is a UUID.');
  return `${purpose}-${id.replaceAll('-', '').slice(0, PURCHASE_NODE_LABEL_HEX)}`;
}

/** How often a bought batch is read until its node calls it usable, the pace of the manager's own buy form. */
export const PURCHASE_USABLE_POLL_MS = 3_000;

/** How often the follow-up looks again at a purchase that waits: for a broadcast to end, for an Apply to finish. */
export const PURCHASE_FOLLOW_UP_MS = 30_000;

/**
 * The time between the two readings of whether a broadcast is live. The engine reports a publisher only about every
 * ten seconds, so one reading can miss a publisher that connected a moment ago.
 */
export const PURCHASE_LIVE_READ_GAP_MS = 15_000;

/**
 * Why a purchase for a rung or for the catalogue is refused for the batch that holds the role now, in a sentence, or
 * null when it is taken. A purchase replaces a batch that no longer pays: one that expired, one its node holds no
 * more, or none at all. A batch that still works is topped up for more life or diluted for more room, and one whose
 * node did not answer is left until it does. An archive stamp replaces none, so nothing is refused for it here.
 */
export function purchaseReplaceProblem(purpose: FundingBatchPurchasePurpose, state: StampState): string | null {
  if (purpose === 'archive') return null;
  const role = purpose === 'catalogue' ? 'The catalogue batch' : 'The batch set on this node';
  switch (state) {
    case 'none':
    case 'expired':
    case 'gone':
      return null;
    case 'unknown':
      return `${role} could not be read from its node, so whether it needs a replacement is not known. Try again once the node answers.`;
    case 'pending':
      return `${role} was bought a moment ago and is not usable yet. It needs no replacement.`;
    case 'full':
      return `${role} is full and has time left. Dilute it for more room.`;
    case 'active':
      return `${role} still pays for uploads. Top it up for more life, or dilute it for more room.`;
  }
}

/**
 * The step of a purchase whose batch is where its purpose puts it: `done` when nothing is left to do, `set` until
 * then. A rung's is done once every following stage is settled, and at once when none follows. The catalogue's is
 * done once the batch it moved from is released, and at once when it moved from none. An archive stamp's is done.
 */
export function purchaseStepOnceSet(
  purpose: FundingBatchPurchasePurpose,
  stages: readonly { apply: FundingPurchaseApplyState }[],
  catalogue: FundingPurchaseCatalogue | null,
): Extract<FundingPurchaseStep, 'set' | 'done'> {
  if (purpose === 'rung') return stages.every((stage) => fundingPurchaseApplySettled(stage.apply)) ? 'done' : 'set';
  if (purpose === 'catalogue') {
    return catalogue === null || catalogue.previousBatchId === null || catalogue.released ? 'done' : 'set';
  }
  return 'done';
}

/** What a restart is refused with when its stage does not wait for a broadcast. */
export const PURCHASE_RESTART_NOT_WAITING_REFUSAL =
  'This stage does not wait for a broadcast to end, so there is nothing to restart now.';

/** What a release is refused with when the purchase is not a catalogue purchase that waits for one. */
export const PURCHASE_RELEASE_NOT_WAITING_REFUSAL =
  'This purchase has no previous catalogue batch that waits for its release.';

/** What a check is refused with when the purchase has nothing that stopped. */
export const PURCHASE_CHECK_NOTHING_REFUSAL = 'Nothing of this purchase stopped, so there is nothing to take up again.';

/** What the follow-up stops with when the batch is still not usable an hour after it was bought. */
export const PURCHASE_NOT_USABLE_ERROR =
  'The batch was bought, and its node did not call it usable within an hour. Check again once the node is in step with the chain.';
