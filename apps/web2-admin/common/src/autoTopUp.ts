/**
 * Stamp auto top-up: the marks on the Stamps tab, the settings on the Funding page's Auto top-up tab, and the rules
 * the admin's three timed jobs keep a marked stamp alive by. The alert job announces a top-up a look-ahead before it
 * falls due, the wallet job sends a short node what its due top-up lacks from the brand wallet, and the stamp job tops
 * up the due stamps whose node holds enough. `docs/architecture/funding.md`, "Auto top-up", is the design.
 *
 * The arithmetic here is one rule for the three jobs and for the console. Every amount is base units as a decimal
 * string: PLUR for xBZZ and wei for xDAI. Every moment on the wire is ISO 8601.
 */

import { FUNDING_PATH, type FundingPostage } from './funding.js';
import type { NoticeTopic } from './notices.js';
import { SECONDS_PER_DAY, stampTopUpQuote } from './stampQuote.js';

/** `GET`: the Auto top-up tab's view, which the Stamps tab reads its marks from as well. */
export const FUNDING_AUTO_TOPUP_PATH = `${FUNDING_PATH}/auto-top-up`;

/** `GET`: the stamps that are not marked for auto top-up and are running low, which the Auto top-up tab lists. */
export const FUNDING_AUTO_TOPUP_UNMARKED_PATH = `${FUNDING_AUTO_TOPUP_PATH}/unmarked`;

/** `PUT`: save the numbers, behind the operator's password. */
export const FUNDING_AUTO_TOPUP_SETTINGS_PATH = `${FUNDING_AUTO_TOPUP_PATH}/settings`;

/** `PUT`: mark or unmark stamps. */
export const FUNDING_AUTO_TOPUP_MARKS_PATH = `${FUNDING_AUTO_TOPUP_PATH}/marks`;

/** The three jobs, in the order a tick runs them. */
export const AUTO_TOPUP_JOBS = ['alert', 'wallet', 'stamp'] as const;
export type AutoTopUpJob = (typeof AUTO_TOPUP_JOBS)[number];

/** `PUT`: pause or resume one job. */
export function fundingAutoTopUpJobPath(job: AutoTopUpJob): string {
  return `${FUNDING_AUTO_TOPUP_PATH}/jobs/${job}`;
}

/** How often a tick runs the three jobs: every 10 minutes. */
export const AUTO_TOPUP_TICK_SECONDS = 600;

/** The days of top-ups the monthly estimate counts for each marked stamp. */
export const AUTO_TOPUP_MONTH_DAYS = 30;

/**
 * One day, the window of four rules: a stamp is topped up automatically at most once in it, a node takes at most one
 * gas transfer in it, the daily ceiling counts what the wallet job sent in it, and a standing warning goes out in
 * a notice again once it has passed.
 */
export const AUTO_TOPUP_ONCE_PER_SECONDS = SECONDS_PER_DAY;

/** How long a marked stamp's node may be unread, or its chain view behind, before that counts as a failure: an hour. */
export const AUTO_TOPUP_UNREAD_FAILS_AFTER_SECONDS = 3600;

/**
 * What a node without gas is sent, in wei: 0.01 xDAI, the amount Fund all enters on the Balance tab for a node that
 * holds none.
 */
export const NODE_GAS_FUND_WEI = '10000000000000000';

/**
 * The xDAI a node's wallet is counted to need for each due top-up, in wei: 0.001 xDAI. A top-up is two transactions of
 * the node, an approve and the top-up, with gas limits of up to about 765,000 together, about 500,000 of it used. At
 * the 0.03 to 0.16 gwei that postage transactions paid on Gnosis Chain on 2026-11-24, 0.001 xDAI covers those limits
 * eight times over at the highest of them.
 */
export const AUTO_TOPUP_GAS_WEI_PER_TOPUP = '1000000000000000';

/** 409: a stamp named for a mark is one the admin cannot top up, or one the manager does not list. */
export const AUTO_TOPUP_NOT_MARKABLE_ERROR = 'not_markable';

/**
 * The numbers of the Auto top-up tab. A marked stamp with less than `topUpUnderDays` left is due, and is topped up to
 * `topUpToDays`. The alert goes out `lookAheadDays` before a top-up falls due, and the wallet job waits that long after
 * it. `marginPercent` is added to the cost estimate in the alert and to what the wallet job sends.
 */
export interface AutoTopUpSettings {
  /** Whole days. */
  topUpUnderDays: number;
  /** Whole days, more than `topUpUnderDays`. No job takes a stamp past it. */
  topUpToDays: number;
  /** Whole days. Twice this is the floor under which a send goes without waiting, so it is at most half `topUpUnderDays`. */
  lookAheadDays: number;
  /** A whole percent. */
  marginPercent: number;
  /** The brand wallet holding less xDAI than this is warned about, wei as a decimal string. */
  xdaiWarningWei: string;
  /**
   * The most xBZZ the wallet job sends in any 24 hours, PLUR as a decimal string, or null, and then it follows half
   * the monthly estimate ({@link autoTopUpDailyCeilingPlur}).
   */
  dailyCeilingPlur: string | null;
}

/** The numbers while none were saved: under 7 days, top up to 14; a day ahead; 10%; 0.1 xDAI; the ceiling follows. */
export const AUTO_TOPUP_DEFAULTS: AutoTopUpSettings = {
  topUpUnderDays: 7,
  topUpToDays: 14,
  lookAheadDays: 1,
  marginPercent: 10,
  xdaiWarningWei: '100000000000000000',
  dailyCeilingPlur: null,
};

/** The least and the most each whole number of the settings takes. Migration 034 holds the same bounds. */
export const AUTO_TOPUP_BOUNDS = {
  topUpUnderDays: { min: 2, max: 365 },
  topUpToDays: { min: 3, max: 730 },
  lookAheadDays: { min: 1, max: 30 },
  marginPercent: { min: 0, max: 100 },
} as const;

const BASE_UNITS_PATTERN = /^(0|[1-9]\d{0,77})$/;

const SETTING_NAMES: Readonly<Record<keyof typeof AUTO_TOPUP_BOUNDS, string>> = {
  topUpUnderDays: 'Top up when under',
  topUpToDays: 'Top up to',
  lookAheadDays: 'Look ahead',
  marginPercent: 'Margin',
};

/** Why these settings are refused, a sentence each, or an empty list when they can be saved. */
export function autoTopUpSettingsProblems(settings: AutoTopUpSettings): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(AUTO_TOPUP_BOUNDS) as (keyof typeof AUTO_TOPUP_BOUNDS)[]) {
    const { min, max } = AUTO_TOPUP_BOUNDS[key];
    const value = settings[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${SETTING_NAMES[key]} is a whole number from ${min} to ${max}.`);
    }
  }
  if (problems.length === 0) {
    if (settings.topUpToDays <= settings.topUpUnderDays) {
      problems.push('Top up to is more days than Top up when under.');
    }
    if (settings.lookAheadDays * 2 > settings.topUpUnderDays) {
      problems.push('Look ahead is at most half of Top up when under.');
    }
  }
  if (!BASE_UNITS_PATTERN.test(settings.xdaiWarningWei)) problems.push('The xDAI warning is an amount of xDAI.');
  if (settings.dailyCeilingPlur !== null && !BASE_UNITS_PATTERN.test(settings.dailyCeilingPlur)) {
    problems.push('The daily ceiling is an amount of xBZZ, or empty.');
  }
  return problems;
}

/** `PUT /api/funding/auto-top-up/settings`: save these numbers, behind the operator's password. */
export interface AutoTopUpSettingsRequest {
  password: string;
  settings: AutoTopUpSettings;
}

/** One stamp to mark or unmark: the batch, and the node that holds it and pays for its top-ups. */
export interface AutoTopUpMarkItem {
  nodeId: string;
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
}

/**
 * `PUT /api/funding/auto-top-up/marks`: mark these stamps for auto top-up, or take the mark off them. A session is
 * enough, as for a top-up by hand. A stamp is marked when the admin could top it up now: the catalogue batch, an
 * archive stamp on a node the admin funds, or a stage's batch. Any other answers 409 `not_markable`, and nothing is
 * marked.
 */
export interface AutoTopUpMarksRequest {
  marked: boolean;
  items: AutoTopUpMarkItem[];
}

/** `PUT /api/funding/auto-top-up/jobs/:job`: pause the job, or let it run again. */
export interface AutoTopUpJobRequest {
  paused: boolean;
}

/** One job: whether it is paused, and how its last run went. */
export interface AutoTopUpJobState {
  job: AutoTopUpJob;
  paused: boolean;
  /** Who paused it and when, or null while it runs. */
  pausedBy: string | null;
  pausedAt: string | null;
  /** When it last ran, or null before its first run. A paused job keeps the run before the pause. */
  lastRunAt: string | null;
  /** Whether that run went through, or null before the first. */
  lastOk: boolean | null;
  /** What that run did or what stopped it, in a sentence, or null before the first. */
  lastOutcome: string | null;
}

/** The last automatic top-up of a stamp. */
export interface AutoTopUpLastTopUp {
  at: string;
  days: number;
  costPlur: string;
}

/**
 * The top-up coming for a marked stamp: what the alert job worked out, and where the notice stands. It is there from
 * the moment the stamp comes within two look-aheads of the threshold until it is topped up or unmarked.
 */
export interface AutoTopUpComing {
  /** Whether the stamp is under the threshold now. */
  due: boolean;
  /** When it falls due at today's price, or fell due. */
  dueAt: string;
  /** The whole days the top-up adds. */
  days: number;
  /** What the top-up costs at today's price, PLUR. */
  costPlur: string;
  /** That cost plus the margin, PLUR. */
  costWithMarginPlur: string;
  /** The xBZZ the brand wallet sends its node for it, PLUR: `0` when the node holds enough. */
  sendPlur: string;
  /** Whether its node is sent gas with it. */
  gasSend: boolean;
  /**
   * When the alert was given: taken by one notification channel, or, with no channel on, shown on the page. Null
   * while it is recorded and no channel took its notice yet. The wallet job's wait counts from it.
   */
  alertedAt: string | null;
  /** When the wallet job sends for it at the earliest, or null when nothing is sent for it or no alert was given. */
  sendAt: string | null;
}

/** One marked stamp as the Stamps tab's row and the Auto top-up tab show it. */
export interface AutoTopUpStampState {
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  nodeId: string;
  /** The node's label when the stamp was marked. */
  nodeLabel: string;
  markedBy: string;
  markedAt: string;
  lastTopUp: AutoTopUpLastTopUp | null;
  coming: AutoTopUpComing | null;
  /** What stopped its last attempt, or that it expired, in a sentence, or null. */
  problem: string | null;
}

/**
 * The kinds of warning: the brand wallet's xBZZ under a month of top-ups for the marked stamps, its xDAI under the
 * threshold, a due marked stamp that could not be topped up, and a marked stamp that expired. The first three stand
 * while their cause lasts and go out in a notice once, then once a day. The last goes out once.
 */
export const AUTO_TOPUP_WARNING_KINDS = ['wallet_xbzz', 'wallet_xdai', 'topup_failed', 'stamp_expired'] as const;
export type AutoTopUpWarningKind = (typeof AUTO_TOPUP_WARNING_KINDS)[number];

/** One warning that stands. */
export interface AutoTopUpWarning {
  kind: AutoTopUpWarningKind;
  /** The stamp it is about, or null for the brand wallet's. */
  batchId: string | null;
  /** Since when it stands. */
  since: string;
  /** What it says, in a sentence or two. */
  message: string;
  /** When a notice last told of it, or null. */
  notifiedAt: string | null;
}

/**
 * `GET /api/funding/auto-top-up`, and what each of the three writes answers. The brand wallet's balances are the
 * Funding view's.
 */
export interface AutoTopUpView {
  settings: AutoTopUpSettings;
  /** Who last saved the numbers and when, or null while they are the defaults. */
  settingsSavedBy: string | null;
  settingsSavedAt: string | null;
  /** The three jobs, in the order of {@link AUTO_TOPUP_JOBS}. */
  jobs: AutoTopUpJobState[];
  /** Every marked stamp. */
  stamps: AutoTopUpStampState[];
  /**
   * What 30 days of top-ups for the marked stamps cost at today's price, PLUR, or null when the manager or the price
   * could not be read.
   */
  monthlyEstimatePlur: string | null;
  /** The daily ceiling in force, PLUR, or null with no estimate to follow. */
  dailyCeilingPlur: string | null;
  /** The xBZZ the wallet job sent in the last 24 hours, PLUR. */
  sentTodayPlur: string;
  warnings: AutoTopUpWarning[];
}

/** Where a marked stamp stands against the rule. */
export type AutoTopUpPhase = 'healthy' | 'upcoming' | 'due';

/** What the rule says of one marked stamp at today's price. */
export interface AutoTopUpStampPlan {
  /**
   * `due` under the threshold, `upcoming` within a look-ahead of it, and `healthy` above that. The alert for a stamp
   * goes out when it turns `upcoming`.
   */
  phase: AutoTopUpPhase;
  /** Whether it is within two look-aheads of the threshold: a notice about another top-up lists it as well. */
  listed: boolean;
  /**
   * The whole days its top-up adds: for a due stamp, the whole days missing to the level, so the stamp ends at the
   * level or under it; for one not due yet, the days between the threshold and the level.
   */
  days: number;
  /** What that top-up costs, PLUR. */
  costPlur: string;
  /** That cost plus the margin, rounded up, PLUR. */
  costWithMarginPlur: string;
  /** The seconds until it falls due, 0 once it is. */
  dueInSeconds: number;
}

/** `costPlur` plus `marginPercent` of it, rounded up to a whole PLUR. */
export function autoTopUpWithMargin(costPlur: string, marginPercent: number): string {
  return ((BigInt(costPlur) * BigInt(100 + marginPercent) + 99n) / 100n).toString();
}

/**
 * The rule for one marked stamp read whole (`operableBatch`), with `ttlSeconds` left, at `postage`'s price. The
 * settings are ones {@link autoTopUpSettingsProblems} passes.
 */
export function autoTopUpStampPlan(
  batch: { depth: number; ttlSeconds: number },
  settings: AutoTopUpSettings,
  postage: FundingPostage,
): AutoTopUpStampPlan {
  const under = settings.topUpUnderDays * SECONDS_PER_DAY;
  const level = settings.topUpToDays * SECONDS_PER_DAY;
  const lookAhead = settings.lookAheadDays * SECONDS_PER_DAY;
  const due = batch.ttlSeconds < under;
  const phase: AutoTopUpPhase = due ? 'due' : batch.ttlSeconds < under + lookAhead ? 'upcoming' : 'healthy';
  const days = due
    ? Math.max(1, Math.floor((level - batch.ttlSeconds) / SECONDS_PER_DAY))
    : settings.topUpToDays - settings.topUpUnderDays;
  const costPlur = stampTopUpQuote(days, batch.depth, batch.ttlSeconds, postage).costPlur;
  return {
    phase,
    listed: batch.ttlSeconds < under + 2 * lookAhead,
    days,
    costPlur,
    costWithMarginPlur: autoTopUpWithMargin(costPlur, settings.marginPercent),
    dueInSeconds: due ? 0 : batch.ttlSeconds - under,
  };
}

/** One top-up a wallet is to pay: a stamp's plan, with its time left to order by. */
export interface AutoTopUpWalletTopUp {
  batchId: string;
  ttlSeconds: number;
  costPlur: string;
  costWithMarginPlur: string;
}

/** What a wallet's balances mean for one of its top-ups. */
export interface AutoTopUpWalletItem {
  batchId: string;
  /**
   * Whether the wallet covers it now: the xBZZ of its cost and the xDAI of its gas, after the covered top-ups before
   * it. The stamp job asks for the covered ones.
   */
  covered: boolean;
  /**
   * The xBZZ the wallet lacks to hold its cost plus the margin, after the cost plus the margin of every top-up before
   * it, PLUR. The wallet job sends it, and the alert names it.
   */
  lackPlur: string;
}

/** A wallet against the top-ups it is to pay, the one with the least time left first. */
export interface AutoTopUpWalletPlan {
  items: AutoTopUpWalletItem[];
  /** The sum of the items' `lackPlur`: what brings the wallet to every cost plus the margin. */
  lackPlur: string;
  /** The xDAI the top-ups are counted to need: {@link AUTO_TOPUP_GAS_WEI_PER_TOPUP} for each. */
  gasNeedWei: string;
  /** Whether the wallet holds less xDAI than that. The wallet job then sends it {@link NODE_GAS_FUND_WEI}. */
  lacksGas: boolean;
}

/**
 * One wallet's balances against the top-ups of the stamps it pays for. Several nodes may answer one wallet, and then
 * their stamps are counted together here. The alert job passes the top-ups coming, to say what will be sent; the
 * wallet job and the stamp job pass the due ones.
 */
export function autoTopUpWalletPlan(
  wallet: { xbzzPlur: string; xdaiWei: string },
  topUps: readonly AutoTopUpWalletTopUp[],
): AutoTopUpWalletPlan {
  const ordered = [...topUps].sort(
    (a, b) => a.ttlSeconds - b.ttlSeconds || (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0),
  );
  const gasEach = BigInt(AUTO_TOPUP_GAS_WEI_PER_TOPUP);
  let held = BigInt(wallet.xbzzPlur);
  let reserved = held;
  let gas = BigInt(wallet.xdaiWei);
  let lack = 0n;
  const items = ordered.map((topUp): AutoTopUpWalletItem => {
    const cost = BigInt(topUp.costPlur);
    const withMargin = BigInt(topUp.costWithMarginPlur);
    const covered = held >= cost && gas >= gasEach;
    if (covered) {
      held -= cost;
      gas -= gasEach;
    }
    const lacks = withMargin > reserved ? withMargin - reserved : 0n;
    reserved = reserved > withMargin ? reserved - withMargin : 0n;
    lack += lacks;
    return { batchId: topUp.batchId, covered, lackPlur: lacks.toString() };
  });
  const gasNeed = gasEach * BigInt(ordered.length);
  return {
    items,
    lackPlur: lack.toString(),
    gasNeedWei: gasNeed.toString(),
    lacksGas: BigInt(wallet.xdaiWei) < gasNeed,
  };
}

/**
 * Whether the wallet job may send for a due top-up: `go` once its alert is a look-ahead old, `floor` when the alert is
 * younger or was never given and the stamp has under two look-aheads left, and `wait` otherwise. A send at `floor`
 * goes without the wait, and its notice says so.
 */
export type AutoTopUpSendTiming = 'go' | 'floor' | 'wait';

/** The notice rule. `alertedAt` and `now` are milliseconds, and `alertedAt` is null while no alert was given. */
export function autoTopUpSendTiming(
  stamp: { alertedAt: number | null; ttlSeconds: number },
  settings: AutoTopUpSettings,
  now: number,
): AutoTopUpSendTiming {
  const lookAhead = settings.lookAheadDays * SECONDS_PER_DAY;
  if (stamp.alertedAt !== null && now - stamp.alertedAt >= lookAhead * 1000) return 'go';
  return stamp.ttlSeconds < 2 * lookAhead ? 'floor' : 'wait';
}

/**
 * The amount rule: whether what a stamp's top-up lacks now is within what its alert said the brand wallet sends for
 * it. Within it, the wallet job sends what it lacks now. Past it, a new alert goes out with the new figure and its wait
 * counts again, and only a send at `floor` goes for more than the alert said. `alertedSendPlur` is null while no alert
 * was recorded.
 */
export function autoTopUpWithinAlert(lackPlur: string, alertedSendPlur: string | null): boolean {
  return alertedSendPlur !== null && BigInt(lackPlur) <= BigInt(alertedSendPlur);
}

/**
 * The monthly estimate: 30 days of top-ups for each marked stamp that can be topped up, by its depth, at `postage`'s
 * price, summed, with no margin. PLUR as a decimal string.
 */
export function autoTopUpMonthlyEstimatePlur(depths: readonly number[], postage: FundingPostage): string {
  return depths
    .reduce((sum, depth) => sum + BigInt(stampTopUpQuote(AUTO_TOPUP_MONTH_DAYS, depth, 0, postage).costPlur), 0n)
    .toString();
}

/** The daily ceiling in force: the one saved, or half the monthly estimate while none is. PLUR as a decimal string. */
export function autoTopUpDailyCeilingPlur(settings: AutoTopUpSettings, monthlyEstimatePlur: string): string {
  return settings.dailyCeilingPlur ?? (BigInt(monthlyEstimatePlur) / 2n).toString();
}

// ------------------------------------------------ the stamps not on auto top-up

/**
 * The stamps that are not marked for auto top-up are watched by the alert job as well: the catalogue batch, the
 * archive stamps and each stage's batches, every one the Stamps tab lists without a mark. The admin tops none of them
 * up. One that runs low is listed on the Auto top-up tab and told of in a notice, under the topic of whoever holds it.
 */
export const UNMARKED_STAMP_HOLDERS = ['catalogue', 'stage'] as const;
export type UnmarkedStampHolder = (typeof UNMARKED_STAMP_HOLDERS)[number];

/** The topic a low unmarked stamp is told of under: the catalogue batch and the archive stamps, or a stage's batch. */
export function unmarkedStampTopic(holder: UnmarkedStampHolder): NoticeTopic {
  return holder === 'catalogue' ? 'unmarked_catalogue' : 'unmarked_stage';
}

/**
 * Where a low unmarked stamp stands: `low` under "Top up when under", `last` under {@link UNMARKED_STAMP_LAST_DAYS},
 * and `expired` once it ran out or its node holds it no more. A notice tells of each level once, when the stamp reaches
 * it, and while a stamp is `low` or `last` one notice a day lists it with every other one that is.
 */
export const UNMARKED_STAMP_LEVELS = ['low', 'last', 'expired'] as const;
export type UnmarkedStampLevel = (typeof UNMARKED_STAMP_LEVELS)[number];

/** The days left under which an unmarked stamp is told of a second time: 2. */
export const UNMARKED_STAMP_LAST_DAYS = 2;

/**
 * The level of an unmarked stamp read whole (`operableBatch`), with `ttlSeconds` left: `last` under
 * {@link UNMARKED_STAMP_LAST_DAYS}, `low` under the settings' "Top up when under", and null at that or above, which is
 * a stamp the alert job has nothing to say of.
 */
export function unmarkedStampLevel(
  ttlSeconds: number,
  settings: Pick<AutoTopUpSettings, 'topUpUnderDays'>,
): Exclude<UnmarkedStampLevel, 'expired'> | null {
  if (ttlSeconds < UNMARKED_STAMP_LAST_DAYS * SECONDS_PER_DAY) return 'last';
  return ttlSeconds < settings.topUpUnderDays * SECONDS_PER_DAY ? 'low' : null;
}

/** One low unmarked stamp, as the Auto top-up tab lists it. */
export interface AutoTopUpUnmarkedStamp {
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  nodeId: string;
  holder: UnmarkedStampHolder;
  level: UnmarkedStampLevel;
  /** Since when it has been under "Top up when under". */
  since: string;
  /** Since when it has been at its level. */
  levelSince: string;
  /** What it is, how long it has left and what a person can do, in a sentence or two, as the last run worded it. */
  message: string;
  /** When a notice last told of it, or null: none went yet, or nobody gets its topic. */
  notifiedAt: string | null;
}

/** `GET /api/funding/auto-top-up/unmarked`: every low unmarked stamp, the one with the least time left first. */
export interface AutoTopUpUnmarkedView {
  stamps: AutoTopUpUnmarkedStamp[];
}
