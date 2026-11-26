/**
 * The Notifications page's service over the in-memory store, with the real sealing and a fake channel factory. Unit
 * test. `pnpm test`.
 *
 * Pinned here: the view lists every channel, saved or not, and never a secret; a save checks the settings and the
 * secret with the package's rules, every problem at once, seals the secret, switches a first save on and keeps a later
 * one's switch, and keeps the saved secret when none is typed; a switch and a removal ask for nothing more; a test
 * notice goes out on a saved channel, on or off, with its saved values, a minute at most per channel, and records its
 * outcome apart from the notices; without BRAND_WALLET_SECRET nothing is saved or tested; Find chat id reads the
 * Telegram bot's chats with the token typed or the saved one and changes nothing; and no answer, sentence or audit row
 * carries a secret. Every secret here is made up for the test.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { type ChannelConfig, type ChannelFactory, NotificationSendError } from '@streaming-monorepo/notifications';
import { type Notice, noticeProblem, type TelegramChat } from '@streaming-monorepo/web2-admin-common';

import type { OperatorActor } from '../../src/domain/actor.js';
import {
  NotificationChannelNotSavedError,
  NotificationsUnavailableError,
  NotificationTestTooSoonError,
  RequestShapeError,
} from '../../src/domain/errors/index.js';
import {
  channelSecretKeyFrom,
  openChannelSecret,
  sealChannelSecret,
} from '../../src/domain/notifications/channelSecrets.js';
import { NotificationService, testNotice } from '../../src/domain/notifications/NotificationService.js';

import { InMemoryAuditLog } from './support/fakes.js';
import { InMemoryNotificationStore } from './support/notificationFakes.js';

const KEY = channelSecretKeyFrom('ab'.repeat(32));
const OTHER_KEY = channelSecretKeyFrom('cd'.repeat(32));

const ALICE: OperatorActor = { kind: 'operator', userId: '00000000-0000-4000-8000-0000000000a1', username: 'alice' };
const BOB: OperatorActor = { kind: 'operator', userId: '00000000-0000-4000-8000-0000000000b2', username: 'bob' };

const EMAIL_KEY = `test-key-${'k'.repeat(40)}`;
const SLACK_URL = 'https://hooks.slack.com/services/T0001/B0001/abcdefABCDEF0123456789xy';
const OTHER_SLACK_URL = 'https://hooks.slack.com/services/T0002/B0002/zyxwvuZYXWVU9876543210ab';
const TELEGRAM_TOKEN = `1234567890:${'A'.repeat(35)}`;

const EMAIL_SETTINGS = {
  provider: 'brevo',
  senderAddress: 'alerts@example.org',
  senderName: 'Stream alerts',
  recipients: ['ops@example.org', 'dev@example.org'],
} as const;
const TELEGRAM_SETTINGS = { chatId: '-1001234567890' } as const;

const START = Date.parse('2026-11-25T10:00:00.000Z');

/** A channel factory that keeps what it was given and what it sent, and fails each send while `failWith` is set. */
class FakeChannels {
  readonly configs: ChannelConfig[] = [];
  readonly sent: { kind: string; notice: Notice }[] = [];
  failWith: unknown = null;

  readonly channelFrom: ChannelFactory = (config) => {
    this.configs.push(structuredClone(config));
    return {
      kind: config.kind,
      send: async (notice: Notice) => {
        if (this.failWith !== null) throw this.failWith;
        this.sent.push({ kind: config.kind, notice });
      },
    };
  };
}

let clock: { now: number };
let store: InMemoryNotificationStore;
let audit: InMemoryAuditLog;
let channels: FakeChannels;
let service: NotificationService;

function serviceWith(secretKey: Buffer | null): NotificationService {
  return new NotificationService({
    store,
    secretKey,
    channelFrom: channels.channelFrom,
    audit,
    now: () => clock.now,
  });
}

beforeEach(() => {
  clock = { now: START };
  store = new InMemoryNotificationStore();
  audit = new InMemoryAuditLog();
  channels = new FakeChannels();
  service = serviceWith(KEY);
});

/** Everything a caller or a reader of the audit trail could see, as one text to look for a secret in. */
function seen(...values: unknown[]): string {
  return JSON.stringify([...values, audit.entries]);
}

function assertNoSecret(text: string): void {
  for (const secret of [EMAIL_KEY, SLACK_URL, OTHER_SLACK_URL, TELEGRAM_TOKEN]) {
    assert.ok(!text.includes(secret), 'a secret was seen');
    assert.ok(!text.includes(encodeURIComponent(secret)), 'a secret was seen, URL-encoded');
  }
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a refusal');
}

describe('the view', () => {
  it('lists every channel in order, saved or not, and says channels can be saved under BRAND_WALLET_SECRET', async () => {
    const view = await service.view();

    assert.equal(view.available, true);
    assert.deepEqual(
      view.channels.map((channel) => channel.kind),
      ['email', 'slack', 'telegram'],
    );
    for (const channel of view.channels) {
      assert.deepEqual(
        { ...channel, kind: 'any' },
        {
          kind: 'any',
          saved: false,
          enabled: false,
          lastSentAt: null,
          lastError: null,
          lastErrorAt: null,
          waiting: 0,
          settings: null,
          savedBy: null,
          savedAt: null,
          lastTestAt: null,
          lastTestError: null,
        },
      );
    }
  });

  it('shows a saved channel whole: its settings, who saved it, how it sent, what waits and its last test', async () => {
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    await store.recordSent('telegram', new Date(START + 1000));
    await store.recordFailed('telegram', new Date(START + 2000), 'Telegram answered 400: chat not found');
    await store.addWaiting([
      {
        channel: 'telegram',
        title: 'Stamp auto top-up: a warning',
        text: 'A warning stands.',
        subjects: ['warning:1'],
        raisedAt: new Date(START),
        error: 'Telegram answered 400: chat not found',
      },
    ]);
    clock.now += 5000;
    await service.test(BOB, 'telegram');

    const view = await service.view();
    const telegram = view.channels[2];

    assert.deepEqual(telegram, {
      kind: 'telegram',
      saved: true,
      enabled: true,
      lastSentAt: '2026-11-25T10:00:01.000Z',
      lastError: 'Telegram answered 400: chat not found',
      lastErrorAt: '2026-11-25T10:00:02.000Z',
      waiting: 1,
      settings: { chatId: '-1001234567890' },
      savedBy: 'alice',
      savedAt: '2026-11-25T10:00:00.000Z',
      lastTestAt: '2026-11-25T10:00:05.000Z',
      lastTestError: null,
    });
    assert.equal(view.channels[0]!.saved, false);
    const row = store.channelRows.get('telegram')!;
    const text = JSON.stringify(view);
    assertNoSecret(text);
    for (const bytes of [row.secret.ciphertext, row.secret.iv, row.secret.authTag]) {
      assert.ok(!text.includes(bytes.toString('hex')) && !text.includes(bytes.toString('base64')));
    }
  });

  it('says no channel can be saved without BRAND_WALLET_SECRET, and still lists the ones saved under it', async () => {
    await service.save(ALICE, 'slack', { settings: {}, secret: SLACK_URL });

    const view = await serviceWith(null).view();

    assert.equal(view.available, false);
    assert.equal(view.channels[1]!.saved, true);
    assert.equal(view.channels[1]!.enabled, true);
  });
});

describe('saving a channel', () => {
  it('keeps the settings as the rules leave them, seals the secret, and switches a first save on', async () => {
    const view = await service.save(ALICE, 'email', {
      settings: {
        ...EMAIL_SETTINGS,
        senderAddress: ' Alerts@Example.ORG ',
        senderName: ' Stream alerts ',
        recipients: [' OPS@example.org', 'dev@example.org '],
        extra: 'dropped',
      },
      secret: `  ${EMAIL_KEY}  `,
    });

    const row = store.channelRows.get('email')!;
    assert.deepEqual(row.settings, EMAIL_SETTINGS);
    assert.equal(row.enabled, true);
    assert.equal(row.savedBy, 'alice');
    assert.equal(row.savedAt.getTime(), START);
    assert.equal(openChannelSecret('email', row.secret, KEY), EMAIL_KEY);
    assert.ok(!row.secret.ciphertext.toString('utf8').includes(EMAIL_KEY));
    assert.deepEqual(view.channels[0]!.settings, EMAIL_SETTINGS);
    assert.equal(view.channels[0]!.enabled, true);
  });

  it('keeps a later save’s switch and send state, and a switched-off channel stays off', async () => {
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    await store.recordSent('telegram', new Date(START + 1000));
    clock.now += 60_000;

    await service.save(BOB, 'telegram', { settings: { chatId: '@streamalerts' }, secret: null });

    let row = store.channelRows.get('telegram')!;
    assert.deepEqual(row.settings, { chatId: '@streamalerts' });
    assert.equal(row.enabled, true);
    assert.equal(row.lastSentAt?.getTime(), START + 1000);
    assert.equal(row.savedBy, 'bob');
    assert.equal(row.savedAt.getTime(), START + 60_000);

    await service.setEnabled(ALICE, 'telegram', false);
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: null });

    row = store.channelRows.get('telegram')!;
    assert.equal(row.enabled, false);
  });

  it('keeps the saved secret when the secret is null, empty or spaces, and replaces it when one is typed', async () => {
    await service.save(ALICE, 'slack', { settings: {}, secret: SLACK_URL });

    for (const secret of [null, '', '   ']) {
      await service.save(ALICE, 'slack', { settings: {}, secret });
      assert.equal(openChannelSecret('slack', store.channelRows.get('slack')!.secret, KEY), SLACK_URL);
    }
    await service.save(ALICE, 'slack', { settings: {}, secret: OTHER_SLACK_URL });

    assert.equal(openChannelSecret('slack', store.channelRows.get('slack')!.secret, KEY), OTHER_SLACK_URL);
    assert.deepEqual(
      audit.withAction('notification.channel.save').map((entry) => entry.details),
      [
        { kind: 'slack', settings: {}, secret: 'set' },
        { kind: 'slack', settings: {}, secret: 'kept' },
        { kind: 'slack', settings: {}, secret: 'kept' },
        { kind: 'slack', settings: {}, secret: 'kept' },
        { kind: 'slack', settings: {}, secret: 'replaced' },
      ],
    );
    assert.ok(audit.entries.every((entry) => entry.actor === ALICE));
    assertNoSecret(seen());
  });

  it('refuses every problem of the settings and the secret at once, and saves nothing', async () => {
    const error = await caught(
      service.save(ALICE, 'email', {
        settings: { ...EMAIL_SETTINGS, senderAddress: 'not an address', recipients: [] },
        secret: 'too short',
      }),
    );

    assert.ok(error instanceof RequestShapeError);
    assert.deepEqual(error.problems, [
      'The sender address: Enter an email address such as name@example.org.',
      'Enter one recipient or more.',
      'Enter the API key the email service gave: one line of 20 characters or more, with no space.',
    ]);
    assert.equal(store.channelRows.size, 0);
    assert.equal(audit.entries.length, 0);
  });

  it('refuses a first save with no secret, beside the settings’ own problems', async () => {
    const error = await caught(service.save(ALICE, 'telegram', { settings: { chatId: 'my chat' }, secret: null }));

    assert.ok(error instanceof RequestShapeError);
    assert.deepEqual(error.problems, [
      "The chat id is a whole number, such as -1001234567890 for a group, or a public channel's name, such as @channelname.",
      'Enter the Bot token: the Telegram channel has none saved yet.',
    ]);
    assert.equal(store.channelRows.size, 0);
  });

  it('refuses settings of another shape, and a secret of another channel', async () => {
    for (const settings of [null, 'chat', ['-1001234567890']]) {
      const error = await caught(service.save(ALICE, 'telegram', { settings, secret: TELEGRAM_TOKEN }));
      assert.ok(error instanceof RequestShapeError, JSON.stringify(settings));
      assert.deepEqual(error.problems, ['The Telegram settings are missing.']);
    }
    const error = await caught(service.save(ALICE, 'slack', { settings: {}, secret: TELEGRAM_TOKEN }));
    assert.ok(error instanceof RequestShapeError);
    assert.equal(error.problems.length, 1);
    assertNoSecret(JSON.stringify(error.problems));
    assert.equal(store.channelRows.size, 0);
  });

  it('is refused without BRAND_WALLET_SECRET, before anything is checked or saved', async () => {
    const error = await caught(
      serviceWith(null).save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN }),
    );

    assert.ok(error instanceof NotificationsUnavailableError);
    assert.match(error.message, /BRAND_WALLET_SECRET/);
    assert.equal(store.channelRows.size, 0);
    assert.equal(audit.entries.length, 0);
  });

  it('audits the stored settings and that a secret was set, never the secret', async () => {
    await service.save(ALICE, 'email', { settings: EMAIL_SETTINGS, secret: EMAIL_KEY });

    assert.deepEqual(audit.entries, [
      {
        actor: ALICE,
        action: 'notification.channel.save',
        details: { kind: 'email', settings: EMAIL_SETTINGS, secret: 'set' },
      },
    ]);
    assertNoSecret(seen());
  });
});

describe('switching a channel on and off', () => {
  it('switches a saved channel, and off drops the notices that wait for it', async () => {
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    await store.addWaiting([
      {
        channel: 'telegram',
        title: 'A notice',
        text: 'It waits.',
        subjects: ['warning:1'],
        raisedAt: new Date(START),
        error: 'Telegram answered 502',
      },
    ]);

    const off = await service.setEnabled(BOB, 'telegram', false);
    assert.equal(off.channels[2]!.enabled, false);
    assert.equal(off.channels[2]!.waiting, 0);
    const on = await service.setEnabled(BOB, 'telegram', true);
    assert.equal(on.channels[2]!.enabled, true);

    assert.deepEqual(
      audit.withAction('notification.channel.enabled').map((entry) => [entry.actor, entry.details]),
      [
        [BOB, { kind: 'telegram', enabled: false }],
        [BOB, { kind: 'telegram', enabled: true }],
      ],
    );
  });

  it('refuses a channel never saved, and audits nothing', async () => {
    const error = await caught(service.setEnabled(ALICE, 'slack', true));

    assert.ok(error instanceof NotificationChannelNotSavedError);
    assert.equal(error.kind, 'slack');
    assert.equal(error.message, 'The Slack channel is not saved. Save it first.');
    assert.equal(audit.entries.length, 0);
  });

  it('works without BRAND_WALLET_SECRET', async () => {
    await service.save(ALICE, 'slack', { settings: {}, secret: SLACK_URL });

    const view = await serviceWith(null).setEnabled(ALICE, 'slack', false);

    assert.equal(view.channels[1]!.enabled, false);
  });
});

describe('removing a channel', () => {
  it('deletes the channel with its secret and the notices that wait for it', async () => {
    await service.save(ALICE, 'email', { settings: EMAIL_SETTINGS, secret: EMAIL_KEY });
    await store.addWaiting([
      {
        channel: 'email',
        title: 'A notice',
        text: 'It waits.',
        subjects: ['warning:1'],
        raisedAt: new Date(START),
        error: 'Brevo answered 401',
      },
    ]);

    const view = await serviceWith(null).remove(BOB, 'email');

    assert.equal(store.channelRows.has('email'), false);
    assert.deepEqual(store.waitingRows, []);
    assert.equal(view.channels[0]!.saved, false);
    assert.deepEqual(audit.withAction('notification.channel.remove'), [
      { actor: BOB, action: 'notification.channel.remove', details: { kind: 'email' } },
    ]);
  });

  it('answers the view for a channel that was not saved, and audits nothing', async () => {
    const view = await service.remove(ALICE, 'slack');

    assert.equal(view.channels[1]!.saved, false);
    assert.equal(audit.entries.length, 0);
  });
});

describe('a test notice', () => {
  it('goes out with the saved settings and secret, and says who asked for it and when', async () => {
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    clock.now = Date.parse('2026-11-25T14:10:42.000Z');

    const answer = await service.test(BOB, 'telegram');

    assert.deepEqual(channels.configs, [{ kind: 'telegram', settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN }]);
    assert.deepEqual(channels.sent, [
      {
        kind: 'telegram',
        notice: {
          title: 'Test notice from the admin',
          text: "bob sent this test notice from the Notifications page at 2026-11-25 14:10 UTC. The admin's notices will reach you here.",
        },
      },
    ]);
    assert.equal(answer.sent, true);
    assert.equal(answer.error, null);
    assert.equal(answer.view.channels[2]!.lastTestAt, '2026-11-25T14:10:42.000Z');
    assert.equal(answer.view.channels[2]!.lastTestError, null);
    assert.deepEqual(audit.withAction('notification.channel.test'), [
      { actor: BOB, action: 'notification.channel.test', details: { kind: 'telegram', sent: true, error: null } },
    ]);
  });

  it('is a notice the channels take', () => {
    assert.equal(noticeProblem(testNotice(ALICE, new Date(START))), null);
  });

  it('goes out on a channel that is off', async () => {
    await service.save(ALICE, 'slack', { settings: {}, secret: SLACK_URL });
    await service.setEnabled(ALICE, 'slack', false);

    const answer = await service.test(ALICE, 'slack');

    assert.equal(answer.sent, true);
    assert.equal(channels.sent.length, 1);
    assert.equal(answer.view.channels[1]!.enabled, false);
  });

  it('counts as no notice: the send state and the waiting notices stay as they were, sent or failed', async () => {
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    await store.recordSent('telegram', new Date(START - 1000));
    await store.recordFailed('telegram', new Date(START - 500), 'Telegram answered 502');
    await store.addWaiting([
      {
        channel: 'telegram',
        title: 'A notice',
        text: 'It waits.',
        subjects: ['warning:1'],
        raisedAt: new Date(START - 2000),
        error: 'Telegram answered 502',
      },
    ]);
    const before = { ...store.channelRows.get('telegram')! };
    const waitingBefore = structuredClone(store.waitingRows);

    await service.test(ALICE, 'telegram');
    clock.now += 60_000;
    channels.failWith = new NotificationSendError('Telegram answered 401: Unauthorized', { status: 401 });
    await service.test(ALICE, 'telegram');

    const after = store.channelRows.get('telegram')!;
    assert.equal(after.lastSentAt?.getTime(), before.lastSentAt?.getTime());
    assert.equal(after.lastError, before.lastError);
    assert.equal(after.lastErrorAt?.getTime(), before.lastErrorAt?.getTime());
    assert.deepEqual(store.waitingRows, waitingBefore);
    assert.equal(after.lastTestError, 'Telegram answered 401: Unauthorized');
  });

  it('goes out a minute at most on a channel, and says when the next one may', async () => {
    await service.save(ALICE, 'slack', { settings: {}, secret: SLACK_URL });
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    await service.test(ALICE, 'slack');

    clock.now = START + 30_000;
    let error = await caught(service.test(ALICE, 'slack'));
    assert.ok(error instanceof NotificationTestTooSoonError);
    assert.equal(error.kind, 'slack');
    assert.equal(error.retryAfterSeconds, 30);
    assert.equal(
      error.message,
      'A test notice went out on the Slack channel less than a minute ago. Send the next one in 30 seconds.',
    );
    assert.equal((await service.test(ALICE, 'telegram')).sent, true, 'another channel is not held up');

    clock.now = START + 59_500;
    error = await caught(service.test(ALICE, 'slack'));
    assert.ok(error instanceof NotificationTestTooSoonError);
    assert.equal(error.retryAfterSeconds, 1);
    assert.match(error.message, /in 1 second\.$/);

    clock.now = START + 60_000;
    assert.equal((await service.test(ALICE, 'slack')).sent, true);
    assert.equal(channels.sent.filter((sent) => sent.kind === 'slack').length, 2);
    assert.equal(audit.withAction('notification.channel.test').length, 3, 'a refused test is not audited');
  });

  it('sends one of two tests asked for at once', async () => {
    await service.save(ALICE, 'slack', { settings: {}, secret: SLACK_URL });

    const outcomes = await Promise.allSettled([service.test(ALICE, 'slack'), service.test(BOB, 'slack')]);

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.ok(refused?.reason instanceof NotificationTestTooSoonError);
    assert.equal(channels.sent.length, 1);
  });

  it('answers and records why the service could not take it, with the secret cut out', async () => {
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    channels.failWith = new NotificationSendError(
      `Telegram answered 401 for bot${TELEGRAM_TOKEN} and ${encodeURIComponent(TELEGRAM_TOKEN)}: Unauthorized`,
      { status: 401 },
    );

    const answer = await service.test(ALICE, 'telegram');

    const sentence = 'Telegram answered 401 for bot[secret] and [secret]: Unauthorized';
    assert.equal(answer.sent, false);
    assert.equal(answer.error, sentence);
    assert.equal(answer.view.channels[2]!.lastTestError, sentence);
    assert.deepEqual(audit.withAction('notification.channel.test')[0]!.details, {
      kind: 'telegram',
      sent: false,
      error: sentence,
    });
    assertNoSecret(seen(answer));
  });

  it('shows a sentence of its own for an error that is not a send’s', async () => {
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    channels.failWith = new TypeError(`fetch failed for https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);

    const answer = await service.test(ALICE, 'telegram');

    assert.equal(answer.sent, false);
    assert.equal(
      answer.error,
      'The test notice could not be sent: the admin met an error of its own. Its log has more.',
    );
    assertNoSecret(seen(answer));
  });

  it('answers the sentence of a secret saved under another BRAND_WALLET_SECRET, and calls no service', async () => {
    await store.saveChannel(
      { kind: 'slack', settings: {}, secret: sealChannelSecret('slack', SLACK_URL, OTHER_KEY) },
      'alice',
      new Date(START),
    );

    const answer = await service.test(ALICE, 'slack');

    assert.equal(answer.sent, false);
    assert.match(answer.error ?? '', /does not open with this BRAND_WALLET_SECRET/);
    assert.equal(channels.configs.length, 0);
    assert.equal(answer.view.channels[1]!.lastTestError, answer.error);
    assertNoSecret(seen(answer));
  });

  it('is refused for a channel not saved', async () => {
    const error = await caught(service.test(ALICE, 'email'));

    assert.ok(error instanceof NotificationChannelNotSavedError);
    assert.equal(error.kind, 'email');
    assert.equal(channels.configs.length, 0);
    assert.equal(audit.entries.length, 0);
  });

  it('is refused without BRAND_WALLET_SECRET, and claims and sends nothing', async () => {
    await service.save(ALICE, 'slack', { settings: {}, secret: SLACK_URL });

    const error = await caught(serviceWith(null).test(ALICE, 'slack'));

    assert.ok(error instanceof NotificationsUnavailableError);
    assert.equal(store.channelRows.get('slack')!.lastTestAt, null);
    assert.equal(channels.configs.length, 0);
  });
});

describe('Find chat id', () => {
  const CHATS: TelegramChat[] = [
    { id: '111111111', kind: 'private', name: 'Ada Lovelace (@ada)' },
    { id: '-1001234567890', kind: 'supergroup', name: 'Stream ops' },
  ];

  /** The service with a lookup that keeps the tokens it was handed, and answers `answer` or fails with it. */
  function withLookup(answer: TelegramChat[] | Error, secretKey: Buffer | null = KEY) {
    const tokens: string[] = [];
    const lookups = new NotificationService({
      store,
      secretKey,
      channelFrom: channels.channelFrom,
      audit,
      now: () => clock.now,
      findTelegramChats: async (token) => {
        tokens.push(token);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    return { lookups, tokens };
  }

  it('reads the chats with the token as typed, trimmed, and changes and audits nothing', async () => {
    const { lookups, tokens } = withLookup(CHATS);

    const answer = await lookups.telegramChats(ALICE, `  ${TELEGRAM_TOKEN}  `);

    assert.deepEqual(answer, { chats: CHATS, error: null });
    assert.deepEqual(tokens, [TELEGRAM_TOKEN]);
    assert.equal(store.channelRows.size, 0);
    assert.equal(audit.entries.length, 0);
  });

  it('reads them with a typed token without BRAND_WALLET_SECRET, since nothing is opened or sealed', async () => {
    const { lookups, tokens } = withLookup(CHATS, null);

    assert.deepEqual(await lookups.telegramChats(ALICE, TELEGRAM_TOKEN), { chats: CHATS, error: null });
    assert.deepEqual(tokens, [TELEGRAM_TOKEN]);
  });

  it("reads them with the saved channel's token when none is typed", async () => {
    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    const { lookups, tokens } = withLookup(CHATS);

    for (const typed of [null, '', '   ']) {
      assert.deepEqual(await lookups.telegramChats(BOB, typed), { chats: CHATS, error: null });
    }
    assert.deepEqual(tokens, [TELEGRAM_TOKEN, TELEGRAM_TOKEN, TELEGRAM_TOKEN]);
    assert.equal(audit.entries.length, 1);
  });

  it('refuses a typed token the rules refuse, and asks Telegram nothing', async () => {
    const { lookups, tokens } = withLookup(CHATS);

    for (const typed of ['not a token', `${TELEGRAM_TOKEN}/../getMe`, SLACK_URL]) {
      const error = await caught(lookups.telegramChats(ALICE, typed));
      assert.ok(error instanceof RequestShapeError);
      assert.deepEqual(error.problems, [
        "Enter the bot's token as BotFather gave it: the bot's number, a colon, and its key.",
      ]);
    }
    assert.deepEqual(tokens, []);
  });

  it('is refused with none typed: without BRAND_WALLET_SECRET, and for a channel never saved', async () => {
    const { lookups, tokens } = withLookup(CHATS);
    const notSaved = await caught(lookups.telegramChats(ALICE, null));
    assert.ok(notSaved instanceof NotificationChannelNotSavedError);
    assert.equal(notSaved.kind, 'telegram');

    await service.save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    const unavailable = await caught(withLookup(CHATS, null).lookups.telegramChats(ALICE, null));
    assert.ok(unavailable instanceof NotificationsUnavailableError);
    assert.deepEqual(tokens, []);
  });

  it('answers the sentence of a token saved under another BRAND_WALLET_SECRET, and asks Telegram nothing', async () => {
    await serviceWith(OTHER_KEY).save(ALICE, 'telegram', { settings: TELEGRAM_SETTINGS, secret: TELEGRAM_TOKEN });
    const { lookups, tokens } = withLookup(CHATS);

    const answer = await lookups.telegramChats(ALICE, null);

    assert.deepEqual(answer.chats, []);
    assert.match(answer.error ?? '', /^The telegram channel's secret does not open with this BRAND_WALLET_SECRET/);
    assert.deepEqual(tokens, []);
    assertNoSecret(seen(answer));
  });

  it('answers why Telegram could not be asked, with the token cut out', async () => {
    const refusal = new NotificationSendError(`Telegram answered with status 404: Not Found: bot${TELEGRAM_TOKEN}.`, {
      status: 404,
    });
    const { lookups } = withLookup(refusal);

    const answer = await lookups.telegramChats(ALICE, TELEGRAM_TOKEN);

    assert.deepEqual(answer, { chats: [], error: 'Telegram answered with status 404: Not Found: bot[secret].' });
    assertNoSecret(seen(answer));
  });

  it("answers a sentence of its own for an error that is not Telegram's", async () => {
    const { lookups } = withLookup(new Error(`socket closed for bot${TELEGRAM_TOKEN}`));

    const answer = await lookups.telegramChats(ALICE, TELEGRAM_TOKEN);

    assert.deepEqual(answer, {
      chats: [],
      error: "The bot's chats could not be read: the admin met an error of its own. Its log has more.",
    });
  });
});
