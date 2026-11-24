import type { FundingNode, FundingPostage } from '@streaming-monorepo/contracts';
import {
  autoTopUpStampPlan,
  autoTopUpWalletPlan,
  operableBatch,
  SECONDS_PER_DAY,
  type AutoTopUpSettings,
  type AutoTopUpStampPlan,
  type AutoTopUpWalletPlan,
  type OperableBatch,
} from '@streaming-monorepo/web2-admin-common';

import type { AutoTopUpMarkedStamp, AutoTopUpTickContext } from './autoTopUpJobs.js';
import type { StampName } from './autoTopUpTexts.js';
import { nodeName } from './FundingService.js';

/** A node whose wallet was read: its address and both its balances. */
export type ReadWalletNode = FundingNode & { walletAddress: string; xdaiWei: string; xbzzPlur: string };

/**
 * Where a marked stamp stands for the wallet job and the stamp job in one run (docs/architecture/funding.md, "From
 * alert to top-up"):
 * - `ready`: its node's wallet was read, the node's view of the chain is current, and the batch was read whole,
 *   usable and with time left; `plan` is the rule's at the tick's price.
 * - `unread`: its node or its batch could not be read, or the node's view of the chain is behind or not known, so
 *   the time it has left cannot be gone by; nothing is done for it in the run. `reason` says which, in a sentence.
 * - `gone`: its node holds the batch no more.
 * - `expired`: the batch ran out, and takes a Buy new.
 * - `pending`: Bee does not call the batch usable yet, as one just bought.
 * - `unfunded`: no stage's node and not the catalogue node holds it: an archive stamp left on a node that is the
 *   catalogue node no longer, whose wallet the admin does not fund, so the admin does not top it up. `due` is whether
 *   the batch, read whole, is under the threshold.
 */
export type AutoTopUpStampReading =
  | {
      state: 'ready';
      stamp: AutoTopUpMarkedStamp;
      node: ReadWalletNode;
      batch: OperableBatch;
      plan: AutoTopUpStampPlan;
    }
  | { state: 'unread'; stamp: AutoTopUpMarkedStamp; reason: string }
  | { state: 'unfunded'; stamp: AutoTopUpMarkedStamp; due: boolean }
  | { state: 'gone' | 'expired' | 'pending'; stamp: AutoTopUpMarkedStamp };

export type ReadyStamp = Extract<AutoTopUpStampReading, { state: 'ready' }>;

function walletRead(node: FundingNode): node is ReadWalletNode {
  return node.readError === null && node.walletAddress !== null && node.xdaiWei !== null && node.xbzzPlur !== null;
}

/** A marked stamp read against the rule, at the tick's price and numbers. */
export function readStamp(
  stamp: AutoTopUpMarkedStamp,
  settings: AutoTopUpSettings,
  postage: FundingPostage,
): AutoTopUpStampReading {
  const { node, batch } = stamp;
  if (!batch || batch.state === 'gone') return { state: 'gone', stamp };
  if (batch.ttlSeconds === 0 || batch.state === 'expired') return { state: 'expired', stamp };
  if (!node) {
    const due = operableBatch(batch) && autoTopUpStampPlan(batch, settings, postage).phase === 'due';
    return { state: 'unfunded', stamp, due };
  }
  if (!walletRead(node)) {
    return {
      state: 'unread',
      stamp,
      reason: `The wallet of ${nodeName(node)} could not be read${node.readError ? `: ${node.readError}` : '.'}`,
    };
  }
  if (batch.readError !== null || batch.depth === null || batch.ttlSeconds === null || batch.usable === null) {
    return {
      state: 'unread',
      stamp,
      reason: `${nodeName(node)} could not be read about the batch${batch.readError ? `: ${batch.readError}` : '.'}`,
    };
  }
  if (stamp.chainCurrent !== true) {
    return {
      state: 'unread',
      stamp,
      reason:
        stamp.chainCurrent === false
          ? `The view of the chain of ${nodeName(node)} is ${node.chainLagBlocks} blocks behind, so the time the batch has left cannot be gone by.`
          : `The manager does not say how far behind the chain ${nodeName(node)} is, so the time the batch has left cannot be gone by.`,
    };
  }
  if (!operableBatch(batch)) return { state: 'pending', stamp };
  return { state: 'ready', stamp, node, batch, plan: autoTopUpStampPlan(batch, settings, postage) };
}

/** The due stamps of one wallet, the one with the least time left first, against its balances. */
export interface AutoTopUpWalletGroup {
  /** The wallet's address, in lower case. */
  address: string;
  /** Its balances: the smaller reading where several node entries read it. */
  balances: { xbzzPlur: string; xdaiWei: string };
  /** The stamps in the order of `plan.items`. */
  stamps: ReadyStamp[];
  plan: AutoTopUpWalletPlan;
}

/**
 * The stamps, ready and due, by the wallet that pays for them, each wallet against its balances
 * (`autoTopUpWalletPlan`). Several node entries may read one wallet, and then their stamps are counted together and
 * the smaller reading is the one counted on.
 */
export function walletGroupsOf(due: readonly ReadyStamp[]): AutoTopUpWalletGroup[] {
  const groups = new Map<string, { balances: { xbzzPlur: bigint; xdaiWei: bigint }; stamps: ReadyStamp[] }>();
  for (const stamp of due) {
    const address = stamp.node.walletAddress.toLowerCase();
    const xbzzPlur = BigInt(stamp.node.xbzzPlur);
    const xdaiWei = BigInt(stamp.node.xdaiWei);
    const group = groups.get(address);
    if (!group) {
      groups.set(address, { balances: { xbzzPlur, xdaiWei }, stamps: [stamp] });
      continue;
    }
    group.balances.xbzzPlur = xbzzPlur < group.balances.xbzzPlur ? xbzzPlur : group.balances.xbzzPlur;
    group.balances.xdaiWei = xdaiWei < group.balances.xdaiWei ? xdaiWei : group.balances.xdaiWei;
    group.stamps.push(stamp);
  }
  return [...groups].map(([address, group]) => {
    const balances = { xbzzPlur: group.balances.xbzzPlur.toString(), xdaiWei: group.balances.xdaiWei.toString() };
    const plan = autoTopUpWalletPlan(
      balances,
      group.stamps.map((stamp) => ({
        batchId: stamp.batch.batchId.toLowerCase(),
        ttlSeconds: stamp.batch.ttlSeconds,
        costPlur: stamp.plan.costPlur,
        costWithMarginPlur: stamp.plan.costWithMarginPlur,
      })),
    );
    const byBatch = new Map(group.stamps.map((stamp) => [stamp.batch.batchId.toLowerCase(), stamp]));
    return { address, balances, stamps: plan.items.map((item) => byBatch.get(item.batchId)!), plan };
  });
}

/**
 * How long a stamp with `ttlSeconds` left has been due: its time left counts down a second a second at a steady
 * price, so it crossed the threshold that long ago. 0 for one not due.
 */
export function dueForSeconds(ttlSeconds: number, settings: AutoTopUpSettings): number {
  return Math.max(0, settings.topUpUnderDays * SECONDS_PER_DAY - ttlSeconds);
}

/**
 * A marked stamp as a warning names it, as the alert job names it: the catalogue batch, an archive stamp by its label,
 * or a stage's batch, and the node that holds it.
 */
export function stampNameOf(context: AutoTopUpTickContext, stamp: AutoTopUpMarkedStamp): StampName {
  const { inventory } = context.funding;
  const { mark } = stamp;
  const archived = stamp.archive
    ? inventory.archiveBatches?.find(
        (archive) => archive.batchId.toLowerCase() === mark.batchId && archive.nodeId === mark.nodeId,
      )
    : undefined;
  const stage = inventory.stages.find((candidate) => candidate.nodes.some((node) => node.nodeId === mark.nodeId));
  const title = stamp.archive
    ? archived?.label
      ? `Archive stamp "${archived.label}"`
      : 'An archive stamp'
    : inventory.catalogue?.nodeId === mark.nodeId
      ? 'The catalogue batch'
      : stage
        ? `The batch of stage "${stage.name}"`
        : 'A marked batch';
  return { batchId: mark.batchId, title, nodeLabel: stamp.node?.label ?? archived?.nodeLabel ?? mark.nodeLabel };
}

/**
 * The depths the monthly estimate counts: one for each marked stamp that can be topped up, a batch read whole, usable
 * and with time left, held by a node the admin funds (`autoTopUpMonthlyEstimatePlur`).
 */
export function estimateDepthsOf(stamps: readonly AutoTopUpMarkedStamp[]): number[] {
  return stamps.flatMap((stamp) => (stamp.node && operableBatch(stamp.batch) ? [stamp.batch.depth] : []));
}
