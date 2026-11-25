/**
 * Migration 035 against the real database, through the repository the admin keeps its notification channels and the
 * notices that wait for one with: a channel's save, switch and removal, how its notices and tests went, and the
 * waiting notices. Needs Postgres, like the rest of this suite; `DATABASE_URL` overrides the connection.
 *
 * Every row it writes is in the suite's throwaway database; it empties the tables before each test.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { EmailChannelSettings } from '@streaming-monorepo/web2-admin-common';

import { Database } from '../../src/domain/Database.js';
import { NotificationRepository } from '../../src/domain/notifications/NotificationRepository.js';
import type {
  NewWaitingDelivery,
  NotificationChannelSave,
  SealedSecret,
} from '../../src/domain/notifications/NotificationStore.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let store: NotificationRepository;

const AT = new Date('2026-11-25T10:00:00.000Z');
const LATER = new Date('2026-11-25T11:00:00.000Z');
const OPERATOR = 'operator-a';
const OTHER_OPERATOR = 'operator-b';

function sealed(over: Partial<SealedSecret> = {}): SealedSecret {
  return { ciphertext: randomBytes(40), iv: randomBytes(12), authTag: randomBytes(16), keyVersion: 1, ...over };
}

const EMAIL_SETTINGS: EmailChannelSettings = {
  provider: 'brevo',
  senderAddress: 'alerts@example.org',
  senderName: 'Example alerts',
  recipients: ['ops@example.org', 'team@example.org'],
};

function email(secret: SealedSecret | null = sealed()): NotificationChannelSave {
  return { kind: 'email', settings: EMAIL_SETTINGS, secret };
}

function telegram(chatId = '-1001234567890', secret: SealedSecret | null = sealed()): NotificationChannelSave {
  return { kind: 'telegram', settings: { chatId }, secret };
}

function slack(secret: SealedSecret | null = sealed()): NotificationChannelSave {
  return { kind: 'slack', settings: {}, secret };
}

function delivery(over: Partial<NewWaitingDelivery> = {}): NewWaitingDelivery {
  return {
    channel: 'slack',
    title: 'Stamp auto top-up: a top-up failed',
    text: 'The stamp could not be topped up.\nIt is tried again on the next tick.',
    subjects: ['auto-top-up/warning/topup_failed/0xabc', 'auto-top-up/coming/0xabc'],
    raisedAt: AT,
    error: 'Slack answered 500.',
    ...over,
  };
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  store = new NotificationRepository(database.pool);
});

after(async () => {
  if (database) await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM notification_deliveries');
  await database.pool.query('DELETE FROM notification_channels');
});

describe('notification channels', () => {
  it('reads none while none were saved', async () => {
    assert.deepEqual(await store.channels(), []);
  });

  it('makes a channel on its first save, switched on, with its settings and its sealed secret', async () => {
    const secret = sealed({ keyVersion: 2 });
    assert.equal(await store.saveChannel(email(secret), OPERATOR, AT), true);

    const [row] = await store.channels();
    assert.deepEqual(row, {
      kind: 'email',
      enabled: true,
      settings: EMAIL_SETTINGS,
      secret,
      savedAt: AT,
      savedBy: OPERATOR,
      lastSentAt: null,
      lastError: null,
      lastErrorAt: null,
      lastTestAt: null,
      lastTestError: null,
    });
  });

  it('refuses a first save with no secret, and saves nothing', async () => {
    assert.equal(await store.saveChannel(telegram('@channelname', null), OPERATOR, AT), false);
    assert.deepEqual(await store.channels(), []);
  });

  it('lists the channels in the order of NOTIFICATION_CHANNEL_KINDS', async () => {
    await store.saveChannel(telegram(), OPERATOR, AT);
    await store.saveChannel(slack(), OPERATOR, AT);
    await store.saveChannel(email(), OPERATOR, AT);

    assert.deepEqual(
      (await store.channels()).map((row) => row.kind),
      ['email', 'slack', 'telegram'],
    );
  });

  it('replaces the settings and the secret on a later save, and keeps the switch and the send state', async () => {
    await store.saveChannel(telegram(), OPERATOR, AT);
    await store.setEnabled('telegram', false);
    await store.recordSent('telegram', AT);
    await store.recordFailed('telegram', AT, 'Telegram answered 400.');
    assert.equal(await store.claimTest('telegram', AT, 60), true);
    await store.recordTest('telegram', 'Telegram answered 403.');

    const newSecret = sealed();
    assert.equal(await store.saveChannel(telegram('@channelname', newSecret), OTHER_OPERATOR, LATER), true);

    const [row] = await store.channels();
    assert.deepEqual(row, {
      kind: 'telegram',
      enabled: false,
      settings: { chatId: '@channelname' },
      secret: newSecret,
      savedAt: LATER,
      savedBy: OTHER_OPERATOR,
      lastSentAt: AT,
      lastError: 'Telegram answered 400.',
      lastErrorAt: AT,
      lastTestAt: AT,
      lastTestError: 'Telegram answered 403.',
    });
  });

  it('keeps the stored secret on a later save with none, and its waiting notices', async () => {
    const secret = sealed();
    await store.saveChannel(email(secret), OPERATOR, AT);
    await store.addWaiting([delivery({ channel: 'email' })]);

    const settings: EmailChannelSettings = { ...EMAIL_SETTINGS, recipients: ['ops@example.org'] };
    assert.equal(await store.saveChannel({ kind: 'email', settings, secret: null }, OTHER_OPERATOR, LATER), true);

    const [row] = await store.channels();
    assert.deepEqual(row?.settings, settings);
    assert.deepEqual(row?.secret, secret);
    assert.equal(row?.savedBy, OTHER_OPERATOR);
    assert.equal((await store.waiting()).length, 1);
  });

  it('refuses a secret the table does not take whole', async () => {
    await assert.rejects(store.saveChannel(slack(sealed({ iv: randomBytes(11) })), OPERATOR, AT));
    await assert.rejects(store.saveChannel(slack(sealed({ authTag: randomBytes(15) })), OPERATOR, AT));
    await assert.rejects(store.saveChannel(slack(sealed({ keyVersion: 0 })), OPERATOR, AT));
    await assert.rejects(store.saveChannel(slack(sealed({ ciphertext: Buffer.alloc(0) })), OPERATOR, AT));
    await assert.rejects(store.saveChannel(slack(), '', AT));
    assert.deepEqual(await store.channels(), []);
  });
});

describe('a channel switched and removed', () => {
  it('switches a saved channel off and on, and answers false for one never saved', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);

    assert.equal(await store.setEnabled('slack', false), true);
    assert.equal((await store.channels())[0]?.enabled, false);
    assert.equal(await store.setEnabled('slack', true), true);
    assert.equal((await store.channels())[0]?.enabled, true);

    assert.equal(await store.setEnabled('telegram', true), false);
    assert.equal(await store.setEnabled('telegram', false), false);
    assert.deepEqual(
      (await store.channels()).map((row) => row.kind),
      ['slack'],
    );
  });

  it("drops the channel's waiting notices when it is switched off, and no other channel's", async () => {
    await store.saveChannel(slack(), OPERATOR, AT);
    await store.saveChannel(telegram(), OPERATOR, AT);
    await store.addWaiting([delivery({ channel: 'slack' }), delivery({ channel: 'telegram' })]);

    await store.setEnabled('slack', true);
    assert.equal((await store.waiting()).length, 2);

    await store.setEnabled('slack', false);
    assert.deepEqual(
      (await store.waiting()).map((row) => row.channel),
      ['telegram'],
    );
  });

  it('removes a channel with its secret and its waiting notices', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);
    await store.saveChannel(telegram(), OPERATOR, AT);
    await store.addWaiting([delivery({ channel: 'slack' }), delivery({ channel: 'telegram' })]);

    await store.removeChannel('slack');
    await store.removeChannel('email');

    assert.deepEqual(
      (await store.channels()).map((row) => row.kind),
      ['telegram'],
    );
    assert.deepEqual(
      (await store.waiting()).map((row) => row.channel),
      ['telegram'],
    );
  });
});

describe('how a channel took its notices', () => {
  it('records a failure, and a later send clears it', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);

    await store.recordFailed('slack', AT, 'Slack answered 500.');
    let [row] = await store.channels();
    assert.equal(row?.lastError, 'Slack answered 500.');
    assert.deepEqual(row?.lastErrorAt, AT);
    assert.equal(row?.lastSentAt, null);

    await store.recordSent('slack', LATER);
    [row] = await store.channels();
    assert.deepEqual(row?.lastSentAt, LATER);
    assert.equal(row?.lastError, null);
    assert.equal(row?.lastErrorAt, null);
  });

  it('writes nothing for a channel never saved', async () => {
    await store.recordSent('email', AT);
    await store.recordFailed('email', AT, 'The email service answered 401.');
    await store.recordTest('email', null);
    assert.deepEqual(await store.channels(), []);
  });
});

describe('test notices', () => {
  it('claims a test for a saved channel, then none until the stretch has passed', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);

    assert.equal(await store.claimTest('slack', AT, 60), true);
    assert.deepEqual((await store.channels())[0]?.lastTestAt, AT);

    assert.equal(await store.claimTest('slack', new Date(AT.getTime() + 59_999), 60), false);
    assert.deepEqual((await store.channels())[0]?.lastTestAt, AT);

    const aMinuteOn = new Date(AT.getTime() + 60_000);
    assert.equal(await store.claimTest('slack', aMinuteOn, 60), true);
    assert.deepEqual((await store.channels())[0]?.lastTestAt, aMinuteOn);
  });

  it('claims nothing for a channel never saved', async () => {
    assert.equal(await store.claimTest('telegram', AT, 60), false);
  });

  it('claims one test of two asked for at once', async () => {
    await store.saveChannel(telegram(), OPERATOR, AT);

    const claims = await Promise.all([store.claimTest('telegram', AT, 60), store.claimTest('telegram', AT, 60)]);
    assert.deepEqual(claims.sort(), [false, true]);
  });

  it("records how the test went, and a new claim clears the last test's error", async () => {
    await store.saveChannel(telegram(), OPERATOR, AT);
    await store.claimTest('telegram', AT, 60);
    await store.recordTest('telegram', 'Telegram answered 403.');
    assert.equal((await store.channels())[0]?.lastTestError, 'Telegram answered 403.');

    await store.claimTest('telegram', LATER, 60);
    let [row] = await store.channels();
    assert.equal(row?.lastTestError, null);
    assert.deepEqual(row?.lastTestAt, LATER);

    await store.recordTest('telegram', null);
    [row] = await store.channels();
    assert.equal(row?.lastTestError, null);
  });

  it("leaves the channel's send state as it was", async () => {
    await store.saveChannel(slack(), OPERATOR, AT);
    await store.recordFailed('slack', AT, 'Slack answered 500.');
    await store.claimTest('slack', LATER, 60);
    await store.recordTest('slack', null);

    const [row] = await store.channels();
    assert.equal(row?.lastSentAt, null);
    assert.equal(row?.lastError, 'Slack answered 500.');
  });
});

describe('waiting notices', () => {
  it('keeps each with its title, text, subjects, moment and error, the earliest raised first', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);
    await store.saveChannel(telegram(), OPERATOR, AT);

    await store.addWaiting([
      delivery({ channel: 'telegram', raisedAt: LATER, subjects: [], error: 'Telegram answered 429.' }),
      delivery({ channel: 'slack', text: 'Line one.\nLine "two" & <three>.' }),
    ]);

    const rows = await store.waiting();
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.id, /^[1-9]\d*$/);
    assert.deepEqual(
      rows.map(({ id: _id, ...row }) => row),
      [
        {
          channel: 'slack',
          title: 'Stamp auto top-up: a top-up failed',
          text: 'Line one.\nLine "two" & <three>.',
          subjects: ['auto-top-up/warning/topup_failed/0xabc', 'auto-top-up/coming/0xabc'],
          raisedAt: AT,
          attempts: 1,
          lastError: 'Slack answered 500.',
        },
        {
          channel: 'telegram',
          title: 'Stamp auto top-up: a top-up failed',
          text: 'The stamp could not be topped up.\nIt is tried again on the next tick.',
          subjects: [],
          raisedAt: LATER,
          attempts: 1,
          lastError: 'Telegram answered 429.',
        },
      ],
    );
  });

  it('adds nothing for an empty list', async () => {
    await store.addWaiting([]);
    assert.deepEqual(await store.waiting(), []);
  });

  it('refuses a notice for a channel never saved, and adds none of the list', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);
    await assert.rejects(store.addWaiting([delivery({ channel: 'slack' }), delivery({ channel: 'email' })]));
    assert.deepEqual(await store.waiting(), []);
  });

  it('counts the waiting notices of each channel that has any', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);
    await store.saveChannel(telegram(), OPERATOR, AT);
    await store.saveChannel(email(), OPERATOR, AT);
    await store.addWaiting([
      delivery({ channel: 'slack' }),
      delivery({ channel: 'slack' }),
      delivery({ channel: 'telegram' }),
    ]);

    assert.deepEqual(
      await store.waitingCounts(),
      new Map([
        ['slack', 2],
        ['telegram', 1],
      ]),
    );
  });

  it('counts a failed try again and keeps its error', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);
    await store.addWaiting([delivery()]);
    const [row] = await store.waiting();

    await store.recordAttempt(row!.id, 'Slack answered 503.');
    await store.recordAttempt(row!.id, 'Slack could not be reached.');
    await store.recordAttempt('not-an-id', 'Ignored.');

    const [tried] = await store.waiting();
    assert.equal(tried?.attempts, 3);
    assert.equal(tried?.lastError, 'Slack could not be reached.');
  });

  it('removes the named notices and keeps the others', async () => {
    await store.saveChannel(slack(), OPERATOR, AT);
    await store.addWaiting([delivery({ title: 'one' }), delivery({ title: 'two' }), delivery({ title: 'three' })]);
    const [one, two] = await store.waiting();

    await store.removeWaiting([one!.id, two!.id, 'not-an-id']);
    await store.removeWaiting([]);

    assert.deepEqual(
      (await store.waiting()).map((row) => row.title),
      ['three'],
    );
  });
});
