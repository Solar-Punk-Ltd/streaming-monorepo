import {
  AUTO_TOPUP_ONCE_PER_SECONDS,
  formatBaseUnits,
  XBZZ_DECIMALS,
  type FundingPostage,
  type FundingStampItem,
  type StampTopUpItemRequest,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { STAMP_AUTO_TOPUP } from '../actor.js';
import { FundingBusyError, FundingRefusedError } from '../errors/index.js';
import { Logger } from '../Logger.js';

import type {
  AutoTopUpJobResult,
  AutoTopUpJobRunner,
  AutoTopUpMarkedStamp,
  AutoTopUpTickContext,
} from './autoTopUpJobs.js';
import {
  readStamp,
  stampNameOf,
  walletGroupsOf,
  type AutoTopUpStampReading,
  type ReadyStamp,
} from './autoTopUpReadings.js';
import { shortBatchId, topUpFailedWarningText } from './autoTopUpTexts.js';
import type { FundingStampService } from './FundingStampService.js';
import type { StampAutoTopUpStore } from './StampAutoTopUpStore.js';

const logger = Logger.getInstance();

/** What the stamp job uses of the store: the stamps the system topped up, and the warning of a failed top-up. */
export type AutoTopUpStampJobStore = Pick<StampAutoTopUpStore, 'lastSystemTopUps' | 'raiseWarning' | 'clearWarning'>;

export interface AutoTopUpStampJobDeps {
  /** The stamp operation of the Stamps tab, and its items as they stand: the job calls the service the route calls. */
  stamps: Pick<FundingStampService, 'request' | 'bulk'>;
  store: AutoTopUpStampJobStore;
}

/** What the stamp job works out from one reading, before it asks for anything. */
export interface AutoTopUpStampRun {
  /** The top-ups to ask for, in one stamp operation, each wallet's least time left first. */
  items: StampTopUpItemRequest[];
  /** The due stamps whose node is short: they wait for the wallet job's send. */
  short: string[];
  /** The due stamps the system topped up within the last day: left, since a stamp due twice in a day is a failure. */
  twice: string[];
  /** The stamps whose node or batch could not be read, or whose node's view of the chain is behind, with why. */
  unread: { batchId: string; reason: string }[];
  /** The stamps that ran out, or that their node holds no more: none takes a top-up. */
  lost: { batchId: string; state: 'expired' | 'gone' }[];
  /** The stamps no funded node holds, and whether each is due: the admin tops none of them up. */
  unfunded: { batchId: string; due: boolean }[];
}

/** The top-up a ready, due stamp is asked for: the whole days to the level, at the tick's price. */
function topUpOf(stamp: ReadyStamp, postage: FundingPostage): StampTopUpItemRequest {
  return {
    kind: 'topup',
    nodeId: stamp.node.nodeId,
    batchId: stamp.batch.batchId.toLowerCase(),
    expectedDepth: stamp.batch.depth,
    days: stamp.plan.days,
    pricePerChunkPerBlockPlur: postage.pricePerChunkPerBlockPlur,
  };
}

/**
 * The top-ups of one run (docs/architecture/funding.md, "The three jobs" and the stamp job's table): each wallet's due
 * stamps that it covers now, the xBZZ of the top-up and the xDAI of its gas after the ones before it, the least time
 * left first (`autoTopUpWalletPlan`). A stamp the system topped up within the last day is left. `recent` holds those
 * stamps' ids, in lower case.
 */
export function planStampTopUps(
  readings: readonly AutoTopUpStampReading[],
  recent: ReadonlySet<string>,
  postage: FundingPostage,
): AutoTopUpStampRun {
  const run: AutoTopUpStampRun = { items: [], short: [], twice: [], unread: [], lost: [], unfunded: [] };
  const due: ReadyStamp[] = [];
  for (const reading of readings) {
    const batchId = reading.stamp.mark.batchId.toLowerCase();
    if (reading.state === 'unread') run.unread.push({ batchId, reason: reading.reason });
    else if (reading.state === 'expired' || reading.state === 'gone') run.lost.push({ batchId, state: reading.state });
    else if (reading.state === 'unfunded') run.unfunded.push({ batchId, due: reading.due });
    else if (reading.state === 'ready' && reading.plan.phase === 'due') {
      if (recent.has(batchId)) run.twice.push(batchId);
      else due.push(reading);
    }
  }
  for (const group of walletGroupsOf(due)) {
    for (const [index, item] of group.plan.items.entries()) {
      if (item.covered) run.items.push(topUpOf(group.stamps[index]!, postage));
      else run.short.push(item.batchId);
    }
  }
  return run;
}

/** What a run leaves for later, or for a person, in sentences. */
function notesOf(run: AutoTopUpStampRun): string[] {
  const listed = (ids: readonly string[]) => ids.map(shortBatchId).join(', ');
  return [
    ...(run.short.length > 0
      ? [`Waiting for the wallet job's send, since their node is short: ${listed(run.short)}.`]
      : []),
    ...(run.twice.length > 0
      ? [
          `Due again within a day of their last automatic top-up, so left: ${listed(run.twice)}. The price or a reading is far off.`,
        ]
      : []),
    ...run.unread.map(({ batchId, reason }) => `Not topped up this run, ${shortBatchId(batchId)}: ${reason}`),
    ...run.lost.map(
      ({ batchId, state }) =>
        `${shortBatchId(batchId)} cannot be topped up: ${
          state === 'expired'
            ? 'it expired, and takes a Buy new.'
            : 'its node holds it no more, and it takes a Buy new.'
        }`,
    ),
    ...run.unfunded.map(
      ({ batchId }) =>
        `${shortBatchId(batchId)} cannot be topped up: it is held by a node that is the catalogue node no longer, whose wallet the admin does not fund.`,
    ),
  ];
}

/** What a person can do about a top-up the stamp job could not make. */
const BY_HAND = 'Check it on the Stamps tab, and top it up by hand there if it needs it.';

/**
 * The stamp job of stamp auto top-up (docs/architecture/funding.md, "The three jobs"): it asks, as the system
 * (`STAMP_AUTO_TOPUP`), for one stamp operation with the top-up of every due marked stamp whose node covers it now,
 * through the stamp operation of the Stamps tab. It never sends from the brand wallet: a short node's stamps wait for
 * the wallet job's send.
 *
 * It goes by a current view of the chain only (`readStamp`): a stamp whose node or batch could not be read, or whose
 * node's view is behind or not known, is left for the run; the alert job keeps since when. A stamp operation open on
 * the page (`FundingBusyError`) and a price of postage that rose since the tick read it leave the run with nothing
 * asked, and the next run quotes again.
 *
 * It raises the warning of a failed top-up (`topup_failed`) for what it sees: a stamp due again within a day of its
 * last automatic top-up, a due stamp no funded node holds, and a stamp operation refused when asked for or failed
 * after. It follows up the operations it asked for at its next run, and clears the warning of a stamp once its top-up
 * is confirmed.
 */
export class AutoTopUpStampJob implements AutoTopUpJobRunner {
  readonly job = 'stamp' as const;
  /** The stamp operations this process asked for whose items have not all ended, which the next run follows up. */
  private pending: string[] = [];

  constructor(private readonly deps: AutoTopUpStampJobDeps) {}

  async run(context: AutoTopUpTickContext): Promise<AutoTopUpJobResult> {
    const { settings, funding, now } = context;
    const followed = await this.followUp(context);

    const readings = context.stamps.map((stamp) => readStamp(stamp, settings, funding.postage));
    const due = readings.filter(
      (reading): reading is ReadyStamp => reading.state === 'ready' && reading.plan.phase === 'due',
    );
    const since = now.getTime() - AUTO_TOPUP_ONCE_PER_SECONDS * 1000;
    const topUps =
      due.length > 0
        ? await this.deps.store.lastSystemTopUps(due.map((stamp) => stamp.batch.batchId.toLowerCase()))
        : [];
    const recent = new Set(
      topUps.filter((topUp) => topUp.at.getTime() > since).map((topUp) => topUp.batchId.toLowerCase()),
    );
    const run = planStampTopUps(readings, recent, funding.postage);
    const byBatch = new Map(context.stamps.map((stamp) => [stamp.mark.batchId.toLowerCase(), stamp]));
    for (const batchId of run.twice) {
      await this.raise(
        context,
        byBatch.get(batchId),
        'It was due again within a day of its last automatic top-up, so it was left: the price of postage or a reading is far off.',
      );
    }
    for (const { batchId } of run.unfunded.filter((unfunded) => unfunded.due)) {
      await this.raise(
        context,
        byBatch.get(batchId),
        "The node that holds it is the catalogue node no longer, and the admin does not fund that node's wallet, so it does not top it up.",
        'Top it up from that node outside the admin, or take its mark off.',
      );
    }

    const notes = [...followed.notes, ...notesOf(run)];
    const ok = followed.ok && run.twice.length === 0 && run.unfunded.every((unfunded) => !unfunded.due);
    if (run.items.length === 0) {
      const nothing = due.length === 0 ? 'No marked stamp is due, so nothing was topped up.' : 'Nothing was topped up.';
      return { ok, outcome: [nothing, ...notes].join(' ') };
    }

    try {
      const answer = await this.deps.stamps.request(STAMP_AUTO_TOPUP, run.items);
      this.pending.push(answer.bulkId);
    } catch (error) {
      if (error instanceof FundingBusyError) {
        return {
          ok,
          outcome: [
            'A stamp operation is still under way, so nothing was asked for. The next run tries again.',
            ...notes,
          ].join(' '),
        };
      }
      if (error instanceof FundingRefusedError && error.problem === 'price') {
        return {
          ok,
          outcome: [`Nothing was topped up: ${error.message} The next run quotes again.`, ...notes].join(' '),
        };
      }
      for (const item of run.items) {
        await this.raise(
          context,
          byBatch.get(item.batchId),
          `The stamp operation was refused: ${getErrorMessage(error)}`,
        );
      }
      return { ok: false, outcome: [`Nothing was topped up: ${getErrorMessage(error)}`, ...notes].join(' ') };
    }
    const asked = run.items.map((item) => {
      const stamp = due.find((reading) => reading.batch.batchId.toLowerCase() === item.batchId)!;
      return `${shortBatchId(item.batchId)} by ${item.days} day${item.days === 1 ? '' : 's'} for ${formatBaseUnits(stamp.plan.costPlur, XBZZ_DECIMALS)} xBZZ`;
    });
    return { ok, outcome: [`Asked to top up ${asked.join('; ')}.`, ...notes].join(' ') };
  }

  /**
   * The operations asked for earlier, as they stand now: a failed item raises its stamp's warning, a confirmed one
   * clears it, and an operation whose items have all ended is not followed up again.
   */
  private async followUp(context: AutoTopUpTickContext): Promise<{ ok: boolean; notes: string[] }> {
    const byBatch = new Map(context.stamps.map((stamp) => [stamp.mark.batchId.toLowerCase(), stamp]));
    const still: string[] = [];
    const notes: string[] = [];
    let ok = true;
    for (const bulkId of this.pending) {
      let items: FundingStampItem[];
      try {
        items = (await this.deps.stamps.bulk(bulkId)).items;
      } catch (error) {
        logger.warn(`[AutoTopUp] could not follow up stamp operation ${bulkId}: ${getErrorMessage(error)}`);
        continue;
      }
      for (const item of items) {
        const batchId = item.batchId.toLowerCase();
        if (item.state === 'confirmed') {
          await this.deps.store.clearWarning({ kind: 'topup_failed', batchId });
        } else if (item.state === 'failed') {
          ok = false;
          const reason = `The top-up the stamp job asked for failed: ${item.error ?? 'no reason was given.'}`;
          notes.push(`${shortBatchId(batchId)}: ${reason}`);
          await this.raise(context, byBatch.get(batchId), reason);
        }
      }
      if (items.some((item) => item.state !== 'confirmed' && item.state !== 'failed')) still.push(bulkId);
    }
    this.pending = still;
    return { ok, notes };
  }

  /** Raises, or words anew, the warning that a marked stamp could not be topped up. A stamp unmarked meanwhile has none. */
  private async raise(
    context: AutoTopUpTickContext,
    stamp: AutoTopUpMarkedStamp | undefined,
    reason: string,
    action = BY_HAND,
  ): Promise<void> {
    if (!stamp) return;
    const message = topUpFailedWarningText({
      stamp: stampNameOf(context, stamp),
      ttlSeconds: stamp.batch?.ttlSeconds ?? null,
      reason,
      action,
    });
    await this.deps.store.raiseWarning({ kind: 'topup_failed', batchId: stamp.mark.batchId }, message, context.now);
  }
}
