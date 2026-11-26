/**
 * The admin's notifier: a notice goes out on every channel that is on, side by side; each channel's outcome is
 * recorded; a notice another channel took waits for the one that failed, and is tried again with a line that says when
 * it was raised, until it is a day old or nothing it tells of stands. Unit test on the in-memory store and a fake
 * channel factory. `pnpm test`. Every secret here is made up for the test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NotificationSendError,
  type Channel,
  type ChannelConfig,
  type ChannelFactory,
} from '@streaming-monorepo/notifications';
import {
  NOTIFICATION_WAIT_SECONDS,
  type Notice,
  type NotificationChannelKind,
} from '@streaming-monorepo/web2-admin-common';

import { NotificationDispatcher, lateNoticeText } from '../../src/domain/notifications/NotificationDispatcher.js';
import type { OutgoingNotice } from '../../src/domain/notifications/Notifier.js';
import { channelSecretKeyFrom, sealChannelSecret } from '../../src/domain/notifications/channelSecrets.js';

import { InMemoryNotificationStore } from './support/notificationFakes.js';

const KEY = channelSecretKeyFrom('ab'.repeat(32));
const SECRETS = {
  email: 'xkeysib-made-up-for-the-test',
  slack: 'https://hooks.slack.com/services/T000/B000/made-up-for-the-test',
  telegram: `1234567890:${'A'.repeat(35)}`,
} as const;
const SETTINGS = {
  email: {
    provider: 'brevo' as const,
    senderAddress: 'alerts@example.com',
    senderName: '',
    recipients: ['ops@example.com'],
  },
  slack: {},
  telegram: { chatId: '-1001234567890' },
};

const NOW = new Date('2026-11-25T12:00:00Z');
const HOUR_MS = 3600 * 1000;

type Behaviour = 'take' | 'fail' | 'throw';

/** A channel factory whose channels take or refuse as told, and record what they were built from and sent. */
class FakeChannels {
  behaviour: Record<NotificationChannelKind, Behaviour> = { email: 'take', slack: 'take', telegram: 'take' };
  readonly configs: ChannelConfig[] = [];
  readonly sent: { kind: NotificationChannelKind; notice: Notice }[] = [];
  /** What a channel's send waits on before it answers, by kind. */
  readonly gates = new Map<NotificationChannelKind, () => Promise<void>>();

  readonly factory: ChannelFactory = (config) => {
    this.configs.push(config);
    const channel: Channel = {
      kind: config.kind,
      send: async (notice) => {
        this.sent.push({ kind: config.kind, notice });
        await this.gates.get(config.kind)?.();
        switch (this.behaviour[config.kind]) {
          case 'take':
            return;
          case 'fail':
            throw new NotificationSendError(`The ${config.kind} service answered 500: down for the test.`, {
              status: 500,
            });
          case 'throw':
            throw new Error(`boom with ${config.secret}`);
        }
      },
    };
    return channel;
  };
}

function logger() {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  return { lines, info: write, warn: write };
}

async function save(store: InMemoryNotificationStore, ...kinds: NotificationChannelKind[]): Promise<void> {
  for (const kind of kinds) {
    const secret = sealChannelSecret(kind, SECRETS[kind], KEY);
    if (kind === 'email') await store.saveChannel({ kind, settings: SETTINGS.email, secret }, 'operator', NOW);
    if (kind === 'slack') await store.saveChannel({ kind, settings: SETTINGS.slack, secret }, 'operator', NOW);
    if (kind === 'telegram') await store.saveChannel({ kind, settings: SETTINGS.telegram, secret }, 'operator', NOW);
  }
}

function setUp(options: { key?: Buffer | null } = {}) {
  const store = new InMemoryNotificationStore();
  const channels = new FakeChannels();
  const log = logger();
  const dispatcher = new NotificationDispatcher({
    store,
    key: options.key === undefined ? KEY : options.key,
    channelFrom: channels.factory,
    logger: log,
    now: () => NOW,
  });
  return { store, channels, log, dispatcher };
}

/** A notice of one part for each subject, which reads the same whichever of its parts it is written from. */
function notice(
  overrides: { title?: string; text?: string; raisedAt?: Date; subjects?: readonly string[] } = {},
): OutgoingNotice {
  const written: Notice = {
    title: overrides.title ?? 'Stamp auto top-up: a top-up failed',
    text: overrides.text ?? 'The catalogue batch could not be topped up.',
  };
  return {
    raisedAt: overrides.raisedAt ?? NOW,
    parts: (overrides.subjects ?? ['auto-top-up/warning/topup_failed/0x01']).map((subject) => ({
      topic: 'topup_failed' as const,
      subject,
      item: null,
    })),
    compose: () => written,
  };
}

/** The outcome of a notice of one part: how many channels were on, and how many took it and could not. */
function outcomeOf(
  people: number,
  sent: number,
  failed: number,
  subjects: readonly string[] = ['auto-top-up/warning/topup_failed/0x01'],
) {
  return { parts: subjects.map((subject) => ({ subject, people, taken: sent > 0 })), sent, failed };
}

describe('NotificationDispatcher.on', () => {
  it('is off with no channel saved, and with every saved channel switched off', async () => {
    const { store, dispatcher } = setUp();
    assert.equal(await dispatcher.on('topup_failed'), false);
    await save(store, 'slack');
    await store.setEnabled('slack', false);
    assert.equal(await dispatcher.on('topup_failed'), false);
  });

  it('is on once one saved channel is', async () => {
    const { store, dispatcher } = setUp();
    await save(store, 'slack', 'telegram');
    await store.setEnabled('slack', false);
    assert.equal(await dispatcher.on('topup_failed'), true);
  });
});

describe('NotificationDispatcher.notify', () => {
  it('with no channel on, sends nothing, keeps nothing and answers not notified', async () => {
    const { store, channels, dispatcher } = setUp();
    await save(store, 'email');
    await store.setEnabled('email', false);
    const outcome = await dispatcher.notify(notice());
    assert.deepEqual(outcome, outcomeOf(0, 0, 0));
    assert.equal(channels.sent.length, 0);
    assert.equal(store.waitingRows.length, 0);
  });

  it('sends the title and the text on every channel that is on, built from its settings and its opened secret', async () => {
    const { store, channels, dispatcher } = setUp();
    await save(store, 'email', 'slack', 'telegram');
    await store.setEnabled('slack', false);
    const outcome = await dispatcher.notify(notice());

    assert.deepEqual(outcome, outcomeOf(2, 2, 0));
    assert.deepEqual(
      channels.configs.map((config) => [config.kind, config.secret, config.settings]),
      [
        ['email', SECRETS.email, SETTINGS.email],
        ['telegram', SECRETS.telegram, SETTINGS.telegram],
      ],
    );
    for (const sent of channels.sent) {
      assert.deepEqual(sent.notice, {
        title: 'Stamp auto top-up: a top-up failed',
        text: 'The catalogue batch could not be topped up.',
      });
    }
    assert.deepEqual(store.channelRows.get('email')?.lastSentAt, NOW);
    assert.deepEqual(store.channelRows.get('telegram')?.lastSentAt, NOW);
    assert.equal(store.channelRows.get('slack')?.lastSentAt, null);
    assert.equal(store.waitingRows.length, 0);
  });

  it('calls the channels side by side, so one that is slow holds up none of the others', async () => {
    const { store, channels, dispatcher } = setUp();
    await save(store, 'email', 'telegram');
    // Email, called first, answers only once Telegram has been called: one after the other, it would never answer.
    let telegramCalled!: () => void;
    const called = new Promise<void>((resolve) => {
      telegramCalled = resolve;
    });
    channels.gates.set('email', async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          called,
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error('called one after the other')), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    channels.gates.set('telegram', async () => telegramCalled());
    const outcome = await dispatcher.notify(notice());
    assert.deepEqual(outcome, outcomeOf(2, 2, 0));
  });

  it('keeps the notice for a channel that failed while another took it, with its subjects and when it was raised', async () => {
    const { store, channels, dispatcher } = setUp();
    await save(store, 'email', 'slack', 'telegram');
    channels.behaviour.slack = 'fail';
    const raisedAt = new Date(NOW.getTime() - HOUR_MS);
    const subjects = ['auto-top-up/warning/wallet_xbzz/', 'auto-top-up/warning/topup_failed/0x01'];
    const outcome = await dispatcher.notify(notice({ raisedAt, subjects }));

    const error = 'The slack service answered 500: down for the test.';
    assert.deepEqual(outcome, outcomeOf(3, 2, 1, subjects));
    assert.equal(store.channelRows.get('slack')?.lastError, error);
    assert.deepEqual(store.channelRows.get('slack')?.lastErrorAt, NOW);
    assert.deepEqual(
      store.waitingRows.map(({ id: _id, ...row }) => row),
      [
        {
          channel: 'slack',
          title: 'Stamp auto top-up: a top-up failed',
          text: 'The catalogue batch could not be topped up.',
          subjects,
          raisedAt,
          attempts: 1,
          lastError: error,
        },
      ],
    );
  });

  it('keeps nothing when no channel took the notice, and records why on each', async () => {
    const { store, channels, dispatcher } = setUp();
    await save(store, 'email', 'telegram');
    channels.behaviour.email = 'fail';
    channels.behaviour.telegram = 'fail';
    const outcome = await dispatcher.notify(notice());
    assert.deepEqual(outcome, outcomeOf(2, 0, 2));
    assert.equal(store.waitingRows.length, 0);
    assert.match(store.channelRows.get('email')?.lastError ?? '', /email service answered 500/);
    assert.match(store.channelRows.get('telegram')?.lastError ?? '', /telegram service answered 500/);
  });

  it('clears the error a channel recorded once it takes a notice', async () => {
    const { store, channels, dispatcher } = setUp();
    await save(store, 'telegram');
    channels.behaviour.telegram = 'fail';
    await dispatcher.notify(notice());
    channels.behaviour.telegram = 'take';
    await dispatcher.notify(notice());
    assert.equal(store.channelRows.get('telegram')?.lastError, null);
  });

  it('words an unexpected error in a fixed sentence, so no secret reaches the row, the outcome or the log', async () => {
    const { store, channels, log, dispatcher } = setUp();
    await save(store, 'slack', 'telegram');
    channels.behaviour.telegram = 'throw';
    const outcome = await dispatcher.notify(notice());

    const error = 'The telegram channel could not send the notice: an unexpected error.';
    assert.deepEqual(outcome, outcomeOf(2, 1, 1));
    assert.equal(store.channelRows.get('telegram')?.lastError, error);
    assert.equal(store.waitingRows[0]?.lastError, error);
    const everything = JSON.stringify({ outcome, rows: [...store.channelRows.values()], log: log.lines });
    for (const secret of Object.values(SECRETS)) assert.equal(everything.includes(secret), false);
  });

  it('with no key, builds no channel and fails each in a sentence that names BRAND_WALLET_SECRET', async () => {
    const { store, channels, dispatcher } = setUp({ key: null });
    await save(store, 'email');
    const outcome = await dispatcher.notify(notice());
    assert.deepEqual(outcome, outcomeOf(1, 0, 1));
    assert.equal(channels.configs.length, 0);
    assert.match(store.channelRows.get('email')?.lastError ?? '', /BRAND_WALLET_SECRET/);
  });

  it('fails a channel whose secret does not open under the key', async () => {
    const { store, channels, dispatcher } = setUp({ key: channelSecretKeyFrom('cd'.repeat(32)) });
    await save(store, 'email');
    const outcome = await dispatcher.notify(notice());
    assert.deepEqual(outcome, outcomeOf(1, 0, 1));
    assert.equal(channels.configs.length, 0);
    assert.match(store.channelRows.get('email')?.lastError ?? '', /does not open/);
  });
});

describe('NotificationDispatcher.retryWaiting', () => {
  /** Email took a notice and Telegram could not: it waits for Telegram. */
  async function waitingForTelegram(subjects: readonly string[], raisedAt = NOW) {
    const setup = setUp();
    await save(setup.store, 'email', 'telegram');
    setup.channels.behaviour.telegram = 'fail';
    await setup.dispatcher.notify(notice({ subjects, raisedAt }));
    setup.channels.behaviour.telegram = 'take';
    setup.channels.sent.length = 0;
    return setup;
  }

  it('sends a waiting notice on its channel alone, with a first line that says when it was raised', async () => {
    const raisedAt = new Date(NOW.getTime() - 2 * HOUR_MS);
    const { store, channels, dispatcher } = await waitingForTelegram(['a'], raisedAt);
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const outcome = await dispatcher.retryWaiting(later, () => true);

    assert.deepEqual(outcome, { sent: 1, dropped: 0, waiting: 0 });
    assert.deepEqual(channels.sent, [
      {
        kind: 'telegram',
        notice: {
          title: 'Stamp auto top-up: a top-up failed',
          text:
            'Raised 2026-11-25 10:00 UTC. This channel could not take it then.\n\n' +
            'The catalogue batch could not be topped up.',
        },
      },
    ]);
    assert.equal(store.waitingRows.length, 0);
    assert.deepEqual(store.channelRows.get('telegram')?.lastSentAt, later);
    assert.equal(store.channelRows.get('telegram')?.lastError, null);
  });

  it('drops a notice a day old or more, and tries one just under', async () => {
    const old = await waitingForTelegram(['a']);
    const dayOn = new Date(NOW.getTime() + NOTIFICATION_WAIT_SECONDS * 1000);
    assert.deepEqual(await old.dispatcher.retryWaiting(dayOn, () => true), { sent: 0, dropped: 1, waiting: 0 });
    assert.equal(old.store.waitingRows.length, 0);
    assert.equal(old.channels.sent.length, 0);

    const young = await waitingForTelegram(['a']);
    const justUnder = new Date(NOW.getTime() + NOTIFICATION_WAIT_SECONDS * 1000 - 1000);
    assert.deepEqual(await young.dispatcher.retryWaiting(justUnder, () => true), { sent: 1, dropped: 0, waiting: 0 });
  });

  it('tries a notice while any of its subjects stands, and drops one none of whose subjects does', async () => {
    const standing = await waitingForTelegram(['first', 'second']);
    assert.deepEqual(await standing.dispatcher.retryWaiting(NOW, (subject) => subject === 'second'), {
      sent: 1,
      dropped: 0,
      waiting: 0,
    });

    const gone = await waitingForTelegram(['first', 'second']);
    assert.deepEqual(await gone.dispatcher.retryWaiting(NOW, () => false), { sent: 0, dropped: 1, waiting: 0 });
    assert.equal(gone.channels.sent.length, 0);
    assert.equal(gone.store.waitingRows.length, 0);
  });

  it('counts a failed try on the notice and the channel, and tries that channel no more in the run', async () => {
    const { store, channels, dispatcher } = await waitingForTelegram(['a']);
    channels.behaviour.telegram = 'fail';
    await dispatcher.notify(notice({ title: 'A second notice', subjects: ['b'] }));
    channels.sent.length = 0;

    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const outcome = await dispatcher.retryWaiting(later, () => true);
    assert.deepEqual(outcome, { sent: 0, dropped: 0, waiting: 2 });
    assert.equal(channels.sent.length, 1);
    const [first, second] = await store.waiting();
    assert.equal(first?.attempts, 2);
    assert.equal(second?.attempts, 1);
    assert.deepEqual(store.channelRows.get('telegram')?.lastErrorAt, later);
  });

  it('never sends a notice again on a channel that took it', async () => {
    const { channels, dispatcher } = await waitingForTelegram(['a']);
    await dispatcher.retryWaiting(NOW, () => true);
    await dispatcher.retryWaiting(NOW, () => true);
    assert.deepEqual(
      channels.sent.map((sent) => sent.kind),
      ['telegram'],
    );
  });

  it('drops a waiting notice whose channel is off', async () => {
    const { store, channels, dispatcher } = await waitingForTelegram(['a']);
    // A row the switch did not drop, as a store written by another backend at the same moment could leave.
    store.channelRows.set('telegram', { ...store.channelRows.get('telegram')!, enabled: false });
    assert.deepEqual(await dispatcher.retryWaiting(NOW, () => true), { sent: 0, dropped: 1, waiting: 0 });
    assert.equal(channels.sent.length, 0);
  });

  it('answers nothing done with no notice waiting', async () => {
    const { dispatcher } = setUp();
    assert.deepEqual(await dispatcher.retryWaiting(NOW, () => true), { sent: 0, dropped: 0, waiting: 0 });
  });
});

describe('lateNoticeText', () => {
  it('puts the moment the notice was raised in front of its text', () => {
    assert.equal(
      lateNoticeText('Body.', new Date('2026-11-24T08:05:59Z')),
      'Raised 2026-11-24 08:05 UTC. This channel could not take it then.\n\nBody.',
    );
  });
});
