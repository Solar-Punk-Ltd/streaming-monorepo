/**
 * The alert job of stamp auto top-up: the alerts it records and clears, the "top-ups coming up" mail and its
 * once-a-day rule, the warnings it raises, words anew, clears and mails, and a mail that fails. Unit test over a store
 * in memory and a mailer that records what it is handed. `pnpm test`.
 *
 * Addresses are fixtures the leak gate allows (`scripts/public-leaks/allow.json`).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  AUTO_TOPUP_DEFAULTS,
  SECONDS_PER_DAY,
  autoTopUpStampPlan,
  type AutoTopUpJob,
  type AutoTopUpSettings,
  type FundingPostage,
} from '@streaming-monorepo/web2-admin-common';

import {
  AutoTopUpAlertJob,
  type AlertJobInput,
  type AlertStampNode,
  type AlertStampReading,
} from '../../src/domain/funding/AutoTopUpAlertJob.js';
import type {
  AutoTopUpAlert,
  AutoTopUpJobRow,
  AutoTopUpMailRow,
  AutoTopUpMarkRow,
  AutoTopUpSettingsRow,
  AutoTopUpWarningKey,
  AutoTopUpWarningRow,
  NewAutoTopUpMark,
  StampAutoTopUpStore,
} from '../../src/domain/funding/StampAutoTopUpStore.js';
import { MailSendError, type Mailer, type OutgoingMail } from '../../src/domain/mail/Mailer.js';

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

/** The store in memory, with the semantics the alert job leans on: warnings keep `since` and `mailedAt` when worded anew. */
class MemoryStore implements StampAutoTopUpStore {
  markRows: AutoTopUpMarkRow[] = [];
  warningRows: AutoTopUpWarningRow[] = [];
  emailList: string[] = ['ops@example.org'];
  mailRow: AutoTopUpMailRow = {
    lastSentAt: null,
    lastError: null,
    lastErrorAt: null,
    lastComingMailAt: null,
    lastRepeatMailAt: null,
  };

  withTickLock<T>(work: () => Promise<T>) {
    return work().then((result) => ({ locked: true as const, result }));
  }
  settings(): Promise<AutoTopUpSettingsRow | null> {
    return Promise.resolve(null);
  }
  saveSettings(): Promise<void> {
    return Promise.resolve();
  }
  jobs(): Promise<AutoTopUpJobRow[]> {
    return Promise.resolve([]);
  }
  setPaused(_job: AutoTopUpJob): Promise<void> {
    return Promise.resolve();
  }
  recordRun(): Promise<void> {
    return Promise.resolve();
  }
  emails(): Promise<string[]> {
    return Promise.resolve([...this.emailList]);
  }
  replaceEmails(emails: readonly string[]): Promise<void> {
    this.emailList = [...emails];
    return Promise.resolve();
  }
  marks(): Promise<AutoTopUpMarkRow[]> {
    return Promise.resolve(this.markRows.map((row) => ({ ...row, alert: row.alert && { ...row.alert } })));
  }
  mark(items: readonly NewAutoTopUpMark[], by: string, when: Date): Promise<void> {
    for (const item of items) {
      if (this.markRows.some((row) => row.batchId === item.batchId)) continue;
      this.markRows.push({ ...item, markedAt: when, markedBy: by, alert: null, unreadSince: null });
    }
    return Promise.resolve();
  }
  unmark(batchIds: readonly string[]): Promise<void> {
    this.markRows = this.markRows.filter((row) => !batchIds.includes(row.batchId));
    this.warningRows = this.warningRows.filter((row) => row.batchId === null || !batchIds.includes(row.batchId));
    return Promise.resolve();
  }
  setAlert(batchId: string, alert: AutoTopUpAlert | null): Promise<void> {
    const row = this.markRows.find((mark) => mark.batchId === batchId);
    if (row) row.alert = alert && { ...alert };
    return Promise.resolve();
  }
  setAlerted(batchIds: readonly string[], when: Date): Promise<void> {
    for (const row of this.markRows) {
      if (batchIds.includes(row.batchId) && row.alert !== null && row.alert.alertedAt === null) {
        row.alert.alertedAt = when;
      }
    }
    return Promise.resolve();
  }
  setUnreadSince(batchId: string, since: Date | null): Promise<void> {
    const row = this.markRows.find((mark) => mark.batchId === batchId);
    if (row) row.unreadSince = since;
    return Promise.resolve();
  }
  warnings(): Promise<AutoTopUpWarningRow[]> {
    return Promise.resolve(this.warningRows.map((row) => ({ ...row })));
  }
  raiseWarning(key: AutoTopUpWarningKey, message: string, when: Date): Promise<void> {
    const row = this.warningRows.find((warning) => warning.kind === key.kind && warning.batchId === key.batchId);
    if (row) row.message = message;
    else this.warningRows.push({ ...key, message, since: when, mailedAt: null });
    return Promise.resolve();
  }
  clearWarning(key: AutoTopUpWarningKey): Promise<void> {
    this.warningRows = this.warningRows.filter(
      (warning) => !(warning.kind === key.kind && warning.batchId === key.batchId),
    );
    return Promise.resolve();
  }
  setWarningsMailed(keys: readonly AutoTopUpWarningKey[], when: Date): Promise<void> {
    for (const row of this.warningRows) {
      if (keys.some((key) => key.kind === row.kind && key.batchId === row.batchId)) row.mailedAt = when;
    }
    return Promise.resolve();
  }
  mail(): Promise<AutoTopUpMailRow> {
    return Promise.resolve({ ...this.mailRow });
  }
  recordMail(update: Partial<AutoTopUpMailRow>): Promise<void> {
    this.mailRow = { ...this.mailRow, ...update };
    return Promise.resolve();
  }
  lastSystemTopUps() {
    return Promise.resolve([]);
  }
  systemSendsSince() {
    return Promise.resolve({ xbzzPlur: '0', gasNodeIds: [] });
  }
  warning(kind: AutoTopUpWarningKey['kind'], batchId: string | null = null): AutoTopUpWarningRow | undefined {
    return this.warningRows.find((row) => row.kind === kind && row.batchId === batchId);
  }
  alert(batchId: string): AutoTopUpAlert | null {
    return this.markRows.find((row) => row.batchId === batchId)?.alert ?? null;
  }
}

/** A mailer that records each mail, and fails while `failWith` is set. */
class RecordingMailer implements Mailer {
  sent: { to: readonly string[]; mail: OutgoingMail }[] = [];
  failWith: string | null = null;
  constructor(readonly configured = true) {}
  send(to: readonly string[], mail: OutgoingMail): Promise<void> {
    if (this.failWith !== null) return Promise.reject(new MailSendError(this.failWith));
    this.sent.push({ to, mail });
    return Promise.resolve();
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
    ...extra,
  };
}

const RICH = node('node-a', WALLET_A, 100n * XBZZ, XDAI);

let store: MemoryStore;
let mailer: RecordingMailer;
let job: AutoTopUpAlertJob;

beforeEach(async () => {
  store = new MemoryStore();
  mailer = new RecordingMailer();
  job = new AutoTopUpAlertJob(store, mailer, silent);
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
  it('for a stamp within two look-aheads of the threshold, and mails nothing until one turns upcoming', async () => {
    const outcome = await job.run(input({ [BATCH_1]: operable(BATCH_1, 8.5 * DAY, RICH) }, T0));
    const expected = plan(8.5 * DAY);
    assert.deepEqual(store.alert(BATCH_1), {
      days: 7,
      costPlur: expected.costPlur,
      costWithMarginPlur: expected.costWithMarginPlur,
      sendPlur: '0',
      gasSend: false,
      recordedAt: T0,
      alertedAt: null,
    });
    assert.equal(mailer.sent.length, 0);
    assert.equal(outcome.ok, true);
    assert.match(outcome.outcome, /^1 of 2 marked stamps has a top-up coming, 1 alert recorded/);
  });

  it('mails "top-ups coming up" when one turns upcoming, listing every listed one, and counts them given', async () => {
    await job.run(
      input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 8.5 * DAY, RICH) }, T0),
    );
    assert.equal(mailer.sent.length, 1);
    const { to, mail } = mailer.sent[0]!;
    assert.deepEqual(to, ['ops@example.org']);
    assert.equal(mail.subject, 'Stamp auto top-up: 2 top-ups coming up');
    assert.match(
      mail.text,
      /Stage b1 \(batch 0xb1b1b1b1…, on node-a label\): 7 days 12 hours left, due 2026-11-25 00:00 UTC\. Adds 7 days/,
    );
    assert.match(mail.text, /Stage c2 .*: 8 days 12 hours left/);
    assert.match(
      mail.text,
      /node-a label holds 100 xBZZ and 1 xDAI\. It holds enough: the brand wallet sends it nothing\./,
    );
    assert.match(mail.text, /The brand wallet, 0x1234567890123456789012345678901234567890, holds 100 xBZZ and 1 xDAI/);
    assert.match(mail.text, /It covers them\./);
    assert.equal(store.alert(BATCH_1)?.alertedAt, T0);
    assert.equal(store.alert(BATCH_2)?.alertedAt, T0);
    assert.equal(store.mailRow.lastComingMailAt, T0);
    assert.equal(store.mailRow.lastSentAt, T0);
  });

  it('sends that mail at most once a day, and lists in the next one what the last one did not', async () => {
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    await job.run(
      input(
        { [BATCH_1]: operable(BATCH_1, 7.25 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 7.6 * DAY, RICH) },
        at(6 * HOUR),
      ),
    );
    assert.equal(mailer.sent.length, 1);
    assert.equal(store.alert(BATCH_2)?.alertedAt, null);
    await job.run(
      input({ [BATCH_1]: operable(BATCH_1, 6.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 6.6 * DAY, RICH) }, at(DAY)),
    );
    assert.equal(mailer.sent.length, 2);
    assert.equal(mailer.sent[1]!.mail.subject, 'Stamp auto top-up: 1 top-up coming up');
    assert.match(mailer.sent[1]!.mail.text, /Stage c2/);
    assert.doesNotMatch(mailer.sent[1]!.mail.text, /Stage b1/);
    assert.equal(store.alert(BATCH_2)?.alertedAt?.getTime(), at(DAY).getTime());
  });

  it('with no mail set, counts an alert given when it is recorded', async () => {
    job = new AutoTopUpAlertJob(store, new RecordingMailer(false), silent);
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 8.5 * DAY, RICH) }, T0));
    assert.equal(store.alert(BATCH_1)?.alertedAt, T0);
  });

  it('with an empty email list, counts it given as with no mail set, and sends nothing', async () => {
    store.emailList = [];
    const outcome = await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    assert.equal(mailer.sent.length, 0);
    assert.equal(store.alert(BATCH_1)?.alertedAt, T0);
    assert.match(outcome.outcome, /mail is not set/);
  });

  it('names what the brand wallet sends a short node, and when', async () => {
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, node('node-a', WALLET_A, 0n, 0n)) }, T0));
    const alert = store.alert(BATCH_1)!;
    assert.equal(alert.sendPlur, plan(7.5 * DAY).costWithMarginPlur);
    assert.equal(alert.gasSend, true);
    assert.match(
      mailer.sent[0]!.mail.text,
      /The brand wallet sends it [\d.]+ xBZZ and 0\.01 xDAI for gas at 2026-11-25 12:00 UTC at the earliest/,
    );
  });

  it('says a send goes without waiting when a stamp has under two look-aheads left', async () => {
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 1.5 * DAY, node('node-a', WALLET_A, 0n, XDAI)) }, T0));
    assert.match(
      mailer.sent[0]!.mail.text,
      /without waiting 1 day after this mail, since a stamp of it has under 2 days left/,
    );
  });

  it('says the wallet job is paused, or that the node waits for its address to be confirmed', async () => {
    const short = node('node-a', WALLET_A, 0n, XDAI);
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, short) }, T0, { walletJobPaused: true }));
    assert.match(mailer.sent[0]!.mail.text, /the wallet job is paused: fund it on the Balance tab/);
    store.mailRow.lastComingMailAt = null;
    await store.setAlert(BATCH_1, null);
    const unconfirmed = node('node-a', WALLET_A, 0n, XDAI, 'changed');
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, unconfirmed) }, at(HOUR)));
    assert.match(mailer.sent[1]!.mail.text, /until a person confirms its address on the Balance tab/);
  });

  it('records a new alert, to be given afresh, when the node lacks more than the alert said', async () => {
    const short = node('node-a', WALLET_A, 0n, XDAI);
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, short) }, T0));
    const first = store.alert(BATCH_1)!;
    const dearer = { ...POSTAGE, pricePerChunkPerBlockPlur: '30000' };
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.25 * DAY, short) }, at(6 * HOUR), { postage: dearer }));
    const second = store.alert(BATCH_1)!;
    assert.ok(BigInt(second.sendPlur) > BigInt(first.sendPlur));
    assert.equal(second.recordedAt.getTime(), at(6 * HOUR).getTime());
    assert.equal(second.alertedAt, null);
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.2 * DAY, short) }, at(7 * HOUR), { postage: dearer }));
    assert.deepEqual(store.alert(BATCH_1), second, 'a lack within what the alert said keeps it');
  });

  it('clears the alert of a stamp healthy again, and of one that expired', async () => {
    await job.run(
      input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 7.5 * DAY, RICH) }, T0),
    );
    await job.run(
      input(
        { [BATCH_1]: operable(BATCH_1, 14 * DAY, RICH), [BATCH_2]: { state: 'expired', name: stampName(BATCH_2) } },
        at(HOUR),
      ),
    );
    assert.equal(store.alert(BATCH_1), null);
    assert.equal(store.alert(BATCH_2), null);
  });

  it('leaves the alert of a stamp it could not read, or one waiting to be usable', async () => {
    await job.run(
      input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 7.5 * DAY, RICH) }, T0),
    );
    const alerts = [store.alert(BATCH_1), store.alert(BATCH_2)];
    await job.run(
      input({ [BATCH_1]: unreadOf(BATCH_1), [BATCH_2]: { state: 'waiting', name: stampName(BATCH_2) } }, at(HOUR)),
    );
    assert.deepEqual([store.alert(BATCH_1), store.alert(BATCH_2)], alerts);
  });
});

describe('the alert job keeps the warnings', () => {
  it('raises the brand wallet low on xBZZ under the monthly estimate, mails it at once, clears it once covered', async () => {
    const poor = { address: BRAND, xbzzPlur: XBZZ.toString(), xdaiWei: XDAI.toString() };
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, T0, { brandWallet: poor }));
    const warning = store.warning('wallet_xbzz')!;
    assert.match(warning.message, /^The brand wallet holds 1 xBZZ, under the [\d.]+ xBZZ that 30 days of top-ups/);
    assert.match(warning.message, /It covers about \d+ days of top-ups\. Send xBZZ to the brand wallet, 0x1234/);
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0]!.mail.subject, 'Stamp auto top-up: the brand wallet is low on xBZZ');
    assert.equal(warning.mailedAt, T0);
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, at(HOUR)));
    assert.equal(store.warning('wallet_xbzz'), undefined);
  });

  it('raises the brand wallet low on xDAI under the threshold', async () => {
    const dry = { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: (XDAI / 20n).toString() };
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, T0, { brandWallet: dry }));
    assert.match(store.warning('wallet_xdai')!.message, /^The brand wallet holds 0\.05 xDAI, under the 0\.1 xDAI/);
  });

  it('keeps a wallet warning as it stands while the balance could not be read', async () => {
    const dry = { address: BRAND, xbzzPlur: (100n * XBZZ).toString(), xdaiWei: (XDAI / 20n).toString() };
    await job.run(input({}, T0, { brandWallet: dry }));
    await job.run(input({}, at(HOUR), { brandWallet: { address: BRAND, xbzzPlur: null, xdaiWei: null } }));
    assert.ok(store.warning('wallet_xdai'));
  });

  it('mails the standing warnings again together once a day', async () => {
    const dry = { address: BRAND, xbzzPlur: XBZZ.toString(), xdaiWei: (XDAI / 20n).toString() };
    const readings = { [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) };
    await job.run(input(readings, T0, { brandWallet: dry }));
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0]!.mail.subject, 'Stamp auto top-up: 2 new warnings');
    await job.run(input(readings, at(12 * HOUR), { brandWallet: dry }));
    assert.equal(mailer.sent.length, 1, 'no repeat within a day');
    await job.run(input(readings, at(DAY), { brandWallet: dry }));
    assert.equal(mailer.sent.length, 2);
    const repeat = mailer.sent[1]!.mail;
    assert.equal(repeat.subject, 'Stamp auto top-up: 2 warnings still standing');
    assert.match(repeat.text, /^These warnings still stand\. This mail goes once a day while one does\./);
    assert.match(repeat.text, /- Since 2026-11-24 12:00 UTC: The brand wallet holds 0\.05 xDAI/);
    assert.equal(store.mailRow.lastRepeatMailAt?.getTime(), at(DAY).getTime());
    await job.run(input(readings, at(DAY + HOUR), { brandWallet: dry }));
    assert.equal(mailer.sent.length, 2);
  });

  it('raises a marked stamp that expired, mails it once and never again, and clears it once it reads again', async () => {
    const expired: AlertStampReading = { state: 'expired', name: stampName(BATCH_1) };
    await job.run(input({ [BATCH_1]: expired }, T0));
    assert.match(
      store.warning('stamp_expired', BATCH_1)!.message,
      /expired, or its node holds it no more.*Buy new.*Batch: 0xb1b1/,
    );
    assert.equal(mailer.sent[0]!.mail.subject, 'Stamp auto top-up: a marked stamp expired');
    await job.run(input({ [BATCH_1]: expired }, at(2 * DAY)));
    assert.equal(mailer.sent.length, 1);
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, at(3 * DAY)));
    assert.equal(store.warning('stamp_expired', BATCH_1), undefined);
  });

  it('raises a failed top-up for a stamp with a top-up coming whose node is unread for an hour', async () => {
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    await job.run(input({ [BATCH_1]: unreadOf(BATCH_1) }, at(10 * 60)));
    assert.equal(store.markRows[0]!.unreadSince?.getTime(), at(10 * 60).getTime());
    assert.equal(store.warning('topup_failed', BATCH_1), undefined, 'not within the hour');
    await job.run(input({ [BATCH_1]: unreadOf(BATCH_1) }, at(70 * 60)));
    assert.match(
      store.warning('topup_failed', BATCH_1)!.message,
      /could not be topped up\. Its time left could not be read\. Its node could not be read\. It has been so for an hour or more\./,
    );
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 14 * DAY, RICH) }, at(80 * 60)));
    assert.equal(store.markRows[0]!.unreadSince, null);
    assert.equal(store.warning('topup_failed', BATCH_1), undefined, 'cleared once it is no longer due');
  });

  it('raises a failed top-up for a due stamp on a short node an hour after it fell due, with the wallet job paused', async () => {
    const short = node('node-a', WALLET_A, 0n, XDAI);
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 7 * DAY - 30 * 60, short) }, T0, { walletJobPaused: true }));
    assert.equal(store.warning('topup_failed', BATCH_1), undefined);
    await job.run(
      input({ [BATCH_1]: operable(BATCH_1, 7 * DAY - 61 * 60, short) }, at(HOUR), { walletJobPaused: true }),
    );
    assert.match(
      store.warning('topup_failed', BATCH_1)!.message,
      /It has 6 days 22 hours left\. Its node is short of xBZZ for the top-up, and the wallet job is paused\. Fund the node/,
    );
  });

  it('clears a failed top-up another job raised once the stamp is topped up', async () => {
    await store.raiseWarning({ kind: 'topup_failed', batchId: BATCH_1 }, 'The operation failed.', T0);
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 6.5 * DAY, RICH) }, at(HOUR)));
    assert.ok(store.warning('topup_failed', BATCH_1), 'stands while the stamp is due');
    await job.run(input({ [BATCH_1]: operable(BATCH_1, 14 * DAY, RICH) }, at(2 * HOUR)));
    assert.equal(store.warning('topup_failed', BATCH_1), undefined);
  });
});

describe('a mail that fails', () => {
  it('is recorded in the mail row and tried again at the next run, and the run goes on', async () => {
    mailer.failWith = 'The mail service could not be reached: check SMTP_HOST and SMTP_PORT.';
    const outcome = await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    assert.equal(outcome.ok, false);
    assert.match(outcome.outcome, /Mail failed: The mail service could not be reached/);
    assert.ok(store.alert(BATCH_1) !== null, 'the alert is recorded all the same');
    assert.equal(store.alert(BATCH_1)?.alertedAt, null);
    assert.equal(store.mailRow.lastError, mailer.failWith);
    assert.equal(store.mailRow.lastErrorAt, T0);
    assert.equal(store.mailRow.lastComingMailAt, null);

    mailer.failWith = null;
    const retried = await job.run(input({ [BATCH_1]: operable(BATCH_1, 7.4 * DAY, RICH) }, at(10 * 60)));
    assert.equal(retried.ok, true);
    assert.equal(mailer.sent.length, 1);
    assert.equal(store.alert(BATCH_1)?.alertedAt?.getTime(), at(10 * 60).getTime());
    assert.equal(store.mailRow.lastError, null);
  });
});

describe('the mails', () => {
  it('carry node names, stamps, amounts and the brand wallet address, and nothing secret', async () => {
    const poor = { address: BRAND, xbzzPlur: (XBZZ / 10n).toString(), xdaiWei: (XDAI / 20n).toString() };
    await store.mark([{ batchId: BATCH_3, nodeId: 'node-b', nodeLabel: 'node-b label' }], 'operator', T0);
    await job.run(
      input(
        {
          [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH),
          [BATCH_3]: operable(BATCH_3, 6 * DAY, node('node-b', WALLET_B, 0n, 0n)),
        },
        T0,
        { brandWallet: poor },
      ),
    );
    assert.equal(mailer.sent.length, 2);
    const text = mailer.sent.map((sent) => `${sent.mail.subject}\n${sent.mail.text}`).join('\n');
    assert.match(text, /node-b label holds 0 xBZZ and 0 xDAI\./);
    assert.match(text, /It does not cover them: send it the rest\./);
    const addresses = new Set(text.match(/0x[0-9a-f]{40}(?![0-9a-f])/g));
    assert.deepEqual([...addresses], [BRAND]);
    assert.doesNotMatch(text, /password|secret|stream key|token/i);
  });
});
