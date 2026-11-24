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
  type AutoTopUpSettings,
  type FundingPostage,
} from '@streaming-monorepo/web2-admin-common';

import type { FundingBatch, FundingInventory, FundingNode } from '@streaming-monorepo/contracts';

import {
  AutoTopUpAlertJob,
  alertJobInputOf,
  alertReadingOf,
  type AlertJobInput,
  type AlertStampNode,
  type AlertStampReading,
} from '../../src/domain/funding/AutoTopUpAlertJob.js';
import type {
  AutoTopUpAlert,
  AutoTopUpWarningKey,
  AutoTopUpWarningRow,
} from '../../src/domain/funding/StampAutoTopUpStore.js';
import { MailSendError, type Mailer, type OutgoingMail } from '../../src/domain/mail/Mailer.js';

import { markedStampsOf, type AutoTopUpTickContext } from '../../src/domain/funding/autoTopUpJobs.js';

import { InMemoryStampAutoTopUpStore } from './support/autoTopUpFakes.js';
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

let store: InMemoryStampAutoTopUpStore;
let mailer: RecordingMailer;
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
  store.emailList = ['ops@example.org'];
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
    assert.equal(mailer.sent.length, 0);
    assert.equal(outcome.ok, true);
    assert.match(outcome.outcome, /^1 of 2 marked stamps has a top-up coming, 1 alert recorded/);
  });

  it('mails "top-ups coming up" when one turns upcoming, listing every listed one, and counts them given', async () => {
    await run(
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
    assert.equal(alertOf(BATCH_1)?.alertedAt, T0);
    assert.equal(alertOf(BATCH_2)?.alertedAt, T0);
    assert.equal(store.mailRow.lastComingMailAt, T0);
    assert.equal(store.mailRow.lastSentAt, T0);
  });

  it('sends that mail at most once a day, and lists in the next one what the last one did not', async () => {
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    await run(
      input(
        { [BATCH_1]: operable(BATCH_1, 7.25 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 7.6 * DAY, RICH) },
        at(6 * HOUR),
      ),
    );
    assert.equal(mailer.sent.length, 1);
    assert.equal(alertOf(BATCH_2)?.alertedAt, null);
    await run(
      input({ [BATCH_1]: operable(BATCH_1, 6.5 * DAY, RICH), [BATCH_2]: operable(BATCH_2, 6.6 * DAY, RICH) }, at(DAY)),
    );
    assert.equal(mailer.sent.length, 2);
    assert.equal(mailer.sent[1]!.mail.subject, 'Stamp auto top-up: 1 top-up coming up');
    assert.match(mailer.sent[1]!.mail.text, /Stage c2/);
    assert.doesNotMatch(mailer.sent[1]!.mail.text, /Stage b1/);
    assert.equal(alertOf(BATCH_2)?.alertedAt?.getTime(), at(DAY).getTime());
  });

  it('with no mail set, counts an alert given when it is recorded', async () => {
    job = new AutoTopUpAlertJob(store, new RecordingMailer(false), silent);
    await run(input({ [BATCH_1]: operable(BATCH_1, 8.5 * DAY, RICH) }, T0));
    assert.equal(alertOf(BATCH_1)?.alertedAt, T0);
  });

  it('with an empty email list, counts it given as with no mail set, and sends nothing', async () => {
    store.emailList = [];
    const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    assert.equal(mailer.sent.length, 0);
    assert.equal(alertOf(BATCH_1)?.alertedAt, T0);
    assert.match(outcome.outcome, /mail is not set/);
  });

  it('names what the brand wallet sends a short node, and when', async () => {
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, node('node-a', WALLET_A, 0n, 0n)) }, T0));
    const alert = alertOf(BATCH_1)!;
    assert.equal(alert.sendPlur, plan(7.5 * DAY).costWithMarginPlur);
    assert.equal(alert.gasSend, true);
    assert.match(
      mailer.sent[0]!.mail.text,
      /The brand wallet sends it [\d.]+ xBZZ and 0\.01 xDAI for gas at 2026-11-25 12:00 UTC at the earliest/,
    );
  });

  it('says a send goes without waiting when a stamp has under two look-aheads left', async () => {
    await run(input({ [BATCH_1]: operable(BATCH_1, 1.5 * DAY, node('node-a', WALLET_A, 0n, XDAI)) }, T0));
    assert.match(
      mailer.sent[0]!.mail.text,
      /without waiting 1 day after this mail, since a stamp of it has under 2 days left/,
    );
  });

  it('says the wallet job is paused, or that the node waits for its address to be confirmed', async () => {
    const short = node('node-a', WALLET_A, 0n, XDAI);
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, short) }, T0, { walletJobPaused: true }));
    assert.match(mailer.sent[0]!.mail.text, /the wallet job is paused: fund it on the Balance tab/);
    store.mailRow.lastComingMailAt = null;
    await store.setAlert(BATCH_1, null);
    const unconfirmed = node('node-a', WALLET_A, 0n, XDAI, 'changed');
    await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, unconfirmed) }, at(HOUR)));
    assert.match(mailer.sent[1]!.mail.text, /until a person confirms its address on the Balance tab/);
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
  it('raises the brand wallet low on xBZZ under the monthly estimate, mails it at once, clears it once covered', async () => {
    const poor = { address: BRAND, xbzzPlur: XBZZ.toString(), xdaiWei: XDAI.toString() };
    await run(input({ [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) }, T0, { brandWallet: poor }));
    const warning = warningOf('wallet_xbzz')!;
    assert.match(warning.message, /^The brand wallet holds 1 xBZZ, under the [\d.]+ xBZZ that 30 days of top-ups/);
    assert.match(warning.message, /It covers about \d+ days of top-ups\. Send xBZZ to the brand wallet, 0x1234/);
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0]!.mail.subject, 'Stamp auto top-up: the brand wallet is low on xBZZ');
    assert.equal(warning.mailedAt, T0);
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

  it('mails the standing warnings again together once a day', async () => {
    const dry = { address: BRAND, xbzzPlur: XBZZ.toString(), xdaiWei: (XDAI / 20n).toString() };
    const readings = { [BATCH_1]: operable(BATCH_1, 10 * DAY, RICH) };
    await run(input(readings, T0, { brandWallet: dry }));
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0]!.mail.subject, 'Stamp auto top-up: 2 new warnings');
    await run(input(readings, at(12 * HOUR), { brandWallet: dry }));
    assert.equal(mailer.sent.length, 1, 'no repeat within a day');
    await run(input(readings, at(DAY), { brandWallet: dry }));
    assert.equal(mailer.sent.length, 2);
    const repeat = mailer.sent[1]!.mail;
    assert.equal(repeat.subject, 'Stamp auto top-up: 2 warnings still standing');
    assert.match(repeat.text, /^These warnings still stand\. This mail goes once a day while one does\./);
    assert.match(repeat.text, /- Since 2026-11-24 12:00 UTC: The brand wallet holds 0\.05 xDAI/);
    assert.equal(store.mailRow.lastRepeatMailAt?.getTime(), at(DAY).getTime());
    await run(input(readings, at(DAY + HOUR), { brandWallet: dry }));
    assert.equal(mailer.sent.length, 2);
  });

  it('raises a marked stamp that expired, mails it once and never again, and clears it once it reads again', async () => {
    const expired: AlertStampReading = { state: 'expired', name: stampName(BATCH_1) };
    await run(input({ [BATCH_1]: expired }, T0));
    assert.match(
      warningOf('stamp_expired', BATCH_1)!.message,
      /expired, or its node holds it no more.*Buy new.*Batch: 0xb1b1/,
    );
    assert.equal(mailer.sent[0]!.mail.subject, 'Stamp auto top-up: a marked stamp expired');
    await run(input({ [BATCH_1]: expired }, at(2 * DAY)));
    assert.equal(mailer.sent.length, 1);
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

describe('a mail that fails', () => {
  it('is recorded in the mail row and tried again at the next run, and the run goes on', async () => {
    mailer.failWith = 'The mail service could not be reached: check SMTP_HOST and SMTP_PORT.';
    const outcome = await run(input({ [BATCH_1]: operable(BATCH_1, 7.5 * DAY, RICH) }, T0));
    assert.equal(outcome.ok, false);
    assert.match(outcome.outcome, /Mail failed: The mail service could not be reached/);
    assert.ok(alertOf(BATCH_1) !== null, 'the alert is recorded all the same');
    assert.equal(alertOf(BATCH_1)?.alertedAt, null);
    assert.equal(store.mailRow.lastError, mailer.failWith);
    assert.equal(store.mailRow.lastErrorAt, T0);
    assert.equal(store.mailRow.lastComingMailAt, null);

    mailer.failWith = null;
    const retried = await run(input({ [BATCH_1]: operable(BATCH_1, 7.4 * DAY, RICH) }, at(10 * 60)));
    assert.equal(retried.ok, true);
    assert.equal(mailer.sent.length, 1);
    assert.equal(alertOf(BATCH_1)?.alertedAt?.getTime(), at(10 * 60).getTime());
    assert.equal(store.mailRow.lastError, null);
  });
});

describe('the mails', () => {
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
    assert.equal(mailer.sent.length, 2);
    const text = mailer.sent.map((sent) => `${sent.mail.subject}\n${sent.mail.text}`).join('\n');
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
    store.emailList = ['ops@example.org'];
    job = new AutoTopUpAlertJob(store, mailer, silent);
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

  it('runs on the tick context: records the alert and mails it, and reads the wallet job paused from the store', async () => {
    await store.setPaused('wallet', true, 'operator', T0);
    const inventory = withStageBatch({ ttlSeconds: 7.5 * DAY }, { xbzzPlur: '0' });
    const result = await job.run(await context(inventory));
    assert.equal(result.ok, true);
    assert.ok(alertOf(BATCH_STAGE) !== null);
    assert.match(mailer.sent.at(-1)!.mail.text, /the wallet job is paused/);
  });
});
