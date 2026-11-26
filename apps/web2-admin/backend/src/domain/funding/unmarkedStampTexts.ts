import { UNMARKED_STAMP_LAST_DAYS, type Notice, type UnmarkedStampLevel } from '@streaming-monorepo/web2-admin-common';

import { AUTO_TOPUP_NOTICE_TITLE_PREFIX, shortBatchId, timeLeftText, type StampName } from './autoTopUpTexts.js';

/**
 * The words of the stamps not on auto top-up (docs/architecture/funding.md, "Stamps not on auto top-up"): what the
 * Auto top-up tab and the notices say of each stamp, and the notice that tells of them. A stamp is named as a marked
 * one is, with the time it has left and what a person can do. Every name comes from the funding view, so nothing here
 * holds a secret: a notice names stamps, nodes and stages.
 */

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** A stamp as the words of a marked one name it: where the Stamps tab lists it, its batch and its node. */
function stampLine(stamp: StampName): string {
  return `${stamp.title} (batch ${shortBatchId(stamp.batchId)}, on ${stamp.nodeLabel})`;
}

/** An unmarked stamp under "Top up when under", or under 2 days: which one, its time left, and what a person can do. */
export function unmarkedStampLowText(input: {
  stamp: StampName;
  level: 'low' | 'last';
  ttlSeconds: number;
  topUpUnderDays: number;
}): string {
  const left = `${stampLine(input.stamp)} is not on auto top-up and has ${timeLeftText(input.ttlSeconds)} left`;
  if (input.level === 'last') {
    return (
      `${left}, under ${plural(UNMARKED_STAMP_LAST_DAYS, 'day')}. Top it up on the Stamps tab of the Funding page ` +
      'before it runs out, or mark it there for auto top-up.'
    );
  }
  return (
    `${left}, under the ${plural(input.topUpUnderDays, 'day')} of "Top up when under". Top it up on the Stamps tab ` +
    'of the Funding page, or mark it there for auto top-up.'
  );
}

/**
 * An unmarked stamp that expired, or that its node holds no more, while the manager still lists it: which one, and
 * what a person can do. A stage's batch and the catalogue batch take a Buy new; an archive stamp's recordings can be
 * archived again.
 */
export function unmarkedStampExpiredText(input: { stamp: StampName; archive: boolean }): string {
  const action = input.archive
    ? 'An expired stamp cannot be topped up: the recordings copied onto it read "Archive expired" on the Archive ' +
      'page, and each can be archived again onto another stamp.'
    : 'An expired batch cannot be topped up: buy a new one with Buy new on its row of the Stamps tab.';
  return (
    `${stampLine(input.stamp)} is not on auto top-up and expired, or its node holds it no more. ${action} ` +
    `Batch: ${input.stamp.batchId}.`
  );
}

/** An unmarked stamp that was running low and that the manager lists no more. */
export function unmarkedStampUnlistedText(stamp: StampName): string {
  return (
    `${stampLine(stamp)} is not on auto top-up and the manager lists it no more: it expired, its node holds it no ` +
    `more, or it was replaced or released. Batch: ${stamp.batchId}.`
  );
}

/** One stamp as the notice tells of it. */
export interface UnmarkedNoticeItem {
  level: UnmarkedStampLevel;
  /** Whether the notice tells of it for reaching its level, or lists it as one still under on the day's notice. */
  fresh: boolean;
  /** What the Auto top-up tab says of it, as this run worded it. */
  message: string;
}

function noticeTitle(items: readonly UnmarkedNoticeItem[]): string {
  const count = items.length;
  if (count === 1) {
    const item = items[0]!;
    if (item.level === 'expired') return 'a stamp not on auto top-up expired';
    if (!item.fresh) return 'a stamp not on auto top-up is still running low';
    return item.level === 'last'
      ? `a stamp not on auto top-up has under ${plural(UNMARKED_STAMP_LAST_DAYS, 'day')} left`
      : 'a stamp not on auto top-up is running low';
  }
  if (items.every((item) => item.level === 'expired')) return `${count} stamps not on auto top-up expired`;
  if (items.every((item) => !item.fresh)) return `${count} stamps not on auto top-up are still running low`;
  return items.some((item) => item.level === 'expired')
    ? `${count} stamps not on auto top-up are running low or expired`
    : `${count} stamps not on auto top-up are running low`;
}

/**
 * The notice of the stamps not on auto top-up that one run tells of, written from any of them, in their order: the
 * ones that reached a level, and on the day's notice every other one still under "Top up when under".
 */
export function unmarkedStampsNotice(items: readonly UnmarkedNoticeItem[]): Notice {
  const fresh = items.filter((item) => item.fresh);
  const still = items.filter((item) => !item.fresh);
  const list = (group: readonly UnmarkedNoticeItem[]) => group.map((item) => `- ${item.message}`);
  const lines = [
    items.length === 1
      ? 'The admin does not top this stamp up: it is not marked for auto top-up.'
      : 'The admin tops none of these stamps up: they are not marked for auto top-up.',
    '',
    ...(fresh.length > 0 && still.length > 0
      ? ['New:', ...list(fresh), '', 'Still under "Top up when under":', ...list(still)]
      : list(items)),
  ];
  if (items.some((item) => item.level !== 'expired')) {
    lines.push(
      '',
      'While a stamp stays under "Top up when under", a notice lists it once a day, and the Auto top-up tab of the ' +
        'Funding page lists it.',
    );
  }
  return {
    title: `${AUTO_TOPUP_NOTICE_TITLE_PREFIX}: ${noticeTitle(items)}`,
    text: `${lines.join('\n')}\n`,
  };
}
