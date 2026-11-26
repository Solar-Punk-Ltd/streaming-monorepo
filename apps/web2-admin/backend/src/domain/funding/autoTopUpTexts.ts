import {
  AUTO_TOPUP_MONTH_DAYS,
  SECONDS_PER_DAY,
  XBZZ_DECIMALS,
  XDAI_DECIMALS,
  formatBaseUnits,
} from '@streaming-monorepo/web2-admin-common';
import type { Notice } from '@streaming-monorepo/web2-admin-common';

/**
 * The words of stamp auto top-up: the warnings as the Auto top-up tab and the notices show them, and the notices
 * themselves, one kind each, as docs/architecture/funding.md's "Notices and warnings" lists them. Every name and
 * amount comes from the funding view. Nothing here holds a secret, a stream key or a password: a notice names stamps,
 * nodes, public wallet addresses and amounts.
 */

/** What every notice's title starts with. */
export const AUTO_TOPUP_NOTICE_TITLE_PREFIX = 'Stamp auto top-up';

/** `1.5 xBZZ`, from PLUR. */
export function xbzzText(plur: string): string {
  return `${formatBaseUnits(plur, XBZZ_DECIMALS)} xBZZ`;
}

/** `0.01 xDAI`, from wei. */
export function xdaiText(wei: string): string {
  return `${formatBaseUnits(wei, XDAI_DECIMALS)} xDAI`;
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** `6 days 22 hours`, `5 hours`, `under an hour`: a time left, to the hour, rounded down. */
export function timeLeftText(seconds: number): string {
  if (seconds <= 0) return 'none';
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / 3600);
  if (days === 0 && hours === 0) return 'under an hour';
  if (days === 0) return plural(hours, 'hour');
  return hours === 0 ? plural(days, 'day') : `${plural(days, 'day')} ${plural(hours, 'hour')}`;
}

/** `2026-11-25 14:10 UTC`: a moment as every notice writes it. */
export function momentText(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `0x1234abcd…`: a batch as a list names it. The notices about one stamp give the whole id as well. */
export function shortBatchId(batchId: string): string {
  return `${batchId.slice(0, 10)}…`;
}

/** A marked stamp as the words name it: where it is listed on the Stamps tab, and its batch. */
export interface StampName {
  /** `0x` and 64 hex digits. */
  batchId: string;
  /** What the Stamps tab calls it: `the catalogue batch`, `Main stage, 720p`, `archive stamp "Keynotes"`. */
  title: string;
  /** The label of the node that holds it and pays for its top-ups. */
  nodeLabel: string;
}

function stampLine(stamp: StampName): string {
  return `${stamp.title} (batch ${shortBatchId(stamp.batchId)}, on ${stamp.nodeLabel})`;
}

// --- The warnings ---------------------------------------------------------------------------------------------------

/**
 * The brand wallet's xBZZ is under a month of top-ups for the marked stamps: the balance, the estimate, the gap, how
 * many days of top-ups the balance covers, and where to send xBZZ.
 */
export function walletXbzzWarningText(input: {
  balancePlur: string;
  monthlyEstimatePlur: string;
  walletAddress: string;
}): string {
  const balance = BigInt(input.balancePlur);
  const estimate = BigInt(input.monthlyEstimatePlur);
  const gap = estimate > balance ? estimate - balance : 0n;
  const days = estimate === 0n ? AUTO_TOPUP_MONTH_DAYS : Number((balance * BigInt(AUTO_TOPUP_MONTH_DAYS)) / estimate);
  return (
    `The brand wallet holds ${xbzzText(input.balancePlur)}, under the ${xbzzText(input.monthlyEstimatePlur)} that ` +
    `${AUTO_TOPUP_MONTH_DAYS} days of top-ups for the marked stamps cost at today's price, ${xbzzText(gap.toString())} ` +
    `short. It covers about ${plural(days, 'day')} of top-ups. Send xBZZ to the brand wallet, ${input.walletAddress}, ` +
    'on Gnosis Chain.'
  );
}

/** The brand wallet's xDAI is under the xDAI warning: the balance, the threshold and where to send xDAI. */
export function walletXdaiWarningText(input: {
  balanceWei: string;
  thresholdWei: string;
  walletAddress: string;
}): string {
  return (
    `The brand wallet holds ${xdaiText(input.balanceWei)}, under the ${xdaiText(input.thresholdWei)} of the xDAI ` +
    'warning. It pays the gas of every send to the nodes, and a send it cannot pay for is not made. Send xDAI to the ' +
    `brand wallet, ${input.walletAddress}, on Gnosis Chain.`
  );
}

/** A due marked stamp could not be topped up: the stamp, its time left, the reason, and what a person can do. */
export function topUpFailedWarningText(input: {
  stamp: StampName;
  /** Null when its node could not be read. */
  ttlSeconds: number | null;
  /** Why, in a sentence. */
  reason: string;
  /** What a person can do, in a sentence. */
  action: string;
}): string {
  const left =
    input.ttlSeconds === null ? 'Its time left could not be read' : `It has ${timeLeftText(input.ttlSeconds)} left`;
  return `${stampLine(input.stamp)} could not be topped up. ${left}. ${input.reason} ${input.action}`;
}

/** A marked stamp expired, or its node holds it no more: which one, and that it takes a Buy new. */
export function stampExpiredWarningText(stamp: StampName): string {
  return (
    `${stampLine(stamp)} expired, or its node holds it no more, and an expired batch cannot be topped up. Buy a new ` +
    `batch with Buy new on its row of the Stamps tab, and mark the new one. Batch: ${stamp.batchId}.`
  );
}

// --- The notices ----------------------------------------------------------------------------------------------------

/** One coming top-up, as the "top-ups coming up" notice lists it. */
export interface ComingTopUpText {
  stamp: StampName;
  ttlSeconds: number;
  /** When it falls due, or fell due. */
  dueAt: Date;
  due: boolean;
  days: number;
  costPlur: string;
  costWithMarginPlur: string;
}

/** What the brand wallet will send a node for its coming top-ups, and when. */
export interface ComingNodeText {
  nodeLabel: string;
  walletAddress: string | null;
  xbzzPlur: string | null;
  xdaiWei: string | null;
  /** The xBZZ the brand wallet sends it: `0` when it holds enough. */
  sendPlur: string;
  /** The xDAI the brand wallet sends it for gas, or null when it holds enough. */
  gasSendWei: string | null;
  /**
   * When the send goes: `at` the earliest moment, `now` at once because a stamp has under two look-aheads left, or
   * why none goes by itself.
   */
  when:
    | { kind: 'at'; at: Date }
    | { kind: 'now' }
    | { kind: 'paused' }
    | { kind: 'unconfirmed' }
    | { kind: 'not_sendable' };
}

function nodeHoldsText(node: ComingNodeText): string {
  const xbzz = node.xbzzPlur === null ? 'an unread amount of xBZZ' : xbzzText(node.xbzzPlur);
  const xdai = node.xdaiWei === null ? 'an unread amount of xDAI' : xdaiText(node.xdaiWei);
  return `${xbzz} and ${xdai}`;
}

function nodeSendText(node: ComingNodeText, lookAheadDays: number): string {
  const parts = [
    ...(BigInt(node.sendPlur) > 0n ? [xbzzText(node.sendPlur)] : []),
    ...(node.gasSendWei !== null ? [`${xdaiText(node.gasSendWei)} for gas`] : []),
  ];
  if (parts.length === 0) return 'It holds enough: the brand wallet sends it nothing.';
  const what = parts.join(' and ');
  switch (node.when.kind) {
    case 'at':
      return `The brand wallet sends it ${what} at ${momentText(node.when.at)} at the earliest.`;
    case 'now':
      return (
        `The brand wallet sends it ${what} without waiting ${plural(lookAheadDays, 'day')} after this notice, since a ` +
        `stamp of it has under ${plural(lookAheadDays * 2, 'day')} left.`
      );
    case 'paused':
      return `It lacks ${what}, and the wallet job is paused: fund it on the Balance tab, or resume the wallet job.`;
    case 'unconfirmed':
      return (
        `It lacks ${what}, and the brand wallet sends nothing to it until a person confirms its address on the ` +
        'Balance tab.'
      );
    case 'not_sendable':
      return `It lacks ${what}, and the brand wallet does not send to it: fund it by hand.`;
  }
}

/**
 * "Top-ups coming up": each stamp's node, time left, days to add, cost and cost plus the margin; what each node holds
 * and what the brand wallet will send it, and when; the brand wallet's balance and whether it covers the sends.
 */
export function comingNotice(input: {
  topUps: readonly ComingTopUpText[];
  nodes: readonly ComingNodeText[];
  marginPercent: number;
  lookAheadDays: number;
  brandWallet: { address: string; xbzzPlur: string | null; xdaiWei: string | null } | null;
}): Notice {
  const count = input.topUps.length;
  const lines: string[] = [
    `${plural(count, 'top-up')} of marked stamps ${count === 1 ? 'is' : 'are'} coming up. Each is paid by the node ` +
      'that holds the stamp. A person can unmark a stamp, pause a job or fund a node by hand on the Funding page before ' +
      'then.',
    '',
    'The top-ups:',
  ];
  for (const topUp of input.topUps) {
    const due = topUp.due ? 'due now' : `due ${momentText(topUp.dueAt)}`;
    lines.push(
      `- ${stampLine(topUp.stamp)}: ${timeLeftText(topUp.ttlSeconds)} left, ${due}. Adds ${plural(topUp.days, 'day')} ` +
        `for ${xbzzText(topUp.costPlur)}, ${xbzzText(topUp.costWithMarginPlur)} with the ${input.marginPercent}% margin.`,
    );
  }
  lines.push('', 'The nodes:');
  for (const node of input.nodes) {
    lines.push(`- ${node.nodeLabel} holds ${nodeHoldsText(node)}. ${nodeSendText(node, input.lookAheadDays)}`);
  }
  const sendTotal = input.nodes.reduce((sum, node) => sum + BigInt(node.sendPlur), 0n);
  const gasTotal = input.nodes.reduce((sum, node) => sum + BigInt(node.gasSendWei ?? '0'), 0n);
  lines.push('');
  if (input.brandWallet === null) {
    lines.push('There is no brand wallet: the nodes must be funded by hand.');
  } else if (input.brandWallet.xbzzPlur === null || input.brandWallet.xdaiWei === null) {
    lines.push(`The brand wallet, ${input.brandWallet.address}, could not be read.`);
  } else {
    const covers = BigInt(input.brandWallet.xbzzPlur) >= sendTotal && BigInt(input.brandWallet.xdaiWei) >= gasTotal;
    lines.push(
      `The brand wallet, ${input.brandWallet.address}, holds ${xbzzText(input.brandWallet.xbzzPlur)} and ` +
        `${xdaiText(input.brandWallet.xdaiWei)}. The sends above come to ${xbzzText(sendTotal.toString())} and ` +
        `${xdaiText(gasTotal.toString())}, besides the gas of the send. ` +
        (covers ? 'It covers them.' : 'It does not cover them: send it the rest.'),
    );
  }
  return {
    title: `${AUTO_TOPUP_NOTICE_TITLE_PREFIX}: ${plural(count, 'top-up')} coming up`,
    text: `${lines.join('\n')}\n`,
  };
}

/** The title words of each warning kind, as one warning's first notice names it. */
const WARNING_TITLES = {
  wallet_xbzz: 'the brand wallet is low on xBZZ',
  wallet_xdai: 'the brand wallet is low on xDAI',
  topup_failed: 'a top-up failed',
  stamp_expired: 'a marked stamp expired',
} as const;

/** A warning as a notice carries it. */
export interface WarningNoticeItem {
  kind: keyof typeof WARNING_TITLES;
  message: string;
  since: Date;
}

/**
 * The first notice of warnings raised since the last run: one warning's own title, or a count when several were raised
 * at once.
 */
export function newWarningsNotice(warnings: readonly WarningNoticeItem[]): Notice {
  const title = warnings.length === 1 ? WARNING_TITLES[warnings[0]!.kind] : `${warnings.length} new warnings`;
  const lines = warnings.map((warning) => `- ${warning.message}`);
  return {
    title: `${AUTO_TOPUP_NOTICE_TITLE_PREFIX}: ${title}`,
    text: `${lines.join('\n\n')}\n\nThe Auto top-up tab of the Funding page shows every warning that stands.\n`,
  };
}

/** The daily notice of the warnings still standing, each with the moment it was first seen. */
export function standingWarningsNotice(warnings: readonly WarningNoticeItem[]): Notice {
  const lines = warnings.map((warning) => `- Since ${momentText(warning.since)}: ${warning.message}`);
  return {
    title: `${AUTO_TOPUP_NOTICE_TITLE_PREFIX}: ${plural(warnings.length, 'warning')} still standing`,
    text:
      `${warnings.length === 1 ? 'This warning still stands' : 'These warnings still stand'}. This notice goes once a ` +
      `day while one does.\n\n${lines.join('\n\n')}\n`,
  };
}
