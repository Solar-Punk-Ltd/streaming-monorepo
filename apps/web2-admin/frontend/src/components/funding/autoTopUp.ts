import {
  AUTO_TOPUP_TICK_SECONDS,
  autoTopUpSendTiming,
  autoTopUpSettingsProblems,
  autoTopUpStampPlan,
  autoTopUpWalletPlan,
  operableBatch,
  XBZZ_DECIMALS,
  XDAI_DECIMALS,
  type AutoTopUpSettings,
  type AutoTopUpStampState,
  type AutoTopUpView,
  type AutoTopUpWalletTopUp,
  type FundingBatch,
  type FundingPostage,
} from '@streaming-monorepo/web2-admin-common';

import { formatDateTime } from '../../dateUtil';
import { shortHex } from '../../format';
import { formatShort, formatUnits, readAmount } from './amounts';
import { dayCount, hasTickBox, type BatchRow } from './stamps';

/**
 * Stamp auto top-up as the console shows it: a marked stamp's lines on the Stamps tab, what marking a stamp that is
 * already due says, and the Auto top-up tab's numbers as typed, read into what the API takes.
 * The rule itself is the common `autoTopUp`, the one the admin's jobs keep.
 */

/** How often the jobs run, in minutes, as the lines say it. */
export const RUN_MINUTES = AUTO_TOPUP_TICK_SECONDS / 60;

/** A batch id as the marks key it: `0x` and lower case. */
export function markKey(batchId: string): string {
  return batchId.toLowerCase();
}

/** The marked stamps of the view, by batch id. */
export function marksOf(view: AutoTopUpView | null): ReadonlyMap<string, AutoTopUpStampState> {
  return new Map((view?.stamps ?? []).map((stamp) => [markKey(stamp.batchId), stamp]));
}

/** An amount of xBZZ to three decimals with its token. */
export function xbzzText(plur: string): string {
  return `${formatShort(plur, XBZZ_DECIMALS)} xBZZ`;
}

/** An amount of xDAI to three decimals with its token. */
export function xdaiText(wei: string): string {
  return `${formatShort(wei, XDAI_DECIMALS)} xDAI`;
}

/** Whether a row has the Auto top-up switch: it can be topped up now, or it is marked, so the mark can come off. */
export function hasSwitch(row: BatchRow, marked: boolean): boolean {
  return marked || hasTickBox(row, 'topup');
}

/** What a marked row says under its switch: its last automatic top-up, its next one, and what stopped the last. */
export interface MarkLines {
  last: string;
  next: string | null;
  problem: string | null;
}

/** Said on a marked row before its first automatic top-up. */
export const NOT_TOPPED_UP_YET = 'Not topped up automatically yet.';

/**
 * A marked row's lines. The next top-up is the alert job's figure while it has one (`coming`), and otherwise the rule
 * worked out here at today's price from the batch as the manager read it at `now`; with neither, there is no line.
 */
export function markLines(
  mark: AutoTopUpStampState,
  batch: FundingBatch,
  settings: AutoTopUpSettings,
  postage: FundingPostage | null,
  now: number,
): MarkLines {
  const last = mark.lastTopUp
    ? `Last topped up automatically ${formatDateTime(mark.lastTopUp.at)}, by ${dayCount(mark.lastTopUp.days)}.`
    : NOT_TOPPED_UP_YET;
  let next: string | null = null;
  const { coming } = mark;
  if (coming) {
    next = coming.due
      ? `Due now: ${dayCount(coming.days)} for about ${xbzzText(coming.costPlur)}.`
      : `Next top-up due about ${formatDateTime(coming.dueAt)}: ${dayCount(coming.days)} for about ${xbzzText(coming.costPlur)}.`;
  } else if (postage && operableBatch(batch)) {
    const plan = autoTopUpStampPlan(batch, settings, postage);
    next =
      plan.phase === 'due'
        ? `Due now: ${dayCount(plan.days)} for about ${xbzzText(plan.costPlur)}.`
        : `Next top-up due about ${formatDateTime(new Date(now + plan.dueInSeconds * 1000).toISOString())}: ${dayCount(plan.days)} for about ${xbzzText(plan.costPlur)}.`;
  }
  return { last, next, problem: mark.problem };
}

/** The wallet a node pays from, so the stamps of nodes that share one are counted together, as the jobs count them. */
function walletKey(row: BatchRow): string {
  return row.node.walletAddress?.toLowerCase() ?? `node:${row.node.nodeId}`;
}

/**
 * What marking these stamps says for each that is already due: what its top-up costs, whether its node holds that, and
 * when the brand wallet sends the rest. `rows` are the Stamps tab's, each batch once; `view` is the answer to the mark,
 * with every stamp marked now. The wallet is counted against every due marked stamp it pays for, the one with the least
 * time left first, as the jobs count it. Empty when none is due or there is no price.
 */
export function dueMarkNotices(
  marked: readonly string[],
  rows: readonly BatchRow[],
  view: AutoTopUpView,
  postage: FundingPostage | null,
  now: number,
): string[] {
  if (!postage) return [];
  const { settings } = view;
  const marks = marksOf(view);
  const due = new Map<string, { row: BatchRow; topUp: AutoTopUpWalletTopUp; days: number }>();
  for (const row of rows) {
    const key = markKey(row.batch.batchId);
    if (!marks.has(key) || !operableBatch(row.batch)) continue;
    const plan = autoTopUpStampPlan(row.batch, settings, postage);
    if (plan.phase !== 'due') continue;
    due.set(key, {
      row,
      days: plan.days,
      topUp: {
        batchId: key,
        ttlSeconds: row.batch.ttlSeconds,
        costPlur: plan.costPlur,
        costWithMarginPlur: plan.costWithMarginPlur,
      },
    });
  }
  const notices: string[] = [];
  for (const batchId of marked.map(markKey)) {
    const entry = due.get(batchId);
    if (!entry) continue;
    const { row, topUp, days } = entry;
    const { node } = row;
    const head = `The batch ${shortHex(batchId)} of ${node.label} is due now: its top-up of ${dayCount(days)} costs about ${xbzzText(topUp.costPlur)}.`;
    if (node.xbzzPlur === null || node.xdaiWei === null) {
      notices.push(`${head} Its node's wallet could not be read.`);
      continue;
    }
    const sharing = [...due.values()].filter((other) => walletKey(other.row) === walletKey(row));
    const plan = autoTopUpWalletPlan(
      { xbzzPlur: node.xbzzPlur, xdaiWei: node.xdaiWei },
      sharing.map((other) => other.topUp),
    );
    const item = plan.items.find((each) => each.batchId === batchId);
    if (item?.covered) {
      notices.push(
        `${head} ${node.label} holds that, so it is topped up at the next run, within ${RUN_MINUTES} minutes.`,
      );
      continue;
    }
    const lacks =
      item && item.lackPlur !== '0'
        ? `${node.label} holds ${xbzzText(node.xbzzPlur)}, so the brand wallet sends it ${xbzzText(item.lackPlur)} with the margin${plan.lacksGas ? ' and gas' : ''}`
        : `${node.label} holds too little xDAI for the gas, so the brand wallet sends it gas`;
    notices.push(`${head} ${lacks}, ${whenSent(marks.get(batchId), topUp.ttlSeconds, settings, now)}`);
  }
  return notices;
}

/** When the brand wallet sends for a due stamp, by the notice rule, in the rest of a sentence. */
function whenSent(
  mark: AutoTopUpStampState | undefined,
  ttlSeconds: number,
  settings: AutoTopUpSettings,
  now: number,
): string {
  const coming = mark?.coming ?? null;
  if (coming?.sendAt) return `at about ${formatDateTime(coming.sendAt)}.`;
  const alertedAt = coming?.alertedAt ? Date.parse(coming.alertedAt) : null;
  const timing = autoTopUpSendTiming({ alertedAt, ttlSeconds }, settings, now);
  const lookAhead = dayCount(settings.lookAheadDays);
  if (timing === 'go') return `at the next run, within ${RUN_MINUTES} minutes.`;
  if (timing === 'floor') {
    return `at the next run, within ${RUN_MINUTES} minutes: with under ${dayCount(2 * settings.lookAheadDays)} left, it does not wait ${lookAhead} after the alert.`;
  }
  if (coming?.alertedAt) return `${lookAhead} after the alert of ${formatDateTime(coming.alertedAt)}.`;
  return `${lookAhead} after the alert, which goes out at the next run.`;
}

/** The numbers as typed on the Auto top-up tab: whole numbers, and the two amounts in xDAI and xBZZ. */
export interface NumbersDraft {
  topUpUnderDays: string;
  topUpToDays: string;
  lookAheadDays: string;
  marginPercent: string;
  /** xDAI, as typed. */
  xdaiWarning: string;
  /** xBZZ, as typed; empty, the ceiling follows half the monthly estimate. */
  dailyCeiling: string;
}

/** The saved numbers as the fields show them. */
export function numbersDraftOf(settings: AutoTopUpSettings): NumbersDraft {
  return {
    topUpUnderDays: String(settings.topUpUnderDays),
    topUpToDays: String(settings.topUpToDays),
    lookAheadDays: String(settings.lookAheadDays),
    marginPercent: String(settings.marginPercent),
    xdaiWarning: formatUnits(settings.xdaiWarningWei, XDAI_DECIMALS),
    dailyCeiling: settings.dailyCeilingPlur === null ? '' : formatUnits(settings.dailyCeilingPlur, XBZZ_DECIMALS),
  };
}

const WHOLE = /^\d+$/;

/** A whole number as typed, or NaN, which the common check refuses with its own sentence. */
function wholeOf(typed: string): number {
  const text = typed.trim();
  return WHOLE.test(text) ? Number(text) : Number.NaN;
}

/** Said when the xDAI warning is left empty. */
export const XDAI_WARNING_EMPTY = 'The xDAI warning is an amount of xDAI.';

/**
 * The typed numbers as the API takes them, and every reason they cannot be saved: the common
 * `autoTopUpSettingsProblems`, and before it why an amount cannot be read.
 */
export function readNumbersDraft(draft: NumbersDraft): { settings: AutoTopUpSettings; problems: string[] } {
  const problems: string[] = [];
  const xdai = readAmount(draft.xdaiWarning, XDAI_DECIMALS);
  if (xdai.kind === 'empty') problems.push(XDAI_WARNING_EMPTY);
  if (xdai.kind === 'invalid') problems.push(`The xDAI warning: ${xdai.problem}`);
  const ceiling = readAmount(draft.dailyCeiling, XBZZ_DECIMALS);
  if (ceiling.kind === 'invalid') problems.push(`The daily ceiling: ${ceiling.problem}`);
  const settings: AutoTopUpSettings = {
    topUpUnderDays: wholeOf(draft.topUpUnderDays),
    topUpToDays: wholeOf(draft.topUpToDays),
    lookAheadDays: wholeOf(draft.lookAheadDays),
    marginPercent: wholeOf(draft.marginPercent),
    xdaiWarningWei: xdai.kind === 'ok' ? xdai.value : '0',
    dailyCeilingPlur: ceiling.kind === 'ok' ? ceiling.value : null,
  };
  return { settings, problems: [...problems, ...autoTopUpSettingsProblems(settings)] };
}

/** Whether two sets of numbers are the same. */
export function sameSettings(a: AutoTopUpSettings, b: AutoTopUpSettings): boolean {
  return (
    a.topUpUnderDays === b.topUpUnderDays &&
    a.topUpToDays === b.topUpToDays &&
    a.lookAheadDays === b.lookAheadDays &&
    a.marginPercent === b.marginPercent &&
    a.xdaiWarningWei === b.xdaiWarningWei &&
    a.dailyCeilingPlur === b.dailyCeilingPlur
  );
}

/** What the Auto top-up tab holds as typed, kept by the Funding page while another tab is shown. Null follows the saved. */
export interface AutoTopUpDraft {
  numbers: NumbersDraft | null;
}

/** What the tab starts with: the saved numbers. */
export const FIRST_AUTO_TOPUP_DRAFT: AutoTopUpDraft = { numbers: null };
