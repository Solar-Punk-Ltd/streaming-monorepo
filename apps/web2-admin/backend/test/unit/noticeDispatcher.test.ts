/**
 * The admin's notifier over each user's destinations: each person gets one notice, written from the parts whose topics
 * they ticked, on each of their destinations that is on, side by side; each destination's and each service's outcome
 * is recorded; a part another destination took waits for the destination that failed, as a notice of those parts, and
 * is tried again with a line that says when it was raised, until it is a day old or nothing it tells of stands. Unit
 * test on the in-memory store and a fake channel factory. `pnpm test`. Every secret and address here is made up.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  type DestinationChannelConfig,
  type DestinationChannelFactory,
  NotificationSendError,
} from '@streaming-monorepo/notifications';
import {
  type Notice,
  type NoticeServiceKind,
  type NoticeTopic,
  NOTIFICATION_WAIT_SECONDS,
} from '@streaming-monorepo/web2-admin-common';

import {
  lateNoticeText,
  NoticeDispatcher,
  serviceFailureSentence,
} from '../../src/domain/notifications/NoticeDispatcher.js';
import type { NoticePart, OutgoingNotice } from '../../src/domain/notifications/Notifier.js';
import { channelSecretKeyFrom, sealChannelSecret } from '../../src/domain/notifications/channelSecrets.js';

import { InMemoryNoticeStore } from './support/notificationFakes.js';

const KEY = channelSecretKeyFrom('ab'.repeat(32));
const SECRETS = { email: 'xkeysib-made-up-for-the-test', telegram: `1234567890:${'A'.repeat(35)}` } as const;
const EMAIL_SETTINGS = { provider: 'brevo' as const, senderAddress: 'alerts@example.com', senderName: '' };

const NOW = new Date('2026-11-25T12:00:00Z');
const HOUR_MS = 3600 * 1000;

const ANA = '00000000-0000-4000-8000-00000000000a';
const BEN = '00000000-0000-4000-8000-00000000000b';
const ANA_MAIL = 'ana@example.org';
const ANA_CHAT = '123456789';
const BEN_MAIL = 'ben@example.org';

type Behaviour = 'take' | 'fail' | 'silent' | 'throw';

/** A destination channel factory whose channels take or refuse as told by address, and record what they were sent. */
class FakeChannels {
  /** By address; an address not named takes. */
  readonly behaviour = new Map<string, Behaviour>();
  readonly configs: DestinationChannelConfig[] = [];
  readonly sent: { kind: NoticeServiceKind; address: string; notice: Notice }[] = [];
  /** What a send to an address waits on before it answers. */
  readonly gates = new Map<string, () => Promise<void>>();

  readonly factory: DestinationChannelFactory = (config) => {
    this.configs.push(config);
    return {
      kind: config.kind,
      send: async (notice) => {
        this.sent.push({ kind: config.kind, address: config.address, notice });
        await this.gates.get(config.address)?.();
        switch (this.behaviour.get(config.address) ?? 'take') {
          case 'take':
            return;
          case 'fail':
            throw new NotificationSendError(
              `The ${config.kind} service answered 400: ${config.address} is refused for the test.`,
              { status: 400 },
            );
          case 'silent':
            throw new NotificationSendError(`The ${config.kind} service gave no answer.`);
          case 'throw':
            throw new Error(`boom with ${config.secret} for ${config.address}`);
        }
      },
    };
  };

  to(address: string): Notice[] {
    return this.sent.filter((send) => send.address === address).map((send) => send.notice);
  }
}

function logger() {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  return { lines, info: write, warn: write };
}

let store: InMemoryNoticeStore;
let channels: FakeChannels;
let log: ReturnType<typeof logger>;
let dispatcher: NoticeDispatcher;

function dispatcherWith(key: Buffer | null): NoticeDispatcher {
  return new NoticeDispatcher({ store, key, channelFrom: channels.factory, logger: log, now: () => NOW });
}

async function saveServices(...kinds: NoticeServiceKind[]): Promise<void> {
  for (const kind of kinds) {
    const secret = sealChannelSecret(kind, SECRETS[kind], KEY);
    if (kind === 'email') await store.saveService({ kind, settings: EMAIL_SETTINGS, secret }, 'operator', NOW);
    else await store.saveService({ kind, settings: {}, secret }, 'operator', NOW);
  }
}

/** Ana on email and Telegram with two topics; Ben on email with "A top-up failed" alone. */
async function anaAndBen(): Promise<void> {
  await saveServices('email', 'telegram');
  await store.saveDestination({ userId: ANA, kind: 'email' }, ANA_MAIL, NOW, ['topups_coming', 'topup_failed']);
  await store.saveDestination({ userId: ANA, kind: 'telegram' }, ANA_CHAT, NOW, []);
  await store.saveDestination({ userId: BEN, kind: 'email' }, BEN_MAIL, NOW, ['topup_failed']);
}

function part(topic: NoticeTopic, subject: string): NoticePart<string> {
  return { topic, subject, item: subject };
}

/** A notice whose title says how many parts it was written from, and whose text lists their subjects. */
function notice(parts: readonly NoticePart<string>[], raisedAt = NOW): OutgoingNotice<string> & { writes: string[][] } {
  const writes: string[][] = [];
  return {
    raisedAt,
    parts,
    writes,
    compose: (chosen) => {
      writes.push(chosen.map((one) => one.item));
      return { title: `Stamp auto top-up: ${chosen.length} item(s)`, text: chosen.map((one) => one.item).join('\n') };
    },
  };
}

const COMING = part('topups_coming', 'auto-top-up/coming/0x01');
const FAILED = part('topup_failed', 'auto-top-up/warning/topup_failed/0x02');
const LOW = part('wallet_low', 'auto-top-up/warning/wallet_xdai');

beforeEach(() => {
  store = new InMemoryNoticeStore();
  channels = new FakeChannels();
  log = logger();
  dispatcher = dispatcherWith(KEY);
});

describe('NoticeDispatcher.on', () => {
  it('says whether anyone gets a topic: a tick, and a destination that is on, on a service saved and on', async () => {
    assert.equal(await dispatcher.on('topup_failed'), false, 'nobody yet');
    await anaAndBen();
    assert.equal(await dispatcher.on('topup_failed'), true);
    assert.equal(await dispatcher.on('topups_coming'), true);
    assert.equal(await dispatcher.on('wallet_low'), false, 'nobody ticked it');

    await store.setServiceEnabled('email', false);
    await store.setServiceEnabled('telegram', false);
    assert.equal(await dispatcher.on('topup_failed'), false, 'every service off');
  });
});

describe('NoticeDispatcher.notify', () => {
  it('writes each person one notice of the parts whose topics they get, and sends it to each of their destinations', async () => {
    await anaAndBen();
    const outgoing = notice([COMING, FAILED, LOW]);

    const outcome = await dispatcher.notify(outgoing);

    assert.deepEqual(outcome, {
      parts: [
        { subject: COMING.subject, people: 1, taken: true },
        { subject: FAILED.subject, people: 2, taken: true },
        { subject: LOW.subject, people: 0, taken: false },
      ],
      sent: 3,
      failed: 0,
    });
    assert.deepEqual(outgoing.writes, [[COMING.item, FAILED.item], [FAILED.item]], 'written once for each person');
    assert.deepEqual(channels.to(ANA_MAIL), [
      { title: 'Stamp auto top-up: 2 item(s)', text: `${COMING.item}\n${FAILED.item}` },
    ]);
    assert.deepEqual(channels.to(ANA_CHAT), channels.to(ANA_MAIL));
    assert.deepEqual(channels.to(BEN_MAIL), [{ title: 'Stamp auto top-up: 1 item(s)', text: FAILED.item }]);
  });

  it("builds each channel from the service's settings and secret and the person's own address alone", async () => {
    await anaAndBen();
    await dispatcher.notify(notice([FAILED]));

    assert.deepEqual(
      channels.configs.map((config) => [config.kind, config.address, config.secret]),
      [
        ['email', ANA_MAIL, SECRETS.email],
        ['telegram', ANA_CHAT, SECRETS.telegram],
        ['email', BEN_MAIL, SECRETS.email],
      ],
    );
    assert.deepEqual(channels.configs[0]?.settings, EMAIL_SETTINGS);
  });

  it('sends nothing and answers no taker for a notice whose topics nobody gets', async () => {
    await anaAndBen();
    const outgoing = notice([LOW]);
    assert.deepEqual(await dispatcher.notify(outgoing), {
      parts: [{ subject: LOW.subject, people: 0, taken: false }],
      sent: 0,
      failed: 0,
    });
    assert.deepEqual(outgoing.writes, []);
    assert.equal(channels.sent.length, 0);
  });

  it('records on each destination and each service how the send went', async () => {
    await anaAndBen();
    channels.behaviour.set(BEN_MAIL, 'fail');

    await dispatcher.notify(notice([FAILED]));

    const [anaMail] = await store.destinations(ANA);
    const [benMail] = await store.destinations(BEN);
    assert.equal(anaMail?.lastSentAt?.toISOString(), NOW.toISOString());
    assert.equal(anaMail?.lastError, null);
    assert.equal(benMail?.lastSentAt, null);
    assert.match(benMail?.lastError ?? '', /answered 400/, "its user reads the service's own words");
    const email = store.serviceRows.get('email');
    assert.equal(email?.lastSentAt?.toISOString(), NOW.toISOString());
    assert.equal(email?.lastFailure, 'The Email service answered 400.', 'every user reads the status alone');
    assert.equal(store.serviceRows.get('telegram')?.lastFailure, null);
  });

  it('keeps a part another destination took for the destination that failed, as a notice of those parts alone', async () => {
    await anaAndBen();
    channels.behaviour.set(ANA_MAIL, 'fail');
    channels.behaviour.set(ANA_CHAT, 'silent');
    const outgoing = notice([COMING, FAILED], new Date(NOW.getTime() - HOUR_MS));

    const outcome = await dispatcher.notify(outgoing);

    assert.deepEqual(outcome.parts, [
      { subject: COMING.subject, people: 1, taken: false },
      { subject: FAILED.subject, people: 2, taken: true },
    ]);
    assert.equal(outcome.sent, 1);
    assert.equal(outcome.failed, 2);
    const kept = {
      userId: ANA,
      title: 'Stamp auto top-up: 1 item(s)',
      text: FAILED.item,
      subjects: [FAILED.subject],
      raisedAt: outgoing.raisedAt,
    };
    assert.deepEqual(
      (await store.waiting()).map((row) => ({
        kind: row.kind,
        userId: row.userId,
        title: row.title,
        text: row.text,
        subjects: row.subjects,
        raisedAt: row.raisedAt,
      })),
      [
        { kind: 'email', ...kept },
        { kind: 'telegram', ...kept },
      ],
    );
    assert.equal(store.serviceRows.get('telegram')?.lastFailure, 'The Telegram service gave no answer.');
  });

  it('keeps a whole notice for a destination that failed while another of the same person took it', async () => {
    await anaAndBen();
    channels.behaviour.set(ANA_CHAT, 'fail');

    await dispatcher.notify(notice([COMING, FAILED]));

    const [row] = await store.waiting();
    assert.equal(row?.kind, 'telegram');
    assert.deepEqual(row?.subjects, [COMING.subject, FAILED.subject]);
    assert.equal(row?.text, `${COMING.item}\n${FAILED.item}`);
  });

  it('keeps nothing when no destination took a part: the sender sends it again', async () => {
    await anaAndBen();
    for (const address of [ANA_MAIL, ANA_CHAT, BEN_MAIL]) channels.behaviour.set(address, 'fail');

    const outcome = await dispatcher.notify(notice([FAILED]));

    assert.deepEqual(outcome, {
      parts: [{ subject: FAILED.subject, people: 2, taken: false }],
      sent: 0,
      failed: 3,
    });
    assert.deepEqual(await store.waiting(), []);
  });

  it('calls the destinations side by side, so a slow one holds up none of the others', async () => {
    await anaAndBen();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    channels.gates.set(ANA_MAIL, () => held);

    const pending = dispatcher.notify(notice([FAILED]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(channels.sent.map((send) => send.address).sort(), [ANA_CHAT, ANA_MAIL, BEN_MAIL].sort());
    release();
    assert.equal((await pending).sent, 3);
  });

  it('fails every send with a sentence that says so when the admin has no key, and opens no secret', async () => {
    await anaAndBen();
    dispatcher = dispatcherWith(null);

    const outcome = await dispatcher.notify(notice([FAILED]));

    assert.equal(outcome.failed, 3);
    assert.equal(channels.configs.length, 0);
    assert.match((await store.destinations(BEN))[0]?.lastError ?? '', /no BRAND_WALLET_SECRET/);
    assert.match(store.serviceRows.get('email')?.lastFailure ?? '', /no BRAND_WALLET_SECRET/);
  });

  it('fails the sends of a service whose secret was sealed under another key, and sends nothing through it', async () => {
    await anaAndBen();
    dispatcher = dispatcherWith(channelSecretKeyFrom('cd'.repeat(32)));

    await dispatcher.notify(notice([FAILED]));

    assert.equal(channels.sent.length, 0);
    assert.match(store.serviceRows.get('telegram')?.lastFailure ?? '', /does not open/);
  });

  it('holds no secret anywhere it records or logs, and no address where every user reads it', async () => {
    await anaAndBen();
    channels.behaviour.set(ANA_MAIL, 'throw');
    channels.behaviour.set(BEN_MAIL, 'fail');

    await dispatcher.notify(notice([FAILED]));

    const everyUser = [...[...store.serviceRows.values()].map((row) => row.lastFailure ?? ''), ...log.lines].join('\n');
    const recorded = [...(await store.destinations(ANA)).map((row) => row.lastError ?? ''), everyUser].join('\n');
    for (const secret of Object.values(SECRETS)) assert.ok(!recorded.includes(secret));
    for (const address of [ANA_MAIL, ANA_CHAT, BEN_MAIL]) assert.ok(!everyUser.includes(address));
  });
});

describe('NoticeDispatcher.retryWaiting', () => {
  async function waitFor(
    userId: string,
    kind: NoticeServiceKind,
    over: { raisedAt?: Date; subjects?: string[] } = {},
  ): Promise<void> {
    await store.addWaiting([
      {
        userId,
        kind,
        title: 'Stamp auto top-up: 1 item(s)',
        text: FAILED.item,
        subjects: over.subjects ?? [FAILED.subject],
        raisedAt: over.raisedAt ?? new Date(NOW.getTime() - HOUR_MS),
        error: 'The email service answered 400.',
      },
    ]);
  }

  it('answers nothing to do when nothing waits', async () => {
    assert.deepEqual(await dispatcher.retryWaiting(NOW, () => true), { sent: 0, dropped: 0, waiting: 0 });
  });

  it('sends what waits with a line that says when it was raised, then drops it and records the send', async () => {
    await anaAndBen();
    const raisedAt = new Date(NOW.getTime() - HOUR_MS);
    await waitFor(ANA, 'telegram', { raisedAt });
    await store.recordFailed({ userId: ANA, kind: 'telegram' }, raisedAt, 'The telegram service gave no answer.');

    assert.deepEqual(await dispatcher.retryWaiting(NOW, () => true), { sent: 1, dropped: 0, waiting: 0 });

    assert.deepEqual(channels.to(ANA_CHAT), [
      { title: 'Stamp auto top-up: 1 item(s)', text: lateNoticeText(FAILED.item, raisedAt) },
    ]);
    assert.match(lateNoticeText('x', raisedAt), /^Raised 2026-11-25 11:00 UTC\./);
    assert.deepEqual(await store.waiting(), []);
    const telegram = (await store.destinations(ANA)).find((row) => row.kind === 'telegram');
    assert.equal(telegram?.lastError, null);
    assert.equal(store.serviceRows.get('telegram')?.lastSentAt?.toISOString(), NOW.toISOString());
  });

  it('drops a notice a day old, one about nothing that stands, and one whose destination or service is off', async () => {
    await anaAndBen();
    await waitFor(ANA, 'email', { raisedAt: new Date(NOW.getTime() - NOTIFICATION_WAIT_SECONDS * 1000) });
    await waitFor(ANA, 'email', { subjects: ['gone'] });
    await waitFor(BEN, 'email');
    await waitFor(ANA, 'telegram');
    // Off as a row reads, without the switch's own drop, as when a switch lands between the read and the try.
    const ben = store.destinationRows.get(`${BEN}:email`)!;
    store.destinationRows.set(`${BEN}:email`, { ...ben, enabled: false });
    const telegram = store.serviceRows.get('telegram')!;
    store.serviceRows.set('telegram', { ...telegram, enabled: false });

    assert.deepEqual(await dispatcher.retryWaiting(NOW, (subject) => subject !== 'gone'), {
      sent: 0,
      dropped: 4,
      waiting: 0,
    });
    assert.equal(channels.sent.length, 0);
    assert.deepEqual(await store.waiting(), []);
  });

  it('stops trying a destination at its first failure, counts the try, and goes on with the others', async () => {
    await anaAndBen();
    await waitFor(ANA, 'email', { raisedAt: new Date(NOW.getTime() - 3 * HOUR_MS) });
    await waitFor(ANA, 'email', { raisedAt: new Date(NOW.getTime() - 2 * HOUR_MS) });
    await waitFor(BEN, 'email');
    channels.behaviour.set(ANA_MAIL, 'fail');

    assert.deepEqual(await dispatcher.retryWaiting(NOW, () => true), { sent: 1, dropped: 0, waiting: 2 });

    assert.equal(channels.to(ANA_MAIL).length, 1, 'the second is not tried in this run');
    const left = await store.waiting();
    assert.deepEqual(
      left.map((row) => [row.userId, row.attempts]),
      [
        [ANA, 2],
        [ANA, 1],
      ],
    );
    assert.match(left[0]!.lastError, /answered 400/);
    assert.equal(store.serviceRows.get('email')?.lastFailure, 'The Email service answered 400.');
  });
});

describe('serviceFailureSentence', () => {
  it("says the service's status, or that no answer came, and none of its words", () => {
    assert.equal(
      serviceFailureSentence(
        'email',
        new NotificationSendError('Brevo said: ana@example.org is blocked.', { status: 400 }),
      ),
      'The Email service answered 400.',
    );
    assert.equal(
      serviceFailureSentence('telegram', new NotificationSendError('No answer from the service.')),
      'The Telegram service gave no answer.',
    );
    assert.equal(
      serviceFailureSentence('telegram', new Error(`boom ${SECRETS.telegram}`)),
      'The Telegram service could not be used: the admin met an error of its own.',
    );
  });
});
