import {
  AUTO_TOPUP_ONCE_PER_SECONDS,
  AUTO_TOPUP_UNREAD_FAILS_AFTER_SECONDS,
  autoTopUpDailyCeilingPlur,
  autoTopUpMonthlyEstimatePlur,
  autoTopUpSendTiming,
  autoTopUpWithinAlert,
  formatBaseUnits,
  NODE_GAS_FUND_WEI,
  XBZZ_DECIMALS,
  XDAI_DECIMALS,
  type AutoTopUpSettings,
  type FundingTransferItemRequest,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { STAMP_AUTO_TOPUP } from '../actor.js';
import { FundingBusyError } from '../errors/index.js';

import type {
  AutoTopUpFunding,
  AutoTopUpJobResult,
  AutoTopUpJobRunner,
  AutoTopUpTickContext,
} from './autoTopUpJobs.js';
import {
  dueForSeconds,
  estimateDepthsOf,
  readStamp,
  stampNameOf,
  walletGroupsOf,
  type ReadyStamp,
} from './autoTopUpReadings.js';
import { topUpFailedWarningText } from './autoTopUpTexts.js';
import { nodeName, type FundingService } from './FundingService.js';
import type { StampAutoTopUpStore } from './StampAutoTopUpStore.js';

/**
 * What the wallet job uses of the store: what it sent in the last day, the stamps it topped up in it, and the warning
 * of a top-up it cannot send for.
 */
export type AutoTopUpWalletJobStore = Pick<
  StampAutoTopUpStore,
  'systemSendsSince' | 'lastSystemTopUps' | 'raiseWarning'
>;

export interface AutoTopUpWalletJobDeps {
  /** The send of the Balance tab, behind no password: the job calls the service the route calls. */
  funding: Pick<FundingService, 'send'>;
  store: AutoTopUpWalletJobStore;
}

/** What one node is sent: the xBZZ its due top-ups lack and the gas, for the stamps named. */
export interface AutoTopUpNodeSend {
  nodeId: string;
  nodeLabel: string;
  /** PLUR as a decimal string, `0` when only gas is sent. */
  xbzzPlur: string;
  /** Whether it is sent `NODE_GAS_FUND_WEI`. */
  gas: boolean;
  /** The least time a stamp it is sent for has left, which orders the sends. */
  ttlSeconds: number;
  /** Whether a stamp it is sent for goes at the floor, under two look-aheads left, without the day's notice. */
  floor: boolean;
  batchIds: string[];
}

/**
 * Why a node a send was worked out for gets nothing in a run: no operator confirmed its wallet; it answers another
 * wallet than the one confirmed; the send would pass the daily ceiling; the brand wallet cannot cover it in full; or
 * the admin holds no brand wallet key. The ceiling and the brand wallet hold back the node and every node after it.
 */
export type AutoTopUpSendHold = 'unconfirmed' | 'changed' | 'ceiling' | 'brand_wallet' | 'no_brand_wallet';

/** What the wallet job works out from one reading, before it sends. */
export interface AutoTopUpWalletRun {
  /** The sends to make, the node with the least time left first. */
  sends: AutoTopUpNodeSend[];
  /** The sends worked out and held back, with why. */
  held: { send: AutoTopUpNodeSend; hold: AutoTopUpSendHold }[];
  /**
   * Due top-ups whose node is short and nothing is sent for: its alert is not a look-ahead old yet (`notice`), or the
   * top-up lacks more than its alert said and waits for a new one (`alert`). Every less urgent top-up of the wallet
   * waits with it, since the stamp job tops a wallet's stamps up the least time left first.
   */
  waiting: { batchId: string; why: 'notice' | 'alert' }[];
  /** The nodes that need gas and were sent some within the last day, so none goes now, with the stamps it was for. */
  gasToday: { nodeId: string; batchIds: string[] }[];
}

export interface AutoTopUpWalletInput {
  /** The ready, due stamps the system did not top up within the last day. */
  due: readonly ReadyStamp[];
  settings: AutoTopUpSettings;
  /** The moment of the tick, in ms. */
  now: number;
  funding: AutoTopUpFunding;
  /** The daily ceiling in force, PLUR. */
  ceilingPlur: string;
  /** What the system sent in xBZZ within the last day, PLUR. */
  sentTodayPlur: string;
  /** The nodes the system sent xDAI to within the last day. */
  gasNodeIds: readonly string[];
}

/**
 * The sends of one run (docs/architecture/funding.md, "From alert to top-up", and the wallet job's limits in "Safety
 * rules"). For each wallet, over its due top-ups the least time left first (`autoTopUpWalletPlan`), every top-up it
 * does not cover is sent for in turn: what it lacks for the cost plus the margin, while its notice allows a send
 * (`autoTopUpSendTiming`: `go`, or `floor` under two look-aheads left) and, at `go`, while that is within what its
 * alert said (`autoTopUpWithinAlert`). The first that may not be sent for stops the wallet's sends there. Gas,
 * `NODE_GAS_FUND_WEI`, goes with them when the wallet lacks it, its alert said so or a top-up goes at the floor, and no
 * gas went to the node within the last day. A wallet's send goes to the node of its most urgent top-up, which must
 * answer the wallet an operator confirmed. Then the sends are taken the least time left first, each in full within the
 * daily ceiling and what the brand wallet holds, fees counted as the send counts them; the first that does not fit
 * holds back itself and every send after it.
 */
export function planWalletSends(input: AutoTopUpWalletInput): AutoTopUpWalletRun {
  const { settings, now, funding } = input;
  const run: AutoTopUpWalletRun = { sends: [], held: [], waiting: [], gasToday: [] };
  const worked: AutoTopUpNodeSend[] = [];
  for (const group of walletGroupsOf(input.due)) {
    let xbzz = 0n;
    let gas = false;
    let floor = false;
    let ttlSeconds = Number.POSITIVE_INFINITY;
    let target: ReadyStamp | null = null;
    const batchIds: string[] = [];
    for (const [index, item] of group.plan.items.entries()) {
      if (item.covered) continue;
      const stamp = group.stamps[index]!;
      const alert = stamp.stamp.mark.alert;
      const timing = autoTopUpSendTiming(
        { alertedAt: alert?.alertedAt?.getTime() ?? null, ttlSeconds: stamp.batch.ttlSeconds },
        settings,
        now,
      );
      if (timing === 'wait') {
        run.waiting.push({ batchId: item.batchId, why: 'notice' });
        break;
      }
      if (
        timing === 'go' &&
        BigInt(item.lackPlur) > 0n &&
        !autoTopUpWithinAlert(item.lackPlur, alert?.sendPlur ?? null)
      ) {
        run.waiting.push({ batchId: item.batchId, why: 'alert' });
        break;
      }
      xbzz += BigInt(item.lackPlur);
      if (group.plan.lacksGas && (timing === 'floor' || alert?.gasSend === true)) gas = true;
      floor ||= timing === 'floor';
      ttlSeconds = Math.min(ttlSeconds, stamp.batch.ttlSeconds);
      target ??= stamp;
      batchIds.push(item.batchId);
    }
    if (!target) continue;
    if (gas && input.gasNodeIds.includes(target.node.nodeId)) {
      gas = false;
      run.gasToday.push({ nodeId: target.node.nodeId, batchIds: [...batchIds] });
    }
    if (xbzz === 0n && !gas) continue;
    const send: AutoTopUpNodeSend = {
      nodeId: target.node.nodeId,
      nodeLabel: target.node.label,
      xbzzPlur: xbzz.toString(),
      gas,
      ttlSeconds,
      floor,
      batchIds,
    };
    const pinned = funding.pins.get(target.node.nodeId);
    if (pinned === undefined) run.held.push({ send, hold: 'unconfirmed' });
    else if (pinned !== target.node.walletAddress.toLowerCase()) run.held.push({ send, hold: 'changed' });
    else worked.push(send);
  }

  worked.sort((a, b) => a.ttlSeconds - b.ttlSeconds || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  const brand = funding.brandWallet;
  if (!brand) {
    run.held.push(...worked.map((send) => ({ send, hold: 'no_brand_wallet' as const })));
    return run;
  }
  const fee = BigInt(brand.maxFeePerGasWei);
  let ceilingLeft = BigInt(input.ceilingPlur) - BigInt(input.sentTodayPlur);
  let xbzzLeft = BigInt(brand.xbzzPlur);
  let xdaiLeft = BigInt(brand.xdaiWei);
  let stopped: AutoTopUpSendHold | null = null;
  for (const send of worked) {
    const xbzz = BigInt(send.xbzzPlur);
    const xdai =
      (xbzz > 0n ? BigInt(brand.gasBzzTransfer) * fee : 0n) +
      (send.gas ? BigInt(NODE_GAS_FUND_WEI) + BigInt(brand.gasNative) * fee : 0n);
    if (!stopped && xbzz > ceilingLeft) stopped = 'ceiling';
    if (!stopped && (xbzz > xbzzLeft || xdai > xdaiLeft)) stopped = 'brand_wallet';
    if (stopped) {
      run.held.push({ send, hold: stopped });
      continue;
    }
    ceilingLeft -= xbzz;
    xbzzLeft -= xbzz;
    xdaiLeft -= xdai;
    run.sends.push(send);
  }
  return run;
}

/** The transfers of the sends: xBZZ for what each node lacks, and xDAI for its gas. */
export function transfersOf(sends: readonly AutoTopUpNodeSend[]): FundingTransferItemRequest[] {
  return sends.flatMap((send) => [
    ...(BigInt(send.xbzzPlur) > 0n ? [{ nodeId: send.nodeId, kind: 'xbzz' as const, amount: send.xbzzPlur }] : []),
    ...(send.gas ? [{ nodeId: send.nodeId, kind: 'xdai' as const, amount: NODE_GAS_FUND_WEI }] : []),
  ]);
}

function xbzzText(plur: string | bigint): string {
  return `${formatBaseUnits(plur.toString(), XBZZ_DECIMALS)} xBZZ`;
}

function xdaiText(wei: string | bigint): string {
  return `${formatBaseUnits(wei.toString(), XDAI_DECIMALS)} xDAI`;
}

function nameOf(send: AutoTopUpNodeSend): string {
  return nodeName({ label: send.nodeLabel, nodeId: send.nodeId });
}

/** What a send gives a node, in words. */
function sendText(send: AutoTopUpNodeSend): string {
  const parts = [
    ...(BigInt(send.xbzzPlur) > 0n ? [xbzzText(send.xbzzPlur)] : []),
    ...(send.gas ? [`${xdaiText(NODE_GAS_FUND_WEI)} for its gas`] : []),
  ];
  const floor = send.floor ? ', without the day of notice, since a stamp of it has under two look-aheads left' : '';
  return `${parts.join(' and ')} to ${nameOf(send)}${floor}`;
}

/** Why a node got nothing, in a sentence. */
function holdText(
  { send, hold }: { send: AutoTopUpNodeSend; hold: AutoTopUpSendHold },
  input: Pick<AutoTopUpWalletInput, 'ceilingPlur' | 'sentTodayPlur'>,
): string {
  const who = nameOf(send);
  switch (hold) {
    case 'unconfirmed':
      return `Nothing was sent to ${who}: no operator has confirmed its wallet. Confirm it on the Balance tab.`;
    case 'changed':
      return `Nothing was sent to ${who}: it answers another wallet than the one an operator confirmed. Check it, and confirm it again on the Balance tab.`;
    case 'ceiling':
      return `Nothing was sent to ${who}: its ${xbzzText(send.xbzzPlur)} would pass the daily ceiling of ${xbzzText(input.ceilingPlur)}, of which ${xbzzText(input.sentTodayPlur)} went in the last 24 hours.`;
    case 'brand_wallet':
      return `Nothing was sent to ${who}: the brand wallet cannot cover its ${xbzzText(send.xbzzPlur)}${send.gas ? ` and ${xdaiText(NODE_GAS_FUND_WEI)}` : ''} in full, fees counted.`;
    case 'no_brand_wallet':
      return `Nothing was sent to ${who}: there is no brand wallet to send from, since BRAND_WALLET_SECRET is unset.`;
  }
}

/** The short nodes nothing is sent to yet, and why, in sentences. */
function waitingText(plan: AutoTopUpWalletRun): string[] {
  const notice = plan.waiting.filter((wait) => wait.why === 'notice').length;
  const alert = plan.waiting.filter((wait) => wait.why === 'alert').length;
  return [
    ...(notice > 0 ? [`Short nodes waiting for their top-up's alert to be a look-ahead old: ${notice}.`] : []),
    ...(alert > 0
      ? [`Short nodes that lack more than their top-up's alert said, waiting for a new alert: ${alert}.`]
      : []),
  ];
}

/**
 * The wallet job of stamp auto top-up (docs/architecture/funding.md, "The three jobs"): it sends a short node from
 * the brand wallet what its due top-ups lack, with no password, through the send of the Balance tab, as the system
 * (`STAMP_AUTO_TOPUP`). It works over the marked stamps that are ready and due (`readStamp`), and leaves a stamp the
 * system topped up within the last day, which the stamp job leaves too. What it sends is `planWalletSends`'s. A send
 * another send holds up (`FundingBusyError`) sends nothing in that run, and the next run works it out again.
 *
 * A due top-up it cannot send for, once its stamp has been due for an hour, raises the warning of a failed top-up
 * (`topup_failed`): the daily ceiling, the brand wallet's balance, an address not confirmed or changed, no brand
 * wallet, gas already sent within the day, an earlier send not settled, or a send refused or failed. Waiting for the
 * notice or for a new alert is no failure. The stamp job and the alert job clear the warning.
 */
export class AutoTopUpWalletJob implements AutoTopUpJobRunner {
  readonly job = 'wallet' as const;

  constructor(private readonly deps: AutoTopUpWalletJobDeps) {}

  async run(context: AutoTopUpTickContext): Promise<AutoTopUpJobResult> {
    const { settings, funding } = context;
    const now = context.now.getTime();
    const ready = context.stamps
      .map((stamp) => readStamp(stamp, settings, funding.postage))
      .filter((reading): reading is ReadyStamp => reading.state === 'ready' && reading.plan.phase === 'due');
    if (ready.length === 0) return { ok: true, outcome: 'No marked stamp is due, so nothing was sent.' };

    const since = new Date(now - AUTO_TOPUP_ONCE_PER_SECONDS * 1000);
    const [sent, topUps] = await Promise.all([
      this.deps.store.systemSendsSince(since),
      this.deps.store.lastSystemTopUps(ready.map((stamp) => stamp.batch.batchId.toLowerCase())),
    ]);
    const recent = new Set(
      topUps.filter((topUp) => topUp.at.getTime() > since.getTime()).map((topUp) => topUp.batchId.toLowerCase()),
    );
    const due = ready.filter((stamp) => !recent.has(stamp.batch.batchId.toLowerCase()));
    if (due.length === 0) {
      return {
        ok: true,
        outcome: 'Every due marked stamp was topped up within the last day, so nothing was sent for it again.',
      };
    }
    const input: AutoTopUpWalletInput = {
      due,
      settings,
      now,
      funding,
      ceilingPlur: autoTopUpDailyCeilingPlur(
        settings,
        autoTopUpMonthlyEstimatePlur(estimateDepthsOf(context.stamps), funding.postage),
      ),
      sentTodayPlur: sent.xbzzPlur,
      gasNodeIds: sent.gasNodeIds,
    };
    const plan = planWalletSends(input);
    const notes = [
      ...plan.held.map((held) => holdText(held, input)),
      ...plan.gasToday.map(({ nodeId }) => `${nodeId} was sent gas within the last day, so no more went to it.`),
      ...waitingText(plan),
    ];
    const failures: AutoTopUpSendFailure[] = [
      ...plan.held.map((held) => ({ batchIds: held.send.batchIds, ...holdFailure(held, input) })),
      ...plan.gasToday.map(({ nodeId, batchIds }) => ({
        batchIds,
        reason: `Its node, ${nodeId}, lacks the xDAI its top-ups' gas needs, and it was sent gas within the last day already.`,
        action: 'Fund the node with xDAI by hand on the Balance tab.',
      })),
    ];
    const ok = plan.held.length === 0;
    if (plan.sends.length === 0) {
      await this.raise(context, due, failures);
      const nothing =
        notes.length === 0 ? ["Every due stamp's node holds what its top-up costs, so nothing was sent."] : [];
      return { ok, outcome: [...nothing, ...notes].join(' ') };
    }

    let answer: Awaited<ReturnType<FundingService['send']>>;
    try {
      answer = await this.deps.funding.send(STAMP_AUTO_TOPUP, transfersOf(plan.sends));
    } catch (error) {
      const busy = error instanceof FundingBusyError;
      failures.push(
        ...plan.sends.map((send) => ({
          batchIds: send.batchIds,
          reason: busy
            ? `Its node, ${nameOf(send)}, is short, and an earlier send from the brand wallet is not settled yet, so nothing could be sent to it.`
            : `Its node, ${nameOf(send)}, is short, and the send to it was refused: ${getErrorMessage(error)}`,
          action: busy
            ? 'Look at the open send on the Balance tab. The next run tries again.'
            : 'Look at the Balance tab, and fund the node by hand there if it needs it.',
        })),
      );
      await this.raise(context, due, failures);
      if (busy) {
        return {
          ok,
          outcome: [
            'An earlier send from the brand wallet is not settled yet, so nothing was sent. The next run tries again.',
            ...notes,
          ].join(' '),
        };
      }
      return { ok: false, outcome: [`Nothing was sent: ${getErrorMessage(error)}`, ...notes].join(' ') };
    }
    const failed = answer.items.filter((item) => item.state === 'failed');
    for (const item of failed) {
      const send = plan.sends.find((candidate) => candidate.nodeId === item.nodeId);
      if (!send) continue;
      failures.push({
        batchIds: send.batchIds,
        reason: `Its node, ${nameOf(send)}, is short, and the transfer to it failed: ${item.error ?? 'no reason was given.'}`,
        action: 'Look at the Balance tab, and fund the node by hand there if it needs it.',
      });
    }
    await this.raise(context, due, failures);
    const failedText = failed.map(
      (item) =>
        `The ${item.kind === 'xbzz' ? 'xBZZ' : 'xDAI'} transfer to ${item.nodeId} failed: ${item.error ?? 'no reason was given.'}`,
    );
    return {
      ok: ok && failed.length === 0,
      outcome: [`Sent ${plan.sends.map(sendText).join('; ')}.`, ...failedText, ...notes].join(' '),
    };
  }

  /**
   * Raises, or words anew, the warning that a due stamp could not be topped up, for each stamp of `failures` that has
   * been due for an hour or more (`dueForSeconds`), as its time left says.
   */
  private async raise(
    context: AutoTopUpTickContext,
    due: readonly ReadyStamp[],
    failures: readonly AutoTopUpSendFailure[],
  ): Promise<void> {
    const byBatch = new Map(due.map((stamp) => [stamp.batch.batchId.toLowerCase(), stamp]));
    for (const failure of failures) {
      for (const batchId of failure.batchIds) {
        const stamp = byBatch.get(batchId);
        if (!stamp) continue;
        if (dueForSeconds(stamp.batch.ttlSeconds, context.settings) < AUTO_TOPUP_UNREAD_FAILS_AFTER_SECONDS) continue;
        const message = topUpFailedWarningText({
          stamp: stampNameOf(context, stamp.stamp),
          ttlSeconds: stamp.batch.ttlSeconds,
          reason: failure.reason,
          action: failure.action,
        });
        await this.deps.store.raiseWarning(
          { kind: 'topup_failed', batchId: stamp.stamp.mark.batchId },
          message,
          context.now,
        );
      }
    }
  }
}

/** Due top-ups the wallet job cannot send for, why, and what a person can do, for the warning of each. */
interface AutoTopUpSendFailure {
  batchIds: readonly string[];
  reason: string;
  action: string;
}

/** Why a held send's top-ups cannot be paid for, and what a person can do, for their warnings. */
function holdFailure(
  { send, hold }: { send: AutoTopUpNodeSend; hold: AutoTopUpSendHold },
  input: Pick<AutoTopUpWalletInput, 'ceilingPlur' | 'sentTodayPlur' | 'funding'>,
): { reason: string; action: string } {
  const who = `Its node, ${nameOf(send)}, is short`;
  switch (hold) {
    case 'unconfirmed':
      return {
        reason: `${who}, and no operator has confirmed the node's wallet, so the brand wallet sends it nothing.`,
        action: "Confirm the node's wallet on the Balance tab.",
      };
    case 'changed':
      return {
        reason: `${who}, and it answers another wallet than the one an operator confirmed, so the brand wallet sends it nothing.`,
        action: 'Check the node, and confirm its wallet again on the Balance tab.',
      };
    case 'ceiling':
      return {
        reason: `${who}, and the ${xbzzText(send.xbzzPlur)} it lacks would pass the daily ceiling of ${xbzzText(input.ceilingPlur)}, of which ${xbzzText(input.sentTodayPlur)} went in the last 24 hours.`,
        action: 'Fund the node by hand on the Balance tab, or raise the daily ceiling on the Auto top-up tab.',
      };
    case 'brand_wallet':
      return {
        reason: `${who}, and the brand wallet cannot cover the ${xbzzText(send.xbzzPlur)} it lacks in full, fees counted.`,
        action: `Send xBZZ and xDAI to the brand wallet${input.funding.brandWallet ? `, ${input.funding.brandWallet.address},` : ''} on Gnosis Chain.`,
      };
    case 'no_brand_wallet':
      return {
        reason: `${who}, and there is no brand wallet to send from, since BRAND_WALLET_SECRET is unset.`,
        action: 'Fund the node by hand, or give the admin its brand wallet.',
      };
  }
}
