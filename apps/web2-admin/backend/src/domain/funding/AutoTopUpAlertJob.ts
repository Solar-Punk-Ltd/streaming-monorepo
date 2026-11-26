import {
  AUTO_TOPUP_ONCE_PER_SECONDS,
  AUTO_TOPUP_UNREAD_FAILS_AFTER_SECONDS,
  NODE_GAS_FUND_WEI,
  SECONDS_PER_DAY,
  autoTopUpMonthlyEstimatePlur,
  autoTopUpStampPlan,
  autoTopUpWalletPlan,
  autoTopUpWithinAlert,
  type AutoTopUpSettings,
  type AutoTopUpStampPlan,
  type AutoTopUpWalletTopUp,
  type AutoTopUpWarningKind,
  type FundingPinState,
  type FundingPostage,
  type Notice,
  type NoticeTopic,
} from '@streaming-monorepo/web2-admin-common';

import type { Logger } from '../Logger.js';
import type { Notifier, OutgoingNotice } from '../notifications/Notifier.js';

import {
  autoTopUpComingSubject,
  autoTopUpWarningSubject,
  type AutoTopUpAlert,
  type AutoTopUpMarkRow,
  type AutoTopUpNoticesRow,
  type AutoTopUpWarningKey,
  type AutoTopUpWarningRow,
  type StampAutoTopUpStore,
} from './StampAutoTopUpStore.js';
import type { UnmarkedStampPass } from './UnmarkedStampPass.js';
import {
  comingNotice,
  newWarningsNotice,
  stampExpiredWarningText,
  standingWarningsNotice,
  topUpFailedWarningText,
  walletXbzzWarningText,
  walletXdaiWarningText,
  type ComingNodeText,
  type ComingTopUpText,
  type StampName,
  type WarningNoticeItem,
} from './autoTopUpTexts.js';
import type {
  AutoTopUpJobResult,
  AutoTopUpJobRunner,
  AutoTopUpMarkedStamp,
  AutoTopUpTickContext,
} from './autoTopUpJobs.js';
import { estimateDepthsOf, stampNameOf } from './autoTopUpReadings.js';

/**
 * The alert job of stamp auto top-up (docs/architecture/funding.md, "Auto top-up"). It moves no money. Each run it
 * reads every marked stamp against the rule and:
 *
 * - records the alert of a stamp that comes within two look-aheads of the threshold: the days, the cost, the cost plus
 *   the margin and what the brand wallet sends its node, and records it anew when the node lacks more than it said;
 * - clears the alert of a stamp that is healthy again, which a top-up makes it, or that expired;
 * - sends the "top-ups coming up" notice when a stamp turns upcoming, at most once a day, listing every recorded alert
 *   not given yet, and while nobody gets that topic counts an alert as given when it is recorded;
 * - raises, words anew and clears the warnings, and sends each one's first notice at once and the daily repeats of the
 *   standing ones together, each warning as a part under its topic;
 * - tries the notices that wait for a destination again, through the `Notifier`, before it sends any new one, so a
 *   paused alert job sends and retries nothing.
 *
 * Every notice goes out through the admin's `Notifier`, to the people who get its topics. A notice no destination took
 * is sent again at the next run. It never stops a run.
 */

/** The node that holds a marked stamp and pays for its top-ups, as the funding view reads it. */
export interface AlertStampNode {
  nodeId: string;
  label: string;
  /** Null when the manager could not read it. */
  walletAddress: string | null;
  xbzzPlur: string | null;
  xdaiWei: string | null;
  /**
   * Whether the brand wallet may send to it: `pinned` while its address is the one an operator confirmed, `new` or
   * `changed` while it waits for a person, or null for a node the brand wallet never sends to.
   */
  pin: FundingPinState | null;
}

/**
 * A marked stamp as the funding view reads it now.
 *
 * - `operable`: read whole and usable, with its time left, on a node whose chain view is current.
 * - `expired`: its time ran out, or its node holds it no more.
 * - `waiting`: bought and not usable yet.
 * - `unread`: its node could not be read, or its chain view is behind; `ttlSeconds` is what the node said, if anything,
 *   and `reason` says which in a sentence.
 */
export type AlertStampReading =
  | { state: 'operable'; name: StampName; depth: number; ttlSeconds: number; node: AlertStampNode }
  | { state: 'expired'; name: StampName }
  | { state: 'waiting'; name: StampName }
  | { state: 'unread'; name: StampName; ttlSeconds: number | null; reason: string };

/** What one run of the alert job reads. */
export interface AlertJobInput {
  now: Date;
  settings: AutoTopUpSettings;
  /** The price, which the tick ends without when the manager could not give it. */
  postage: FundingPostage;
  /** The brand wallet, or null when there is none; a balance is null when it could not be read. */
  brandWallet: { address: string; xbzzPlur: string | null; xdaiWei: string | null } | null;
  /** Whether the wallet job is paused. */
  walletJobPaused: boolean;
  /** Every marked stamp, with how the funding view reads it now, by batch id. A mark with none is left as it is. */
  readings: ReadonlyMap<string, AlertStampReading>;
  /**
   * The depths the monthly estimate counts, one for each marked stamp that can be topped up (`estimateDepthsOf`), so
   * the warning counts the stamps the Auto top-up tab's estimate and the wallet job's daily ceiling count.
   */
  estimateDepths: readonly number[];
}

const DAY_MS = SECONDS_PER_DAY * 1000;
const ONCE_PER_MS = AUTO_TOPUP_ONCE_PER_SECONDS * 1000;
const FAILS_AFTER_MS = AUTO_TOPUP_UNREAD_FAILS_AFTER_SECONDS * 1000;

function msSince(at: Date | null, now: Date): number {
  return at === null ? Number.POSITIVE_INFINITY : now.getTime() - at.getTime();
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** How a run's outcome begins the note of a notice no destination took. */
const NOT_TAKEN = 'No destination took the notice';

/** The topic each kind of warning is told of under. */
const WARNING_TOPICS: Readonly<Record<AutoTopUpWarningKind, NoticeTopic>> = {
  wallet_xbzz: 'wallet_low',
  wallet_xdai: 'wallet_low',
  topup_failed: 'topup_failed',
  stamp_expired: 'stamp_expired',
};

/** The topics of the warnings, each once. */
const WARNING_NOTICE_TOPICS: readonly NoticeTopic[] = [...new Set(Object.values(WARNING_TOPICS))];

function warningId(key: AutoTopUpWarningKey): string {
  return `${key.kind}:${key.batchId ?? ''}`;
}

/** An operable marked stamp with the rule's answer for it. */
interface PlannedStamp {
  mark: AutoTopUpMarkRow;
  reading: Extract<AlertStampReading, { state: 'operable' }>;
  plan: AutoTopUpStampPlan;
}

/** What one wallet lacks for its listed top-ups, by batch id, and whether it lacks gas for them. */
interface WalletLack {
  lackByBatch: Map<string, string>;
  lacksGas: boolean;
}

/** Nodes that answer one wallet are counted together: by its address, or by the node while the address is unread. */
function walletKey(node: AlertStampNode): string {
  return node.walletAddress?.toLowerCase() ?? `node:${node.nodeId}`;
}

/**
 * Each wallet against its listed top-ups, every stamp within two look-aheads of the threshold, the least time left
 * first. An unread balance counts as none, so the alert names the most the node could need.
 */
function walletLacks(stamps: readonly PlannedStamp[]): Map<string, WalletLack> {
  const byWallet = new Map<string, PlannedStamp[]>();
  for (const stamp of stamps) {
    const key = walletKey(stamp.reading.node);
    byWallet.set(key, [...(byWallet.get(key) ?? []), stamp]);
  }
  const lacks = new Map<string, WalletLack>();
  for (const [key, walletStamps] of byWallet) {
    const node = walletStamps[0]!.reading.node;
    const topUps: AutoTopUpWalletTopUp[] = walletStamps.map((stamp) => ({
      batchId: stamp.mark.batchId,
      ttlSeconds: stamp.reading.ttlSeconds,
      costPlur: stamp.plan.costPlur,
      costWithMarginPlur: stamp.plan.costWithMarginPlur,
    }));
    const plan = autoTopUpWalletPlan({ xbzzPlur: node.xbzzPlur ?? '0', xdaiWei: node.xdaiWei ?? '0' }, topUps);
    lacks.set(key, {
      lackByBatch: new Map(plan.items.map((item) => [item.batchId, item.lackPlur])),
      lacksGas: plan.lacksGas,
    });
  }
  return lacks;
}

/**
 * How long a stamp under the threshold has been due: its time left counts down a second a second at a steady price,
 * so it crossed the threshold that long ago.
 */
function dueForMs(stamp: PlannedStamp, settings: AutoTopUpSettings): number {
  return stamp.plan.phase === 'due' ? (settings.topUpUnderDays * SECONDS_PER_DAY - stamp.reading.ttlSeconds) * 1000 : 0;
}

export class AutoTopUpAlertJob implements AutoTopUpJobRunner {
  readonly job = 'alert' as const;

  constructor(
    private readonly store: StampAutoTopUpStore,
    private readonly notifier: Notifier,
    private readonly logger: Pick<Logger, 'info' | 'warn'>,
    /** The stamps not on auto top-up, watched after the marked ones; absent in the tests that are not about them. */
    private readonly unmarked: UnmarkedStampPass | null = null,
  ) {}

  /** One run in a tick: the tick's reading of the marked stamps, and whether the wallet job is paused. */
  async run(context: AutoTopUpTickContext): Promise<AutoTopUpJobResult> {
    const walletJob = (await this.store.jobs()).find((row) => row.job === 'wallet');
    const input = alertJobInputOf(context, walletJob?.paused === true);
    const result = await this.runReadings(
      input,
      context.stamps.map((stamp) => stamp.mark),
    );
    // The stamps not on auto top-up, through the same notifier. What their pass says never fails the run.
    const unmarked = this.unmarked === null ? null : await this.unmarked.run(context, this.notifier);
    return unmarked === null ? result : { ok: result.ok, outcome: `${result.outcome} ${unmarked}` };
  }

  /** The run over readings already made, for these marks. */
  async runReadings(input: AlertJobInput, marks: readonly AutoTopUpMarkRow[]): Promise<AutoTopUpJobResult> {
    const { now, settings } = input;
    const planned: PlannedStamp[] = [];
    let unread = 0;

    for (const mark of marks) {
      const reading = input.readings.get(mark.batchId);
      if (reading === undefined) continue;
      if (reading.state === 'unread') {
        unread += 1;
        if (mark.unreadSince === null) await this.store.setUnreadSince(mark.batchId, now);
      } else if (mark.unreadSince !== null) {
        await this.store.setUnreadSince(mark.batchId, null);
      }
      if (reading.state === 'operable') {
        planned.push({ mark, reading, plan: autoTopUpStampPlan(reading, settings, input.postage) });
      }
    }

    const lacks = walletLacks(planned.filter((stamp) => stamp.plan.listed));
    const alerts = new Map(marks.map((mark) => [mark.batchId, mark.alert]));

    // The alerts.
    let recorded = 0;
    for (const stamp of planned) {
      const { mark, plan, reading } = stamp;
      if (!plan.listed) {
        if (mark.alert !== null) await this.store.setAlert(mark.batchId, null);
        alerts.set(mark.batchId, null);
        continue;
      }
      const lack = lacks.get(walletKey(reading.node))!;
      const sendPlur = lack.lackByBatch.get(mark.batchId) ?? '0';
      if (mark.alert !== null && (BigInt(sendPlur) === 0n || autoTopUpWithinAlert(sendPlur, mark.alert.sendPlur))) {
        continue;
      }
      const alert: AutoTopUpAlert = {
        days: plan.days,
        costPlur: plan.costPlur,
        costWithMarginPlur: plan.costWithMarginPlur,
        sendPlur,
        gasSend: lack.lacksGas,
        recordedAt: now,
        alertedAt: null,
      };
      await this.store.setAlert(mark.batchId, alert);
      alerts.set(mark.batchId, alert);
      recorded += 1;
    }
    for (const mark of marks) {
      if (input.readings.get(mark.batchId)?.state === 'expired' && mark.alert !== null) {
        await this.store.setAlert(mark.batchId, null);
        alerts.set(mark.batchId, null);
      }
    }

    const warnings = await this.reckonWarnings(input, marks, planned, lacks);

    // The notices. With nobody to get them, the tab alone shows the alerts and the warnings.
    const comingOn = await this.notifier.on('topups_coming');
    const warningsOn = (await Promise.all(WARNING_NOTICE_TOPICS.map((topic) => this.notifier.on(topic)))).some(
      (gets) => gets,
    );
    const on = comingOn || warningsOn;
    const noticesRow = await this.store.notices();
    const notes: string[] = [];
    const retryNote = await this.retryWaiting(now, alerts, warnings);
    if (retryNote !== null) notes.push(retryNote);
    const comingNote = await this.giveComingAlerts(input, planned, alerts, lacks, comingOn, noticesRow);
    if (comingNote !== null) notes.push(comingNote);
    const warningNote = await this.noticeWarnings(now, warnings, warningsOn, noticesRow);
    if (warningNote !== null) notes.push(warningNote);

    const coming = planned.filter((stamp) => stamp.plan.listed).length;
    const summary = [
      `${coming} of ${plural(marks.length, 'marked stamp')} ${coming === 1 ? 'has' : 'have'} a top-up coming`,
      ...(recorded > 0 ? [`${plural(recorded, 'alert')} recorded`] : []),
      ...(unread > 0 ? [`${unread} could not be read`] : []),
      `${plural(warnings.length, 'warning')} standing`,
      ...(on ? [] : ['nobody gets the notices']),
    ].join(', ');
    return {
      ok: !notes.some((note) => note.startsWith(NOT_TAKEN)),
      outcome: `${[summary, ...notes].join('. ')}.`,
    };
  }

  /**
   * Raises the warnings whose cause stands, words them anew, and clears the ones whose cause ended. A failed top-up is
   * raised here for the causes this job sees from the funding view: a stamp with a top-up coming whose node has been
   * unread for an hour, and a due stamp on a short node for an hour while the wallet job is paused. It is cleared once
   * the stamp is no longer due. Answers the warnings that stand after it.
   */
  private async reckonWarnings(
    input: AlertJobInput,
    marks: readonly AutoTopUpMarkRow[],
    planned: readonly PlannedStamp[],
    lacks: ReadonlyMap<string, WalletLack>,
  ): Promise<AutoTopUpWarningRow[]> {
    const { now, settings } = input;
    const wallet = input.brandWallet;

    // The brand wallet's xBZZ against 30 days of top-ups for the stamps that can be topped up, with no margin.
    const xbzzKey: AutoTopUpWarningKey = { kind: 'wallet_xbzz', batchId: null };
    const estimate = autoTopUpMonthlyEstimatePlur(input.estimateDepths, input.postage);
    if (wallet === null) {
      await this.store.clearWarning(xbzzKey);
    } else if (wallet.xbzzPlur !== null) {
      if (BigInt(wallet.xbzzPlur) < BigInt(estimate)) {
        const message = walletXbzzWarningText({
          balancePlur: wallet.xbzzPlur,
          monthlyEstimatePlur: estimate,
          walletAddress: wallet.address,
        });
        await this.store.raiseWarning(xbzzKey, message, now);
      } else {
        await this.store.clearWarning(xbzzKey);
      }
    }

    const xdaiKey: AutoTopUpWarningKey = { kind: 'wallet_xdai', batchId: null };
    if (wallet === null) {
      await this.store.clearWarning(xdaiKey);
    } else if (wallet.xdaiWei !== null) {
      if (BigInt(wallet.xdaiWei) < BigInt(settings.xdaiWarningWei)) {
        const message = walletXdaiWarningText({
          balanceWei: wallet.xdaiWei,
          thresholdWei: settings.xdaiWarningWei,
          walletAddress: wallet.address,
        });
        await this.store.raiseWarning(xdaiKey, message, now);
      } else {
        await this.store.clearWarning(xdaiKey);
      }
    }

    const plannedById = new Map(planned.map((stamp) => [stamp.mark.batchId, stamp]));
    for (const mark of marks) {
      const reading = input.readings.get(mark.batchId);
      if (reading === undefined) continue;
      const failedKey: AutoTopUpWarningKey = { kind: 'topup_failed', batchId: mark.batchId };
      const expiredKey: AutoTopUpWarningKey = { kind: 'stamp_expired', batchId: mark.batchId };

      if (reading.state === 'expired') {
        await this.store.clearWarning(failedKey);
        await this.store.raiseWarning(expiredKey, stampExpiredWarningText(reading.name), now);
        continue;
      }
      await this.store.clearWarning(expiredKey);

      if (reading.state === 'unread') {
        // A stamp with a top-up coming at its last reading, unread for an hour, may be running out unseen.
        const due = reading.ttlSeconds !== null && reading.ttlSeconds < settings.topUpUnderDays * SECONDS_PER_DAY;
        if ((mark.alert !== null || due) && msSince(mark.unreadSince ?? now, now) >= FAILS_AFTER_MS) {
          const message = topUpFailedWarningText({
            stamp: reading.name,
            ttlSeconds: reading.ttlSeconds,
            reason: `${reading.reason} It has been so for an hour or more.`,
            action: 'Check the node, and top the stamp up by hand on the Stamps tab once its node reads again.',
          });
          await this.store.raiseWarning(failedKey, message, now);
        }
        continue;
      }
      if (reading.state === 'waiting') continue;

      const stamp = plannedById.get(mark.batchId)!;
      if (stamp.plan.phase !== 'due') {
        await this.store.clearWarning(failedKey);
        continue;
      }
      const lack = lacks.get(walletKey(stamp.reading.node));
      const short = BigInt(lack?.lackByBatch.get(mark.batchId) ?? '0') > 0n;
      if (input.walletJobPaused && short && dueForMs(stamp, settings) >= FAILS_AFTER_MS) {
        const message = topUpFailedWarningText({
          stamp: stamp.reading.name,
          ttlSeconds: stamp.reading.ttlSeconds,
          reason: 'Its node is short of xBZZ for the top-up, and the wallet job is paused.',
          action: 'Fund the node on the Balance tab, or resume the wallet job on the Auto top-up tab.',
        });
        await this.store.raiseWarning(failedKey, message, now);
      }
    }
    return this.store.warnings();
  }

  /**
   * Tries the notices that wait for a channel again. A waiting notice tells of a warning that stands, or of a stamp
   * whose alert is recorded; one about nothing that stands any more is dropped. Answers a note, or null with nothing
   * to tell.
   */
  private async retryWaiting(
    now: Date,
    alerts: ReadonlyMap<string, AutoTopUpAlert | null>,
    warnings: readonly AutoTopUpWarningRow[],
  ): Promise<string | null> {
    const standing = new Set([
      ...warnings.map(autoTopUpWarningSubject),
      ...[...alerts].flatMap(([batchId, alert]) => (alert === null ? [] : [autoTopUpComingSubject(batchId)])),
    ]);
    const outcome = await this.notifier.retryWaiting(now, (subject) => standing.has(subject));
    const parts = [
      ...(outcome.sent > 0 ? [`${plural(outcome.sent, 'waiting notice')} sent again`] : []),
      ...(outcome.waiting > 0 ? [`${plural(outcome.waiting, 'notice')} still waiting for a channel`] : []),
    ];
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /**
   * Gives the recorded alerts not given yet. While someone gets "Top-ups coming up", its notice goes once a stamp
   * among them is upcoming or due, at most once a day, and lists every one of them; they count as given once one
   * destination took it. While nobody gets it, each counts as given when it was recorded, since the tab has shown it
   * since.
   */
  private async giveComingAlerts(
    input: AlertJobInput,
    planned: readonly PlannedStamp[],
    alerts: ReadonlyMap<string, AutoTopUpAlert | null>,
    lacks: ReadonlyMap<string, WalletLack>,
    on: boolean,
    noticesRow: AutoTopUpNoticesRow,
  ): Promise<string | null> {
    const { now, settings } = input;
    const ungiven = planned
      .filter((stamp) => {
        const alert = alerts.get(stamp.mark.batchId) ?? null;
        return stamp.plan.listed && alert !== null && alert.alertedAt === null;
      })
      .sort((a, b) => a.reading.ttlSeconds - b.reading.ttlSeconds);
    if (ungiven.length === 0) return null;
    if (!on) {
      for (const stamp of ungiven) {
        await this.store.setAlerted([stamp.mark.batchId], alerts.get(stamp.mark.batchId)!.recordedAt);
      }
      return null;
    }
    const turned = ungiven.some((stamp) => stamp.plan.phase !== 'healthy');
    if (!turned || msSince(noticesRow.lastComingAt, now) < ONCE_PER_MS) return null;

    const topUps: ComingTopUpText[] = ungiven.map((stamp) => ({
      stamp: stamp.reading.name,
      ttlSeconds: stamp.reading.ttlSeconds,
      dueAt: new Date(now.getTime() + stamp.plan.dueInSeconds * 1000),
      due: stamp.plan.phase === 'due',
      days: stamp.plan.days,
      costPlur: stamp.plan.costPlur,
      costWithMarginPlur: stamp.plan.costWithMarginPlur,
    }));
    // One topic holds every coming top-up, so whoever gets one gets the notice whole, as it is written here.
    const notice = comingNotice({
      topUps,
      nodes: comingNodes(input, ungiven, alerts, lacks),
      marginPercent: settings.marginPercent,
      lookAheadDays: settings.lookAheadDays,
      brandWallet: input.brandWallet,
    });
    const batchIds = ungiven.map((stamp) => stamp.mark.batchId);
    const failed = await this.send(
      {
        raisedAt: now,
        parts: batchIds.map((batchId) => ({
          topic: 'topups_coming' as const,
          subject: autoTopUpComingSubject(batchId),
          item: batchId,
        })),
        compose: () => notice,
      },
      notice.title,
    );
    if (failed !== null) return failed;
    await this.store.setAlerted(batchIds, now);
    await this.store.recordNotices({ lastComingAt: now });
    return `Sent the notice of ${plural(ungiven.length, 'coming top-up')}`;
  }

  /**
   * Sends the notices of the warnings: the first notice of each one not notified yet goes at once, all of them in one
   * notice, and the daily repeat of those still standing goes as one notice once a day. A stamp that expired is told
   * of once.
   */
  private async noticeWarnings(
    now: Date,
    warnings: readonly AutoTopUpWarningRow[],
    on: boolean,
    noticesRow: AutoTopUpNoticesRow,
  ): Promise<string | null> {
    if (!on || warnings.length === 0) return null;
    const notes: string[] = [];
    const item = (warning: AutoTopUpWarningRow): WarningNoticeItem => ({
      kind: warning.kind,
      message: warning.message,
      since: warning.since,
    });

    const outgoing = (
      told: readonly AutoTopUpWarningRow[],
      write: (items: readonly WarningNoticeItem[]) => Notice,
    ): OutgoingNotice<AutoTopUpWarningRow> => ({
      raisedAt: now,
      parts: told.map((warning) => ({
        topic: WARNING_TOPICS[warning.kind],
        subject: autoTopUpWarningSubject(warning),
        item: warning,
      })),
      compose: (parts) => write(parts.map((part) => item(part.item))),
    });

    const fresh = warnings.filter((warning) => warning.notifiedAt === null);
    if (fresh.length > 0) {
      const freshNotice = outgoing(fresh, newWarningsNotice);
      const failed = await this.send(freshNotice, freshNotice.compose(freshNotice.parts).title);
      if (failed !== null) return failed;
      await this.store.setWarningsNotified(fresh, now);
      notes.push(`Sent the notice of ${plural(fresh.length, 'new warning')}`);
    }

    const freshIds = new Set(fresh.map(warningId));
    const standing = warnings.filter(
      (warning) => warning.kind !== 'stamp_expired' && !freshIds.has(warningId(warning)),
    );
    const repeatDue =
      standing.some((warning) => msSince(warning.notifiedAt, now) >= ONCE_PER_MS) &&
      msSince(noticesRow.lastRepeatAt, now) >= ONCE_PER_MS;
    if (repeatDue) {
      const repeatNotice = outgoing(standing, standingWarningsNotice);
      const failed = await this.send(repeatNotice, repeatNotice.compose(repeatNotice.parts).title);
      if (failed !== null) return [...notes, failed].join('. ');
      await this.store.setWarningsNotified(standing, now);
      await this.store.recordNotices({ lastRepeatAt: now });
      notes.push(`Sent the notice of ${plural(standing.length, 'standing warning')} again`);
    }
    return notes.length > 0 ? notes.join('. ') : null;
  }

  /**
   * Sends one notice through the notifier. Answers null once a destination took it, or the note of why none did, which
   * is logged and never thrown; the next run sends it again. A destination that failed while another took the notice
   * gets it again from the notifier. `title` names the notice in that note, as it reads written from all its parts.
   */
  private async send<T>(notice: OutgoingNotice<T>, title: string): Promise<string | null> {
    const outcome = await this.notifier.notify(notice);
    if (outcome.parts.some((part) => part.taken)) return null;
    const why =
      outcome.failed === 0 ? 'nobody gets it.' : `${plural(outcome.failed, 'destination')} could not take it.`;
    this.logger.warn(`[AutoTopUp] no destination took the notice "${title}": ${why}`);
    return `${NOT_TAKEN} "${title}": ${why}`;
  }
}

/** Per node of the coming top-ups: what it holds, what the brand wallet sends it, and when. */
function comingNodes(
  input: AlertJobInput,
  stamps: readonly PlannedStamp[],
  alerts: ReadonlyMap<string, AutoTopUpAlert | null>,
  lacks: ReadonlyMap<string, WalletLack>,
): ComingNodeText[] {
  const { now, settings } = input;
  const byNode = new Map<string, PlannedStamp[]>();
  for (const stamp of stamps) {
    const id = stamp.reading.node.nodeId;
    byNode.set(id, [...(byNode.get(id) ?? []), stamp]);
  }
  return [...byNode.values()].map((nodeStamps): ComingNodeText => {
    const node = nodeStamps[0]!.reading.node;
    const sendPlur = nodeStamps
      .reduce((sum, stamp) => sum + BigInt(alerts.get(stamp.mark.batchId)?.sendPlur ?? '0'), 0n)
      .toString();
    const floor = nodeStamps.some((stamp) => stamp.reading.ttlSeconds < 2 * settings.lookAheadDays * SECONDS_PER_DAY);
    const firstDueMs = Math.min(...nodeStamps.map((stamp) => stamp.plan.dueInSeconds)) * 1000;
    const when: ComingNodeText['when'] =
      node.pin === null
        ? { kind: 'not_sendable' }
        : node.pin !== 'pinned'
          ? { kind: 'unconfirmed' }
          : input.walletJobPaused
            ? { kind: 'paused' }
            : floor
              ? { kind: 'now' }
              : { kind: 'at', at: new Date(now.getTime() + Math.max(settings.lookAheadDays * DAY_MS, firstDueMs)) };
    return {
      nodeLabel: node.label,
      walletAddress: node.walletAddress,
      xbzzPlur: node.xbzzPlur,
      xdaiWei: node.xdaiWei,
      sendPlur,
      gasSendWei: lacks.get(walletKey(node))?.lacksGas === true ? NODE_GAS_FUND_WEI : null,
      when,
    };
  });
}

/** Whether the brand wallet may send to this node now: its address against the one an operator confirmed. */
function pinOf(context: AutoTopUpTickContext, nodeId: string, walletAddress: string | null): FundingPinState {
  const pinned = context.funding.pins.get(nodeId);
  if (pinned === undefined) return 'new';
  return walletAddress !== null && walletAddress.toLowerCase() === pinned ? 'pinned' : 'changed';
}

/**
 * One marked stamp as the alert job reads it, or null for one whose node the admin funds no more, which the stamp job
 * reports. A batch the node holds no more, or with no time left, is expired; a node or batch that could not be read,
 * or a node whose view of the chain is not known to be current, is unread; a batch not usable yet is waiting.
 */
export function alertReadingOf(context: AutoTopUpTickContext, stamp: AutoTopUpMarkedStamp): AlertStampReading | null {
  const { node, batch } = stamp;
  if (node === null) return null;
  const name: StampName = stampNameOf(context, stamp);
  if (batch === null || batch.state === 'expired' || batch.state === 'gone' || batch.ttlSeconds === 0) {
    return { state: 'expired', name };
  }
  if (node.readError !== null || batch.readError !== null || batch.depth === null || batch.ttlSeconds === null) {
    return { state: 'unread', name, ttlSeconds: batch.ttlSeconds, reason: 'Its node could not be read.' };
  }
  if (stamp.chainCurrent !== true) {
    const reason =
      stamp.chainCurrent === false
        ? "Its node's view of the chain is behind."
        : "Whether its node's view of the chain is current could not be read.";
    return { state: 'unread', name, ttlSeconds: batch.ttlSeconds, reason };
  }
  if (batch.usable !== true) return { state: 'waiting', name };
  return {
    state: 'operable',
    name,
    depth: batch.depth,
    ttlSeconds: batch.ttlSeconds,
    node: {
      nodeId: node.nodeId,
      label: node.label,
      walletAddress: node.walletAddress,
      xbzzPlur: node.xbzzPlur,
      xdaiWei: node.xdaiWei,
      pin: pinOf(context, node.nodeId, node.walletAddress),
    },
  };
}

/** The alert job's input from a tick's context. */
export function alertJobInputOf(context: AutoTopUpTickContext, walletJobPaused: boolean): AlertJobInput {
  const readings = new Map<string, AlertStampReading>();
  for (const stamp of context.stamps) {
    const reading = alertReadingOf(context, stamp);
    if (reading !== null) readings.set(stamp.mark.batchId, reading);
  }
  const wallet = context.funding.brandWallet;
  return {
    now: context.now,
    settings: context.settings,
    postage: context.funding.postage,
    brandWallet:
      wallet === null ? null : { address: wallet.address, xbzzPlur: wallet.xbzzPlur, xdaiWei: wallet.xdaiWei },
    walletJobPaused,
    readings,
    estimateDepths: estimateDepthsOf(context.stamps),
  };
}
