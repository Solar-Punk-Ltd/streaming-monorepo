/**
 * The alert job of stamp auto top-up: the alerts it records and clears, the "top-ups coming up" notice and its
 * once-a-day rule, the warnings it raises, words anew, clears and sends notices of, the waiting notices it has tried
 * again, and a notice no destination took. Unit test over a store in memory and a notifier that records what it is handed,
 * and once over the notification dispatcher with fake channels. `pnpm test`.
 *
 * Addresses are fixtures the leak gate allows (`scripts/public-leaks/allow.json`).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  AUTO_TOPUP_DEFAULTS,
  SECONDS_PER_DAY,
  autoTopUpStampPlan,
  type AutoTopUpSettings,
  type FundingPostage,
  type Notice,
  type NoticeTopic,
} from '@streaming-monorepo/web2-admin-common';

import type { FundingBatch, FundingInventory, FundingNode } from '@streaming-monorepo/contracts';
import { NotificationSendError, type DestinationChannelFactory } from '@streaming-monorepo/notifications';

import {
  AutoTopUpAlertJob,
  alertJobInputOf,
  alertReadingOf,
  type AlertJobInput,
  type AlertStampNode,
  type AlertStampReading,
} from '../../src/domain/funding/AutoTopUpAlertJob.js';
import {
  autoTopUpComingSubject,
  autoTopUpWarningSubject,
  type AutoTopUpAlert,
  type AutoTopUpWarningKey,
  type AutoTopUpWarningRow,
} from '../../src/domain/funding/StampAutoTopUpStore.js';
import type { NotifyOutcome, Notifier, OutgoingNotice, RetryOutcome } from '../../src/domain/notifications/Notifier.js';

import { markedStampsOf, type AutoTopUpTickContext } from '../../src/domain/funding/autoTopUpJobs.js';
import { NoticeDispatcher } from '../../src/domain/notifications/NoticeDispatcher.js';
import { channelSecretKeyFrom, sealChannelSecret } from '../../src/domain/notifications/channelSecrets.js';

import { InMemoryStampAutoTopUpStore } from './support/autoTopUpFakes.js';
import { InMemoryNoticeStore } from './support/notificationFakes.js';
import {
  BATCH_CATALOGUE,
  BATCH_STAGE,
  NODE_A,
  NODE_CATALOGUE,
  WALLET_A as FAKE_WALLET_A,
  fundingBatch,
  stampInventory,
} from './support/fundingFakes.js';

const DAY = SECONDS_PER_DAY;
const HOUR = 3600;
const XBZZ = 10n ** 16n;
const XDAI = 10n ** 18n;

const BRAND = '0x1234567890123456789012345678901234567890';
const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';
const BATCH_1 = `0x${'b1'.repeat(32)}`;
const BATCH_2 = `0x${'c2'.repeat(32)}`;
const BATCH_3 = `0x${'d3'.repeat(32)}`;

/** 24000 PLUR a chunk a block, 5-second blocks: 7 days of a depth-20 batch cost about 0.3 xBZZ. */
const POSTAGE: FundingPostage = { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17_280 };

const T0 = new Date('2026-11-24T12:00:00.000Z');

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

/** A notice as a destination took it: written from all its parts, with when it was raised and what it tells of. */
interface TakenNotice extends Notice {
  raisedAt: Date;
  subjects: string[];
}

/**
 * A notifier with one person, who gets every topic on one destination. It records each notice that destination takes,
 * fails while `failWith` is set, and has nobody to send to while `isOn` is false. It records each call to try the
 * waiting notices again, with what stood then.
 */
class RecordingNotifier implements Notifier {
  isOn = true;
  failWith: string | null = null;
  sent: TakenNotice[] = [];
  retries: { now: Date; stands: (subject: string) => boolean }[] = [];
  async on(): Promise<boolean> {
    return this.isOn;
  }
  async notify<T>(notice: OutgoingNotice<T>): Promise<NotifyOutcome> {
    const outcome = (people: number, sent: number, failed: number): NotifyOutcome => ({
      parts: notice.parts.map((part) => ({ subject: part.subject, people, taken: sent > 0 })),
      sent,
      failed,
    });
    if (!this.isOn) return outcome(0, 0, 0);
    if (this.failWith !== null) return outcome(1, 0, 1);
    this.sent.push({
      ...notice.compose(notice.parts),
      raisedAt: notice.raisedAt,
      subjects: notice.parts.map((part) => part.subject),
    });
    return outcome(1, 1, 0);
  }
  async retryWaiting(now: Date, stands: (subject: string) => boolean): Promise<RetryOutcome> {
    this.retries.push({ now, stands });
    return { sent: 0, dropped: 0, waiting: 0 };
  }
}

const silent = { info: () => undefined, warn: () => undefined };

function node(
  nodeId: string,
  walletAddress: string,
  xbzz: bigint,
  xdai: bigint,
  pin: AlertStampNode['pin'] = 'pinned',
): AlertStampNode {
  return { nodeId, label: `${nodeId} label`, walletAddress, xbzzPlur: xbzz.toString(), xdaiWei: xdai.toString(), pin };
}

function stampName(batchId: string, nodeLabel = 'node-a label') {
  return { batchId, title: `Stage ${batchId.slice(2, 4)}`, nodeLabel };
}

function operable(batchId: string, ttlSeconds: number, holder: AlertStampNode, depth = 20): AlertStampReading {
  return { state: 'operable', name: stampName(batchId, holder.label), depth, ttlSeconds, node: holder };
}

function unreadOf(batchId: string): AlertStampReading {
  return { state: 'unread', name: stampName(batchId), ttlSeconds: null, reason: 'Its node could not be read.' };
}

function plan(ttlSeconds: number, settings: AutoTopUpSettings = AUTO_TOPUP_DEFAULTS, depth = 20) {
  return autoTopUpStampPlan({ depth, ttlSeconds }, settings, POSTAGE);
}

/** The defaults, a rich brand wallet, and these readings. */
function input(
  readings: Record<string, AlertStampReading>,
  now: Date,
  extra: Partial<AlertJobInput> = {},
): AlertJobInput {
  return {
    now,
    settings: AUTO_TOPUP_DEFAULTS,
    postage: POSTAGE,
    brandWallet: { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: XDAI.toString() },
    walletJobPaused: false,
    readings: new Map(Object.entries(readings)),
    estimateDepths: Object.values(readings).flatMap((reading) => (reading.state === 'operable' ? [reading.depth] : [])),
    ...extra,
  };
}

const RICH = node('node-a', WALLET_A, 100n * XBZZ, XDAI);

let store: InMemoryStampAutoTopUpStore;
let notifier: RecordingNotifier;
let job: AutoTopUpAlertJob;

/** One run over these readings, for the marks the store holds. */
async function run(given: AlertJobInput) {
  return job.runReadings(given, await store.marks());
}

function alertOf(batchId: string): AutoTopUpAlert | null {
  return store.markRows.get(batchId)?.alert ?? null;
}

function warningOf(kind: AutoTopUpWarningKey['kind'], batchId: string | null = null): AutoTopUpWarningRow | undefined {
  return store.warningRows.find((row) => row.kind === kind && row.batchId === batchId);
}

beforeEach(async () => {
  store = new InMemoryStampAutoTopUpStore();
  notifier = new RecordingNotifier();
  job = new AutoTopUpAlertJob(store, notifier, silent);
  await store.mark(
    [
      { batchId: BATCH_1, nodeId: 'node-a', nodeLabel: 'node-a label' },
      { batchId: BATCH_2, nodeId: 'node-a', nodeLabel: 'node-a label' },
    ],
    'operator',
    T0,
  );
});

describe('the alert job records an alert', () => {
  it('for a stamp within two look-aheads of the threshold, and sends nothing until one turns upcoming', async () => {
    const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 8.5 * DAY, RICH) }, T0));
    const expected = plan(8.5 * DAY);
    assert.deepEqual(alertOf(BATCH_1), {
      days: 7,
      costPlur: expected.costPlur,
      costWithMarginPlur: expected.costWithMarginPlur,
      sendPlur: '0',
      gasSend: false,
      recordedAt: T0,
      alertedAt: null,
    });
    assert.equal(notifier.sent.length, 0);
    assert.equal(outcome.ok, true);
    assert.match(outcome.outcome, /^1 of 2 marked stamps has a top-up coming, 1 alert recorded/);
  });

  it('sends "top-ups coming up" when one turns upcoming, listing every listed one, and counts them given', async () => {
    await run(
      input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 8.5 * DAY, RICH) }, T0),
    );
    assert.equal(notifier.sent.length, 1);
    const notice = notifier.sent[0]!;
    assert.equal(notice.title, 'Stamp auto top-up: 2 top-ups coming up');
    assert.deepEqual(notice.subjects, [autoTopUpComingSubject(BATCH_1), autoTopUpComingSubject(BATCH_2)]);
    assert.equal(notice.raisedAt, T0);
    assert.match(
      notice.text,
      /Stage b1 \(batch 0xb1b1b1b1…, on node-a label\): 7 days 12 hours left, due 2026-11-25 00:00 UTC\. Adds 7 days/,
    );
    assert.match(notice.text, /Stage c2 .*: 8 days 12 hours left/);
    assert.match(
      notice.text,
      /node-a label holds 100 xBZZ and 1 xDAI\. It holds enough: the brand wallet sends it nothing\./,
    );
    assert.match(
      notice.text,
      /The brand wallet, 0x1234567890123456789012345678901234567890, holds 100 xBZZ and 1 xDAI/,
    );
    assert.match(notice.text, /It covers them\./);
    assert.equal(alertOf(BATCH_1)?.alertedAt, T0);
    assert.equal(alertOf(BATCH_2)?.alertedAt, T0);
    assert.equal(store.noticesRow.lastComingAt, T0);
  });

  it('sends that notice at most once a day, and lists in the next one what the last one did not', async () => {
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    await run(
      input(
        { [BATCH_1]: operable(BATCH_1, 7.25 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 7.6 * DAY, RICH) },
        at(6 * HOUR),
      ),
    );
    assert.equal(notifier.sent.length, 1);
    assert.equal(alertOf(BATCH_2)?.alertedAt, null);
    await run(
      input({ [BATCH_1]: operable(BATCH_1, 6.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 6.6 * DAY, RICH) }, at(DAY)),
    );
    assert.equal(notifier.sent.length, 2);
    assert.equal(notifier.sent[1]!.title, 'Stamp auto top-up: 1 top-up coming up');
    assert.match(notifier.sent[1]!.text, /Stage c2/);
    assert.doesNotMatch(notifier.sent[1]!.text, /Stage b1/);
    assert.equal(alertOf(BATCH_2)?.alertedAt?.getTime(), at(DAY).getTime());
  });

  it('with nobody to get the notices, counts an alert given when it is recorded, and sends nothing', async () => {
    notifier.isOn = false;
    const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    assert.equal(notifier.sent.length, 0);
    assert.equal(alertOf(BATCH_1)?.alertedAt, T0);
    assert.equal(outcome.ok, true);
    assert.match(outcome.outcome, /nobody gets the notices/);
  });

  it('names what the brand wallet sends a short node, and when', async () => {
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, node('node-a', WALLET_A, 0n, 0n)) }, T0));
    const alert = alertOf(BATCH_1)!;
    assert.equal(alert.sendPlur, plan(7.5 * DAY).costWithMarginPlur);
    assert.equal(alert.gasSend, true);
    assert.match(
      notifier.sent[0]!.text,
      /The brand wallet sends it [\d.]+ xBZZ and 0\.01 xDAI for gas at 2026-11-25 12:00 UTC at the earliest/,
    );
  });

  it('says a send goes without waiting when a stamp has under two look-aheads left', async () => {
    await run(input({ [BATCH_1]: operable(BATCH_1, 1.5 * DAY, node('node-a', WALLET_A, 0n, XDAI)) }, T0));
    assert.match(
      notifier.sent[0]!.text,
      /without waiting 1 day after this notice, since a stamp of it has under 2 days left/,
    );
  });

  it('says the wallet job is paused, or that the node waits for its address to be confirmed', async () => {
    const short = node('node-a', WALLET_A, 0n, XDAI);
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, short) }, T0, { walletJobPaused: true }));
    assert.match(notifier.sent[0]!.text, /the wallet job is paused: fund it on the Balance tab/);
    store.noticesRow.lastComingAt = null;
    await store.setAlert(BATCH_1, null);
    const unconfirmed = node('node-a', WALLET_A, 0n, XDAI, 'changed');
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, unconfirmed) }, at(HOUR)));
    assert.match(notifier.sent[1]!.text, /until a person confirms its address on the Balance tab/);
  });

  it('records a new alert, to be given afresh, when the node lacks more than the alert said', async () => {
    const short = node('node-a', WALLET_A, 0n, XDAI);
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, short) }, T0));
    const first = alertOf(BATCH_1)!;
    const dearer = { ...POSTAGE, pricePerChunkPerBlockPlur: '30000' };
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.25 * DAY, short) }, at(6 * HOUR), { postage: dearer }));
    const second = alertOf(BATCH_1)!;
    assert.ok(BigInt(second.sendPlur) > BigInt(first.sendPlur));
    assert.equal(second.recordedAt.getTime(), at(6 * HOUR).getTime());
    assert.equal(second.alertedAt, null);
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.2 * DAY, short) }, at(7 * HOUR), { postage: dearer }));
    assert.deepEqual(alertOf(BATCH_1), second, 'a lack within what the alert said keeps it');
  });

  it('clears the alert of a stamp healthy again, and of one that expired', async () => {
    await run(
      input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 7.5 * DAY, RICH) }, T0),
    );
    await run(
      input(
        { [BATCH_1]: operable(BATCH_1, 14 * DAY, RICH), [BATCH_2]: { state: 'expired', name: stampName(BATCH_2) } },
        at(HOUR),
      ),
    );
    assert.equal(alertOf(BATCH_1), null);
    assert.equal(alertOf(BATCH_2), null);
  });

  it('leaves the alert of a stamp it could not read, or one waiting to be usable', async () => {
    await run(
      input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 7.5 * DAY, RICH) }, T0),
    );
    const alerts = [alertOf(BATCH_1), alertOf(BATCH_2)];
    await run(
      input({ [BATCH_1]: unreadOf(BATCH_1), [BATCH_2]: { state: 'waiting', name: stampName(BATCH_2) } }, at(HOUR)),
    );
    assert.deepEqual([alertOf(BATCH_1), alertOf(BATCH_2)], alerts);
  });
});

describe('the alert job keeps the warnings', () => {
  it('raises the brand wallet low on xBZZ under the monthly estimate, sends its notice at once, clears it once covered', async () => {
    const poor = { address: BRAND, xbzzPlur: XBZZ.toString(), xdaiWei: XDAI.toString() };
    await run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, T0, { brandWallet: poor }));
    const warning = warningOf('wallet_xbzz')!;
    assert.match(warning.message, /^The brand wallet holds 1 xBZZ, under the [\d.]+ xBZZ that 30 days of top-ups/);
    assert.match(warning.message, /It covers about \d+ days of top-ups\. Send xBZZ to the brand wallet, 0x1234/);
    assert.equal(notifier.sent.length, 1);
    assert.equal(notifier.sent[0]!.title, 'Stamp auto top-up: the brand wallet is low on xBZZ');
    assert.deepEqual(notifier.sent[0]!.subjects, [autoTopUpWarningSubject({ kind: 'wallet_xbzz', batchId: null })]);
    assert.equal(warning.notifiedAt, T0);
    await run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, at(HOUR)));
    assert.equal(warningOf('wallet_xbzz'), undefined);
  });

  it('raises the brand wallet low on xDAI under the threshold', async () => {
    const dry = { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: (XDAI / 20n).toString() };
    await run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, T0, { brandWallet: dry }));
    assert.match(warningOf('wallet_xdai')!.message, /^The brand wallet holds 0\.05 xDAI, under the 0\.1 xDAI/);
  });

  it('keeps a wallet warning as it stands while the balance could not be read', async () => {
    const dry = { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: (XDAI / 20n).toString() };
    await run(input({}, T0, { brandWallet: dry }));
    await run(input({}, at(HOUR), { brandWallet: { address: BRAND, xbzzPlur: null, xdaiWei: null } }));
    assert.ok(warningOf('wallet_xdai'));
  });

  it('sends the standing warnings again together once a day', async () => {
    const dry = { address: BRAND, xbzzPlur: XBZZ.toString(), xdaiWei: (XDAI / 20n).toString() };
    const readings = { [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) };
    await run(input(readings, T0, { brandWallet: dry }));
    assert.equal(notifier.sent.length, 1);
    assert.equal(notifier.sent[0]!.title, 'Stamp auto top-up: 2 new warnings');
    await run(input(readings, at(12 * HOUR), { brandWallet: dry }));
    assert.equal(notifier.sent.length, 1, 'no repeat within a day');
    await run(input(readings, at(DAY), { brandWallet: dry }));
    assert.equal(notifier.sent.length, 2);
    const repeat = notifier.sent[1]!;
    assert.equal(repeat.title, 'Stamp auto top-up: 2 warnings still standing');
    assert.match(repeat.text, /^These warnings still stand\. This notice goes once a day while one does\./);
    assert.match(repeat.text, /- Since 2026-11-24 12:00 UTC: The brand wallet holds 0\.05 xDAI/);
    assert.equal(store.noticesRow.lastRepeatAt?.getTime(), at(DAY).getTime());
    await run(input(readings, at(DAY + HOUR), { brandWallet: dry }));
    assert.equal(notifier.sent.length, 2);
  });

  it('raises a marked stamp that expired, sends its notice once and never again, and clears it once it reads again', async () => {
    const expired: AlertStampReading = { state: 'expired', name: stampName(BATCH_1) };
    await run(input({ [BATCH_1]: expired }, T0));
    assert.match(
      warningOf('stamp_expired', BATCH_1)!.message,
      /expired, or its node holds it no more.*Buy new.*Batch: 0xb1b1/,
    );
    assert.equal(notifier.sent[0]!.title, 'Stamp auto top-up: a marked stamp expired');
    await run(input({ [BATCH_1]: expired }, at(2 * DAY)));
    assert.equal(notifier.sent.length, 1);
    await run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, at(3 * DAY)));
    assert.equal(warningOf('stamp_expired', BATCH_1), undefined);
  });

  it('raises a failed top-up for a stamp with a top-up coming whose node is unread for an hour', async () => {
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    await run(input({ [BATCH_1]: unreadOf(BATCH_1) }, at(10 * 60)));
    assert.equal(store.markRows.get(BATCH_1)!.unreadSince?.getTime(), at(10 * 60).getTime());
    assert.equal(warningOf('topup_failed', BATCH_1), undefined, 'not within the hour');
    await run(input({ [BATCH_1]: unreadOf(BATCH_1) }, at(70 * 60)));
    assert.match(
      warningOf('topup_failed', BATCH_1)!.message,
      /could not be topped up\. Its time left could not be read\. Its node could not be read\. It has been so for an hour or more\./,
    );
    await run(input({ [BATCH_1]: operable(BATCH_1, 14 * DAY, RICH) }, at(80 * 60)));
    assert.equal(store.markRows.get(BATCH_1)!.unreadSince, null);
    assert.equal(warningOf('topup_failed', BATCH_1), undefined, 'cleared once it is no longer due');
  });

  it('raises a failed top-up for a due stamp on a short node an hour after it fell due, with the wallet job paused', async () => {
    const short = node('node-a', WALLET_A, 0n, XDAI);
    await run(input({ [BATCH_1]: operable(BATCH_1, 7 * DAY - 30 * 60, short) }, T0, { walletJobPaused: true }));
    assert.equal(warningOf('topup_failed', BATCH_1), undefined);
    await run(input({ [BATCH_1]: operable(BATCH_1, 7 * DAY - 61 * 60, short) }, at(HOUR), { walletJobPaused: true }));
    assert.match(
      warningOf('topup_failed', BATCH_1)!.message,
      /It has 6 days 22 hours left\. Its node is short of xBZZ for the top-up, and the wallet job is paused\. Fund the node/,
    );
  });

  it('clears a failed top-up another job raised once the stamp is topped up', async () => {
    await store.raiseWarning({ kind: 'topup_failed', batchId: BATCH_1 }, 'The operation failed.', T0);
    await run(input({ [BATCH_1]: operable(BATCH_1, 6.5 * DAY, RICH) }, at(HOUR)));
    assert.ok(warningOf('topup_failed', BATCH_1), 'stands while the stamp is due');
    await run(input({ [BATCH_1]: operable(BATCH_1, 14 * DAY, RICH) }, at(2 * HOUR)));
    assert.equal(warningOf('topup_failed', BATCH_1), undefined);
  });
});

describe('a notice no destination took', () => {
  it('leaves the alert not given and sends it again at the next run, whose day counts from then', async () => {
    notifier.failWith = 'The email service answered 401: unauthorised.';
    const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    assert.equal(outcome.ok, false);
    assert.match(
      outcome.outcome,
      /No destination took the notice "Stamp auto top-up: 1 top-up coming up": 1 destination could not take it/,
    );
    assert.ok(alertOf(BATCH_1) !== null, 'the alert is recorded all the same');
    assert.equal(alertOf(BATCH_1)?.alertedAt, null);
    assert.equal(store.noticesRow.lastComingAt, null);

    notifier.failWith = null;
    const retried = await run(input({ [BATCH_1]: operable(BATCH_1, 7.4 * DAY, RICH) }, at(10 * 60)));
    assert.equal(retried.ok, true);
    assert.equal(notifier.sent.length, 1);
    assert.equal(notifier.sent[0]!.raisedAt.getTime(), at(10 * 60).getTime());
    assert.equal(alertOf(BATCH_1)?.alertedAt?.getTime(), at(10 * 60).getTime());
    assert.equal((await store.notices()).lastComingAt?.getTime(), at(10 * 60).getTime());
  });

  it('leaves a new warning not notified, and sends it at the next run', async () => {
    notifier.failWith = 'The telegram service answered 400: chat not found.';
    const dry = { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: (XDAI / 20n).toString() };
    await run(input({}, T0, { brandWallet: dry }));
    assert.equal(warningOf('wallet_xdai')?.notifiedAt, null);
    notifier.failWith = null;
    await run(input({}, at(10 * 60), { brandWallet: dry }));
    assert.equal(warningOf('wallet_xdai')?.notifiedAt?.getTime(), at(10 * 60).getTime());
    assert.equal(notifier.sent[0]!.title, 'Stamp auto top-up: the brand wallet is low on xDAI');
  });
});

/**
 * A notifier with one person for each topic in `people`, on one destination of their own; a topic not in it has
 * nobody. It records the notice each destination took, written from the parts of its topic, and the destination of a
 * topic in `failing` fails. A topic in `untickedLate` answers `on` with someone and then has nobody when the notice
 * goes, as when its last user unticks it between the two.
 */
class TopicNotifier implements Notifier {
  people = new Set<NoticeTopic>(['topups_coming', 'wallet_low', 'topup_failed', 'stamp_expired']);
  failing = new Set<NoticeTopic>();
  untickedLate = new Set<NoticeTopic>();
  sent: (TakenNotice & { topic: NoticeTopic })[] = [];
  handed: OutgoingNotice<unknown>[] = [];
  async on(topic: NoticeTopic): Promise<boolean> {
    return this.people.has(topic) || this.untickedLate.has(topic);
  }
  async notify<T>(notice: OutgoingNotice<T>): Promise<NotifyOutcome> {
    this.handed.push(notice as OutgoingNotice<unknown>);
    const taken = new Set<NoticeTopic>();
    let failed = 0;
    for (const topic of new Set(notice.parts.map((part) => part.topic))) {
      if (!this.people.has(topic)) continue;
      if (this.failing.has(topic)) {
        failed += 1;
        continue;
      }
      const parts = notice.parts.filter((part) => part.topic === topic);
      this.sent.push({
        ...notice.compose(parts),
        raisedAt: notice.raisedAt,
        subjects: parts.map((part) => part.subject),
        topic,
      });
      taken.add(topic);
    }
    return {
      parts: notice.parts.map((part) => ({
        subject: part.subject,
        people: this.people.has(part.topic) ? 1 : 0,
        taken: taken.has(part.topic),
      })),
      sent: taken.size,
      failed,
    };
  }
  async retryWaiting(): Promise<RetryOutcome> {
    return { sent: 0, dropped: 0, waiting: 0 };
  }
}

describe('the outcome read part by part', () => {
  let topics: TopicNotifier;
  const dry = { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: (XDAI / 20n).toString() };
  const expired: AlertStampReading = { state: 'expired', name: stampName(BATCH_2) };

  beforeEach(() => {
    topics = new TopicNotifier();
    job = new AutoTopUpAlertJob(store, topics, silent);
  });

  describe('the notice rule', () => {
    it('counts the day from the first destination that took the "Top-ups coming up" part', async () => {
      topics.failing.add('topups_coming');
      const failed = await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
      assert.equal(failed.ok, false);
      assert.equal(alertOf(BATCH_1)?.alertedAt, null, 'not given while no destination took it');

      topics.failing.clear();
      const taken = await run(input({ [BATCH_1]: operable(BATCH_1, 7.4 * DAY, RICH) }, at(10 * 60)));
      assert.equal(taken.ok, true);
      assert.equal(alertOf(BATCH_1)?.alertedAt?.getTime(), at(10 * 60).getTime());

      await run(
        input(
          { [BATCH_1]: operable(BATCH_1, 6.4 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 7.5 * DAY, RICH) },
          at(DAY + HOUR),
        ),
      );
      assert.equal(topics.sent.length, 2, 'the next day lists the new top-up');
      assert.equal(alertOf(BATCH_1)?.alertedAt?.getTime(), at(10 * 60).getTime(), 'a given alert keeps its day');
      assert.equal(alertOf(BATCH_2)?.alertedAt?.getTime(), at(DAY + HOUR).getTime());
    });

    it('while nobody gets "Top-ups coming up", counts the day from the alert showing on the tab', async () => {
      topics.people.delete('topups_coming');
      const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0, { brandWallet: dry }));
      assert.equal(alertOf(BATCH_1)?.alertedAt, T0);
      assert.deepEqual(
        topics.sent.map((sent) => sent.topic),
        ['wallet_low'],
        'the warning goes to whoever gets it, the top-up to nobody',
      );
      assert.equal(outcome.ok, true);
      assert.doesNotMatch(outcome.outcome, /nobody gets the notices/);
    });

    it('once every user unticked it, counts an alert not given yet from the tab', async () => {
      await run(input({ [BATCH_1]: operable(BATCH_1, 8.5 * DAY, RICH) }, T0));
      assert.equal(alertOf(BATCH_1)?.alertedAt, null, 'recorded, and not given while the stamp is healthy');

      topics.people.delete('topups_coming');
      const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, at(DAY)));
      assert.equal(alertOf(BATCH_1)?.alertedAt, T0, 'from when it was recorded and shown');
      assert.equal(topics.sent.length, 0);
      assert.equal(outcome.ok, true);
    });

    it('counts it from the tab too when the last user unticks it while the notice goes', async () => {
      topics.people.delete('topups_coming');
      topics.untickedLate.add('topups_coming');
      await run(input({ [BATCH_1]: operable(BATCH_1, 8.5 * DAY, RICH) }, T0));
      const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, at(HOUR)));
      assert.equal(topics.handed.length, 1, 'the notice was handed over');
      assert.equal(alertOf(BATCH_1)?.alertedAt, T0);
      assert.equal(store.noticesRow.lastComingAt, null);
      assert.equal(outcome.ok, true);
    });
  });

  it('writes a notice of coming top-ups from the parts it is handed', async () => {
    await run(
      input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 8.5 * DAY, RICH) }, T0),
    );
    const notice = topics.handed[0]!;
    assert.deepEqual(
      notice.parts.map((part) => [part.topic, part.subject]),
      [
        ['topups_coming', autoTopUpComingSubject(BATCH_1)],
        ['topups_coming', autoTopUpComingSubject(BATCH_2)],
      ],
    );
    const one = notice.compose([notice.parts[1]!]);
    assert.equal(one.title, 'Stamp auto top-up: 1 top-up coming up');
    assert.match(one.text, /Stage c2/);
    assert.doesNotMatch(one.text, /Stage b1/);
  });

  it('notifies a warning only where its part was taken, and a part nobody gets fails no run', async () => {
    topics.people = new Set(['wallet_low']);
    const outcome = await run(input({ [BATCH_2]: expired }, T0, { brandWallet: dry }));
    assert.equal(warningOf('wallet_xdai')?.notifiedAt, T0);
    assert.equal(warningOf('stamp_expired', BATCH_2)?.notifiedAt, null, 'nobody gets it, so it waits for someone');
    assert.deepEqual(
      topics.sent.map((sent) => sent.title),
      ['Stamp auto top-up: the brand wallet is low on xDAI'],
    );
    assert.equal(outcome.ok, true);
    assert.match(outcome.outcome, /Sent the notice of 1 new warning\./);

    topics.people.add('stamp_expired');
    await run(input({ [BATCH_2]: expired }, at(HOUR), { brandWallet: dry }));
    assert.equal(warningOf('stamp_expired', BATCH_2)?.notifiedAt?.getTime(), at(HOUR).getTime());
    assert.equal(topics.sent[1]!.title, 'Stamp auto top-up: a marked stamp expired', 'its first notice, once ticked');
  });

  it('fails the run for a part someone gets that no destination took, and keeps the parts taken', async () => {
    topics.failing.add('stamp_expired');
    const outcome = await run(input({ [BATCH_2]: expired }, T0, { brandWallet: dry }));
    assert.equal(warningOf('wallet_xdai')?.notifiedAt, T0);
    assert.equal(warningOf('stamp_expired', BATCH_2)?.notifiedAt, null);
    assert.equal(outcome.ok, false);
    assert.match(
      outcome.outcome,
      /Sent the notice of 1 new warning\. No destination took the notice "Stamp auto top-up: a marked stamp expired": 1 destination could not take it\./,
    );

    topics.failing.clear();
    const retried = await run(input({ [BATCH_2]: expired }, at(10 * 60), { brandWallet: dry }));
    assert.equal(retried.ok, true);
    assert.equal(warningOf('stamp_expired', BATCH_2)?.notifiedAt?.getTime(), at(10 * 60).getTime());
    assert.equal(topics.sent.at(-1)!.title, 'Stamp auto top-up: a marked stamp expired');
  });

  it('repeats the standing warnings part by part', async () => {
    topics.people.delete('topups_coming');
    await store.raiseWarning({ kind: 'topup_failed', batchId: BATCH_1 }, 'The operation failed.', T0);
    await run(input({ [BATCH_1]: operable(BATCH_1, 6.5 * DAY, RICH) }, T0, { brandWallet: dry }));
    assert.equal(warningOf('topup_failed', BATCH_1)?.notifiedAt, T0);
    assert.equal(warningOf('wallet_xdai')?.notifiedAt, T0);

    topics.failing.add('topup_failed');
    const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 5.5 * DAY, RICH) }, at(DAY), { brandWallet: dry }));
    assert.equal(warningOf('wallet_xdai')?.notifiedAt?.getTime(), at(DAY).getTime());
    assert.equal(warningOf('topup_failed', BATCH_1)?.notifiedAt, T0);
    assert.equal(store.noticesRow.lastRepeatAt?.getTime(), at(DAY).getTime());
    assert.equal(outcome.ok, false);
    assert.match(outcome.outcome, /No destination took the notice "Stamp auto top-up: 1 warning still standing"/);
  });

  it('sends a standing warning a repeat left out again with the next day repeat, not at the next run', async () => {
    topics.people.delete('topups_coming');
    const failed = { kind: 'topup_failed', batchId: BATCH_1 } as const;
    const walletLow = { kind: 'wallet_xdai', batchId: null } as const;
    await store.raiseWarning(failed, 'The operation failed.', T0);
    await run(input({ [BATCH_1]: operable(BATCH_1, 6.5 * DAY, RICH) }, T0, { brandWallet: dry }));

    topics.failing.add('topup_failed');
    const missed = await run(input({ [BATCH_1]: operable(BATCH_1, 5.5 * DAY, RICH) }, at(DAY), { brandWallet: dry }));
    assert.equal(warningOf('wallet_xdai')?.notifiedAt?.getTime(), at(DAY).getTime(), 'the part taken is notified');
    assert.equal(warningOf('topup_failed', BATCH_1)?.notifiedAt, T0, 'the part missed is not');
    assert.equal(store.noticesRow.lastRepeatAt?.getTime(), at(DAY).getTime());
    assert.equal(missed.ok, false);

    topics.failing.clear();
    const handed = topics.handed.length;
    const next = await run(
      input({ [BATCH_1]: operable(BATCH_1, 5.5 * DAY - 10 * 60, RICH) }, at(DAY + 10 * 60), { brandWallet: dry }),
    );
    assert.equal(topics.handed.length, handed, 'no repeat goes at the next run');
    assert.equal(warningOf('topup_failed', BATCH_1)?.notifiedAt, T0);
    assert.equal(next.ok, true);

    await run(input({ [BATCH_1]: operable(BATCH_1, 4.5 * DAY, RICH) }, at(2 * DAY), { brandWallet: dry }));
    const repeat = topics.handed.at(-1)!;
    assert.deepEqual(
      repeat.parts.map((part) => part.subject).sort(),
      [autoTopUpWarningSubject(failed), autoTopUpWarningSubject(walletLow)].sort(),
    );
    assert.equal(repeat.compose(repeat.parts).title, 'Stamp auto top-up: 2 warnings still standing');
    assert.equal(warningOf('topup_failed', BATCH_1)?.notifiedAt?.getTime(), at(2 * DAY).getTime());
    assert.equal(warningOf('wallet_xdai')?.notifiedAt?.getTime(), at(2 * DAY).getTime());
  });
});

describe('the waiting notices', () => {
  it('are tried again on each run, before any new notice, with what stands: warnings and recorded alerts', async () => {
    const dry = { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: (XDAI / 20n).toString() };
    const order: string[] = [];
    const notify = notifier.notify.bind(notifier);
    const retry = notifier.retryWaiting.bind(notifier);
    notifier.notify = async (notice) => {
      order.push('notify');
      return notify(notice);
    };
    notifier.retryWaiting = async (now, stands) => {
      order.push('retry');
      return retry(now, stands);
    };
    await run(
      input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 14 * DAY, RICH) }, T0, {
        brandWallet: dry,
      }),
    );
    assert.equal(order[0], 'retry');
    assert.deepEqual(order.slice(1), ['notify', 'notify']);
    const { now, stands } = notifier.retries[0]!;
    assert.equal(now, T0);
    assert.equal(stands(autoTopUpWarningSubject({ kind: 'wallet_xdai', batchId: null })), true);
    assert.equal(stands(autoTopUpWarningSubject({ kind: 'wallet_xbzz', batchId: null })), false);
    assert.equal(stands(autoTopUpComingSubject(BATCH_1)), true);
    assert.equal(stands(autoTopUpComingSubject(BATCH_2)), false, 'a healthy stamp has no alert');
  });

  it('are tried with nobody to get the notices as well', async () => {
    notifier.isOn = false;
    await run(input({}, T0));
    assert.equal(notifier.retries.length, 1);
  });

  it('wait for a destination that failed while another took the notice, and are dropped once their warning clears', async () => {
    const notices = new InMemoryNoticeStore();
    const key = channelSecretKeyFrom('ab'.repeat(32));
    await notices.saveService(
      {
        kind: 'email',
        settings: { provider: 'brevo', senderAddress: 'alerts@example.com', senderName: '' },
        secret: sealChannelSecret('email', 'xkeysib-made-up-for-the-test', key),
      },
      'operator',
      T0,
    );
    await notices.saveService(
      { kind: 'telegram', settings: {}, secret: sealChannelSecret('telegram', `1234567890:${'A'.repeat(35)}`, key) },
      'operator',
      T0,
    );
    // One person, on email and on Telegram, with the topics a user starts with.
    const userId = '00000000-0000-4000-8000-0000000000a1';
    const topics = ['topups_coming', 'wallet_low', 'topup_failed', 'stamp_expired'] as const;
    await notices.saveDestination({ userId, kind: 'email' }, 'ops@example.com', T0, topics);
    await notices.saveDestination({ userId, kind: 'telegram' }, '-1001234567890', T0, topics);
    const taken: string[] = [];
    const channelFrom: DestinationChannelFactory = (config) => ({
      kind: config.kind,
      send: async (notice) => {
        if (config.kind === 'telegram') throw new NotificationSendError('The telegram service answered 502.');
        taken.push(notice.title);
      },
    });
    job = new AutoTopUpAlertJob(
      store,
      new NoticeDispatcher({ store: notices, key, channelFrom, logger: silent }),
      silent,
    );

    const dry = { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: (XDAI / 20n).toString() };
    await run(input({}, T0, { brandWallet: dry }));
    assert.deepEqual(taken, ['Stamp auto top-up: the brand wallet is low on xDAI']);
    assert.equal(warningOf('wallet_xdai')?.notifiedAt, T0, 'notified once one destination took it');
    assert.equal(notices.waitingRows.length, 1);
    assert.deepEqual(notices.waitingRows[0]!.subjects, [
      autoTopUpWarningSubject({ kind: 'wallet_xdai', batchId: null }),
    ]);

    await run(input({}, at(10 * 60), { brandWallet: dry }));
    assert.equal(notices.waitingRows[0]?.attempts, 2, 'tried again while the warning stands');

    const outcome = await run(input({}, at(20 * 60)));
    assert.equal(warningOf('wallet_xdai'), undefined);
    assert.equal(notices.waitingRows.length, 0, 'dropped once nothing it tells of stands');
    assert.equal(outcome.ok, true);
  });
});

describe('the notices', () => {
  it('carry node names, stamps, amounts and the brand wallet address, and nothing secret', async () => {
    const poor = { address: BRAND, xbzzPlur: (XBZZ / 10n).toString(), xdaiWei: (XDAI / 20n).toString() };
    await store.mark([{ batchId: BATCH_3, nodeId: 'node-b', nodeLabel: 'node-b label' }], 'operator', T0);
    await run(
      input(
        {
          [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH),
          [BATCH_3]: operable(BATCH_3, 6 * DAY, node('node-b', WALLET_B, 0n, 0n)),
        },
        T0,
        { brandWallet: poor },
      ),
    );
    assert.equal(notifier.sent.length, 2);
    const text = notifier.sent.map((sent) => `${sent.title}\n${sent.text}`).join('\n');
    assert.match(text, /node-b label holds 0 xBZZ and 0 xDAI\./);
    assert.match(text, /It does not cover them: send it the rest\./);
    const addresses = new Set(text.match(/0x[0-9a-f]{40}(?![0-9a-f])/g));
    assert.deepEqual([...addresses], [BRAND]);
    assert.doesNotMatch(text, /password|secret|stream key|token/i);
  });
});

describe('the alert job in a tick', () => {
  /** A tick's context over the stamp inventory, with the stage's node marked, and these pins. */
  async function context(
    inventory: FundingInventory,
    pins: ReadonlyMap<string, string> = new Map([[NODE_A, FAKE_WALLET_A]]),
  ): Promise<AutoTopUpTickContext> {
    return {
      now: T0,
      settings: AUTO_TOPUP_DEFAULTS,
      funding: {
        inventory,
        postage: POSTAGE,
        brandWallet: null,
        pins,
      },
      stamps: markedStampsOf(inventory, await store.marks()),
    };
  }

  function withStageBatch(over: Partial<FundingBatch>, node: Partial<FundingNode> = {}): FundingInventory {
    const inventory = stampInventory();
    const stageNodes = inventory.stages[0]!.nodes;
    stageNodes[0] = { ...stageNodes[0]!, chainLagBlocks: 3, ...node, batch: fundingBatch(over) };
    return inventory;
  }

  beforeEach(async () => {
    store = new InMemoryStampAutoTopUpStore();
    job = new AutoTopUpAlertJob(store, notifier, silent);
    await store.mark([{ batchId: BATCH_STAGE, nodeId: NODE_A, nodeLabel: 'Main stage uploader' }], 'operator', T0);
  });

  it('is the alert job, and reads an operable stamp with its node, wallet and pin', async () => {
    assert.equal(job.job, 'alert');
    const tick = await context(withStageBatch({ ttlSeconds: 7.5 * DAY }));
    const reading = alertReadingOf(tick, tick.stamps[0]!);
    assert.deepEqual(reading, {
      state: 'operable',
      name: { batchId: BATCH_STAGE, title: 'The batch of stage "Main stage"', nodeLabel: 'Main stage uploader' },
      depth: 20,
      ttlSeconds: 7.5 * DAY,
      node: {
        nodeId: NODE_A,
        label: 'Main stage uploader',
        walletAddress: FAKE_WALLET_A,
        xbzzPlur: (5n * XBZZ).toString(),
        xdaiWei: (XDAI / 10n).toString(),
        pin: 'pinned',
      },
    });
    assert.equal(alertJobInputOf(tick, false).readings.size, 1);
  });

  it('reads a pin that is missing or names another address as one waiting for a person', async () => {
    const unpinned = await context(withStageBatch({}), new Map());
    assert.equal((alertReadingOf(unpinned, unpinned.stamps[0]!) as { node: { pin: string } }).node.pin, 'new');
    const moved = await context(withStageBatch({}), new Map([[NODE_A, WALLET_B]]));
    assert.equal((alertReadingOf(moved, moved.stamps[0]!) as { node: { pin: string } }).node.pin, 'changed');
  });

  it('reads a batch the node holds no more, or with no time left, as expired', async () => {
    const gone = stampInventory();
    gone.stages[0]!.nodes[0] = { ...gone.stages[0]!.nodes[0]!, batch: null };
    const goneTick = await context(gone);
    assert.equal(alertReadingOf(goneTick, goneTick.stamps[0]!)?.state, 'expired');
    for (const over of [{ ttlSeconds: 0 }, { state: 'expired' as const }, { state: 'gone' as const }]) {
      const tick = await context(withStageBatch(over));
      assert.equal(alertReadingOf(tick, tick.stamps[0]!)?.state, 'expired', JSON.stringify(over));
    }
  });

  it('reads an unread node or batch, or a chain view not known to be current, as unread', async () => {
    const cases: [FundingInventory, string][] = [
      [withStageBatch({}, { readError: 'The node did not answer.' }), 'Its node could not be read.'],
      [
        withStageBatch({ readError: 'No answer.', depth: null, ttlSeconds: null, usable: null }),
        'Its node could not be read.',
      ],
      [withStageBatch({}, { chainLagBlocks: 500 }), "Its node's view of the chain is behind."],
      [
        withStageBatch({}, { chainLagBlocks: null }),
        "Whether its node's view of the chain is current could not be read.",
      ],
    ];
    for (const [inventory, reason] of cases) {
      const tick = await context(inventory);
      const reading = alertReadingOf(tick, tick.stamps[0]!);
      assert.equal(reading?.state, 'unread');
      assert.equal((reading as { reason: string }).reason, reason);
    }
  });

  it('counts a stamp whose node reads behind on the chain in the monthly estimate, as the tab and the ceiling do', async () => {
    const behind = await context(withStageBatch({}, { chainLagBlocks: 500 }));
    assert.equal(alertReadingOf(behind, behind.stamps[0]!)?.state, 'unread');
    assert.deepEqual(alertJobInputOf(behind, false).estimateDepths, [20]);
  });

  it('reads a batch not usable yet as waiting, and leaves a stamp whose node the admin funds no more', async () => {
    const waiting = await context(withStageBatch({ usable: false }));
    assert.equal(alertReadingOf(waiting, waiting.stamps[0]!)?.state, 'waiting');
    const inventory = stampInventory();
    inventory.stages[0]!.nodes.splice(0, 1);
    const orphan = await context(inventory);
    assert.equal(alertReadingOf(orphan, orphan.stamps[0]!), null);
    assert.equal(alertJobInputOf(orphan, false).readings.size, 0);
  });

  it('names the catalogue batch and an archive stamp as the Stamps tab does', async () => {
    const inventory = stampInventory();
    inventory.catalogue = { ...inventory.catalogue!, chainLagBlocks: 0 };
    inventory.archiveBatches = [
      {
        ...fundingBatch({ batchId: BATCH_3 }),
        nodeId: NODE_CATALOGUE,
        nodeLabel: 'Catalogue node',
        label: 'Keynotes',
        writable: false,
      },
    ];
    await store.mark(
      [
        { batchId: BATCH_CATALOGUE, nodeId: NODE_CATALOGUE, nodeLabel: 'Catalogue node' },
        { batchId: BATCH_3, nodeId: NODE_CATALOGUE, nodeLabel: 'Catalogue node' },
      ],
      'operator',
      T0,
    );
    const tick = await context(inventory);
    const titles = tick.stamps.map((stamp) => alertReadingOf(tick, stamp)?.name.title);
    assert.deepEqual(titles, ['The batch of stage "Main stage"', 'The catalogue batch', 'Archive stamp "Keynotes"']);
  });

  it('runs on the tick context: records the alert and sends its notice, and reads the wallet job paused from the store', async () => {
    await store.setPaused('wallet', true, 'operator', T0);
    const inventory = withStageBatch({ ttlSeconds: 7.5 * DAY }, { xbzzPlur: '0' });
    const result = await job.run(await context(inventory));
    assert.equal(result.ok, true);
    assert.ok(alertOf(BATCH_STAGE) !== null);
    assert.match(notifier.sent.at(-1)!.text, /the wallet job is paused/);
  });
});
