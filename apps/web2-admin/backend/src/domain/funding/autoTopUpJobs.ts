import {
  fundingNodeChainCurrent,
  type FundingAccountAnswer,
  type FundingBatch,
  type FundingInventory,
  type FundingNode,
  type FundingPostage,
} from '@streaming-monorepo/contracts';
import type { AutoTopUpJob, AutoTopUpSettings } from '@streaming-monorepo/web2-admin-common';

import type { AutoTopUpMarkRow } from './StampAutoTopUpStore.js';

/**
 * How the tick of stamp auto top-up runs its three jobs (docs/architecture/funding.md, "Auto top-up"). Every
 * `AUTO_TOPUP_TICK_SECONDS` one backend, under the store's tick lock, reads the manager once and hands each job that
 * is not paused an {@link AutoTopUpTickContext}, in the order of `AUTO_TOPUP_JOBS`: alert, wallet, stamp. Each job is
 * an {@link AutoTopUpJobRunner}, and the tick records what it answers with the store's `recordRun`.
 */

/**
 * What one tick read of the manager, once, for all three jobs: the inventory with every node, batch and archive stamp
 * and each node's view of the chain, the price of postage, the brand wallet's account, and the addresses an operator
 * confirmed. A tick whose manager does not answer, answers for another chain, or has no price runs no job.
 */
export interface AutoTopUpFunding {
  inventory: FundingInventory;
  /** The inventory's price of postage, which every top-up of the tick is worked out at. */
  postage: FundingPostage;
  /**
   * The brand wallet's account as the manager read it: its address, balances, nonce, fees and gas limits. Null when
   * the admin holds no brand wallet key, and then nothing can be sent from it.
   */
  brandWallet: FundingAccountAnswer | null;
  /** The wallet address an operator confirmed for each node (the pins), by node id, in lower case. */
  pins: ReadonlyMap<string, string>;
}

/**
 * A marked stamp as one tick reads it: its mark, and its node and batch as the manager's inventory lists them now.
 * The node and the batch are found as a stamp operation finds them: the batch the mark's node uploads with, or an
 * archive stamp that node holds, paid for from the same wallet.
 */
export interface AutoTopUpMarkedStamp {
  mark: AutoTopUpMarkRow;
  /**
   * The mark's node as the inventory lists it, with the wallet that pays for the top-ups, or null when the inventory
   * lists no stage's node or catalogue node by that id: the node is gone, or it holds the archive stamp as a catalogue
   * node no longer, whose wallet the admin does not fund.
   */
  node: FundingNode | null;
  /**
   * The batch as the node reports it, or null when the inventory lists it no more, with the node or as one of its
   * archive stamps: the node holds it no more.
   */
  batch: FundingBatch | null;
  /** Whether the batch is an archive stamp, held beside the batch the node uploads with. */
  archive: boolean;
  /**
   * Whether the node's view of the chain is current, so the time the batch has left can be gone by
   * (`fundingNodeChainCurrent`): false when it is behind, null when the manager could not read it, did not say, or
   * lists no node.
   */
  chainCurrent: boolean | null;
}

/** What a job is handed for one run. */
export interface AutoTopUpTickContext {
  /** The moment the tick started: every rule of the run is read against it. */
  now: Date;
  /** The numbers in force: the saved ones, or `AUTO_TOPUP_DEFAULTS` while none were saved. */
  settings: AutoTopUpSettings;
  funding: AutoTopUpFunding;
  /**
   * Every marked stamp, the earliest mark first, with the store's marks read as this job starts, so an alert the job
   * before it recorded is in it.
   */
  stamps: AutoTopUpMarkedStamp[];
}

/** What a run did, which the tick records as the job's last run (`recordRun`). */
export interface AutoTopUpJobResult {
  /** Whether the run went through. False when something stopped it that a person may have to look at. */
  ok: boolean;
  /** What it did or what stopped it, in a sentence the Auto top-up tab shows. */
  outcome: string;
}

/**
 * One of the three jobs. `run` is called once a tick while the job is not paused, never twice at once, and the next
 * job runs after it settles. A run that throws is recorded as not ok with the error's message, and the tick goes on.
 */
export interface AutoTopUpJobRunner {
  readonly job: AutoTopUpJob;
  run(context: AutoTopUpTickContext): Promise<AutoTopUpJobResult>;
}

/**
 * Each mark read against the inventory: the node entries of the mark's node id among the stages' nodes and the
 * catalogue node, the batch one of them uploads with, or else an archive stamp held by that node. A node is listed
 * once for each batch it uploads with, each time with the same wallet.
 */
export function markedStampsOf(
  inventory: FundingInventory,
  marks: readonly AutoTopUpMarkRow[],
): AutoTopUpMarkedStamp[] {
  const entries = [
    ...inventory.stages.flatMap((stage) => stage.nodes),
    ...(inventory.catalogue ? [inventory.catalogue] : []),
  ];
  const archived = inventory.archiveBatches ?? [];
  return marks.map((mark) => {
    const batchId = mark.batchId.toLowerCase();
    const named = entries.filter((node) => node.nodeId === mark.nodeId);
    const own = named.find((node) => node.batch?.batchId.toLowerCase() === batchId);
    const held = own
      ? undefined
      : archived.find((archive) => archive.nodeId === mark.nodeId && archive.batchId.toLowerCase() === batchId);
    const node = own ?? named[0] ?? null;
    return {
      mark,
      node,
      batch: own?.batch ?? held ?? null,
      archive: held !== undefined,
      chainCurrent: node ? fundingNodeChainCurrent(node) : null,
    };
  });
}
