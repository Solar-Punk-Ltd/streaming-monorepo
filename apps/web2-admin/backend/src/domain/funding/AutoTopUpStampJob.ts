import {
  AUTO_TOPUP_ONCE_PER_SECONDS,
  formatBaseUnits,
  XBZZ_DECIMALS,
  type FundingPostage,
  type StampTopUpItemRequest,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { STAMP_AUTO_TOPUP } from '../actor.js';
import { FundingBusyError, FundingRefusedError } from '../errors/index.js';

import type { AutoTopUpJobResult, AutoTopUpJobRunner, AutoTopUpTickContext } from './autoTopUpJobs.js';
import { readStamp, walletGroupsOf, type AutoTopUpStampReading, type ReadyStamp } from './autoTopUpReadings.js';
import type { FundingStampService } from './FundingStampService.js';
import type { StampAutoTopUpStore } from './StampAutoTopUpStore.js';

/** What the stamp job uses of the store: a stamp's unread mark, and the stamps the system topped up. */
export type AutoTopUpStampJobStore = Pick<StampAutoTopUpStore, 'setUnreadSince' | 'lastSystemTopUps'>;

export interface AutoTopUpStampJobDeps {
  /** The stamp operation of the Stamps tab: the job calls the service the route calls. */
  stamps: Pick<FundingStampService, 'request'>;
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
  /** The stamps that ran out, that their node holds no more, or that no funded node holds: none takes a top-up. */
  lost: { batchId: string; state: 'expired' | 'gone' | 'unfunded' }[];
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
  const run: AutoTopUpStampRun = { items: [], short: [], twice: [], unread: [], lost: [] };
  const due: ReadyStamp[] = [];
  for (const reading of readings) {
    const batchId = reading.stamp.mark.batchId.toLowerCase();
    if (reading.state === 'unread') run.unread.push({ batchId, reason: reading.reason });
    else if (reading.state === 'expired' || reading.state === 'gone' || reading.state === 'unfunded') {
      run.lost.push({ batchId, state: reading.state });
    } else if (reading.state === 'ready' && reading.plan.phase === 'due') {
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

function shortBatch(batchId: string): string {
  return `${batchId.slice(0, 10)}…`;
}

/** What a run leaves for later, or for a person, in sentences. */
function notesOf(run: AutoTopUpStampRun): string[] {
  const listed = (ids: readonly string[]) => ids.map(shortBatch).join(', ');
  return [
    ...(run.short.length > 0
      ? [`Waiting for the wallet job's send, since their node is short: ${listed(run.short)}.`]
      : []),
    ...(run.twice.length > 0
      ? [
          `Due again within a day of their last automatic top-up, so left: ${listed(run.twice)}. The price or a reading is far off.`,
        ]
      : []),
    ...run.unread.map(({ batchId, reason }) => `Not topped up this run, ${shortBatch(batchId)}: ${reason}`),
    ...run.lost.map(
      ({ batchId, state }) =>
        `${shortBatch(batchId)} cannot be topped up: ${
          state === 'expired'
            ? 'it expired, and takes a Buy new.'
            : state === 'gone'
              ? 'its node holds it no more, and it takes a Buy new.'
              : 'it is held by a node that is the catalogue node no longer, whose wallet the admin does not fund.'
        }`,
    ),
  ];
}

/**
 * The stamp job of stamp auto top-up (docs/architecture/funding.md, "The three jobs"): it asks, as the system
 * (`STAMP_AUTO_TOPUP`), for one stamp operation with the top-up of every due marked stamp whose node covers it now,
 * through the stamp operation of the Stamps tab. It never sends from the brand wallet: a short node's stamps wait for
 * the wallet job's send.
 *
 * It goes by a current view of the chain only (`readStamp`): a stamp whose node or batch could not be read, or whose
 * node's view is behind or not known, is left for the run, and the mark keeps since when (`setUnreadSince`), which is
 * cleared once it reads well again. A stamp operation open on the page (`FundingBusyError`) and a price of postage
 * that rose since the tick read it leave the run with nothing asked, and the next run quotes again.
 */
export class AutoTopUpStampJob implements AutoTopUpJobRunner {
  readonly job = 'stamp' as const;

  constructor(private readonly deps: AutoTopUpStampJobDeps) {}

  async run(context: AutoTopUpTickContext): Promise<AutoTopUpJobResult> {
    const { settings, funding, now } = context;
    const readings = context.stamps.map((stamp) => readStamp(stamp, settings, funding.postage));
    for (const reading of readings) {
      const { mark } = reading.stamp;
      if (reading.state === 'unread') {
        if (mark.unreadSince === null) await this.deps.store.setUnreadSince(mark.batchId, now);
      } else if (mark.unreadSince !== null) {
        await this.deps.store.setUnreadSince(mark.batchId, null);
      }
    }

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
    const notes = notesOf(run);
    const ok = run.twice.length === 0 && run.lost.every((lost) => lost.state !== 'unfunded');
    if (run.items.length === 0) {
      const nothing = due.length === 0 ? 'No marked stamp is due, so nothing was topped up.' : 'Nothing was topped up.';
      return { ok, outcome: [nothing, ...notes].join(' ') };
    }

    try {
      await this.deps.stamps.request(STAMP_AUTO_TOPUP, run.items);
    } catch (error) {
      if (error instanceof FundingBusyError) {
        return {
          ok: true,
          outcome: 'A stamp operation is still under way, so nothing was asked for. The next run tries again.',
        };
      }
      if (error instanceof FundingRefusedError && error.problem === 'price') {
        return { ok: true, outcome: `Nothing was topped up: ${error.message} The next run quotes again.` };
      }
      return { ok: false, outcome: `Nothing was topped up: ${getErrorMessage(error)}` };
    }
    const asked = run.items.map((item) => {
      const stamp = due.find((reading) => reading.batch.batchId.toLowerCase() === item.batchId)!;
      return `${shortBatch(item.batchId)} by ${item.days} day${item.days === 1 ? '' : 's'} for ${formatBaseUnits(stamp.plan.costPlur, XBZZ_DECIMALS)} xBZZ`;
    });
    return { ok, outcome: [`Asked to top up ${asked.join('; ')}.`, ...notes].join(' ') };
  }
}
