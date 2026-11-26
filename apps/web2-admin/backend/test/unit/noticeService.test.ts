/**
 * The Notifications page's service over the in-memory store, with the real sealing and a fake channel factory and
 * Telegram lookups. Unit test. `pnpm test`.
 *
 * Pinned here: the services are saved, switched and removed by a user with the admin role alone, and a save checks
 * the settings and the secret with the package's rules, seals the secret and keeps it when none is typed; every user
 * saves, switches and removes their own destinations and topics, and their first destination ticks the starting
 * topics; the view shows a user their own and numbers alone of the others, and the settings to an admin alone; a test
 * notice goes to the user's saved destination a minute at most and counts in no rule; Find my chat starts a code once
 * the bot is read, and finds the one chat that sent it; without BRAND_WALLET_SECRET no service is saved and no test or
 * lookup goes out; and no answer or audit row carries a secret, nor an audit row an address. Every secret and address
 * here is made up for the test.
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
  noticeProblem,
  STARTING_NOTICE_TOPICS,
  TELEGRAM_CHAT_CODE_SECONDS,
  type TelegramChat,
} from '@streaming-monorepo/web2-admin-common';

import {
  AdminRequiredError,
  NoticeDestinationNotSavedError,
  NoticeServiceNotSavedError,
  NoticeTestTooSoonError,
  NotificationsUnavailableError,
  RequestShapeError,
  TelegramCodeNotStartedError,
} from '../../src/domain/errors/index.js';
import {
  channelSecretKeyFrom,
  openChannelSecret,
  sealChannelSecret,
} from '../../src/domain/notifications/channelSecrets.js';
import {
  drawTelegramChatCode,
  NoticeService,
  type NoticeUser,
  testNotice,
} from '../../src/domain/notifications/NoticeService.js';

import { InMemoryAuditLog } from './support/fakes.js';
import { InMemoryNoticeStore } from './support/notificationFakes.js';

const KEY = channelSecretKeyFrom('ab'.repeat(32));
const OTHER_KEY = channelSecretKeyFrom('cd'.repeat(32));

const ADMIN: NoticeUser = {
  kind: 'operator',
  userId: '00000000-0000-4000-8000-0000000000a1',
  username: 'alice',
  isAdmin: true,
};
const OPERATOR: NoticeUser = {
  kind: 'operator',
  userId: '00000000-0000-4000-8000-0000000000b2',
  username: 'bob',
  isAdmin: false,
};

const EMAIL_KEY = `test-key-${'k'.repeat(40)}`;
const TELEGRAM_TOKEN = `1234567890:${'A'.repeat(35)}`;
const EMAIL_SETTINGS = { provider: 'brevo', senderAddress: 'alerts@example.org', senderName: 'Stream alerts' } as const;

const ADMIN_MAIL = 'alice@example.org';
const OPERATOR_MAIL = 'bob@example.org';
const OPERATOR_CHAT = '987654321';
const CODE = 'ABCDEFGH23';
const BOT = { username: 'example_alerts_bot', name: 'Example alerts' };
const CHAT: TelegramChat = { id: OPERATOR_CHAT, kind: 'private', name: 'Bob' };

const START = Date.parse('2026-11-25T10:00:00.000Z');

/** A destination channel factory that keeps what it was given and what it sent, and fails while `failWith` is set. */
class FakeChannels {
  readonly configs: DestinationChannelConfig[] = [];
  readonly sent: { address: string; notice: Notice }[] = [];
  failWith: unknown = null;

  readonly channelFrom: DestinationChannelFactory = (config) => {
    this.configs.push(structuredClone(config));
    return {
      kind: config.kind,
      send: async (notice: Notice) => {
        if (this.failWith !== null) throw this.failWith;
        this.sent.push({ address: config.address, notice });
      },
    };
  };
}

/** The Telegram lookups, answering as set, with the tokens and codes they were asked with. */
class FakeTelegram {
  readonly botTokens: string[] = [];
  readonly chatAsks: { token: string; code: string }[] = [];
  bot: unknown = BOT;
  chat: unknown = CHAT;

  readonly lookUpTelegramBot = async (token: string) => {
    this.botTokens.push(token);
    if (this.bot instanceof Error) throw this.bot;
    return this.bot as typeof BOT;
  };

  readonly findTelegramChat = async (token: string, code: string) => {
    this.chatAsks.push({ token, code });
    if (this.chat instanceof Error) throw this.chat;
    return this.chat as TelegramChat | null;
  };
}

let clock: { now: number };
let store: InMemoryNoticeStore;
let audit: InMemoryAuditLog;
let channels: FakeChannels;
let telegram: FakeTelegram;
let service: NoticeService;

function serviceWith(secretKey: Buffer | null): NoticeService {
  return new NoticeService({
    store,
    secretKey,
    channelFrom: channels.channelFrom,
    lookUpTelegramBot: telegram.lookUpTelegramBot,
    findTelegramChat: telegram.findTelegramChat,
    audit,
    now: () => clock.now,
    drawCode: () => CODE,
  });
}

beforeEach(() => {
  clock = { now: START };
  store = new InMemoryNoticeStore();
  audit = new InMemoryAuditLog();
  channels = new FakeChannels();
  telegram = new FakeTelegram();
  service = serviceWith(KEY);
});

/** Everything a caller or a reader of the audit trail could see, as one text to look for a secret in. */
function seen(...values: unknown[]): string {
  return JSON.stringify([...values, audit.entries]);
}

function assertNoSecret(text: string): void {
  for (const secret of [EMAIL_KEY, TELEGRAM_TOKEN]) {
    assert.ok(!text.includes(secret), 'a secret was seen');
    assert.ok(!text.includes(encodeURIComponent(secret)), 'a secret was seen, URL-encoded');
  }
}

async function saveBoth(): Promise<void> {
  await service.saveService(ADMIN, 'email', { settings: EMAIL_SETTINGS, secret: EMAIL_KEY });
  await service.saveService(ADMIN, 'telegram', { settings: {}, secret: TELEGRAM_TOKEN });
}

describe('the view', () => {
  it('lists every service and destination, saved or not, with no topic before a first save', async () => {
    const view = await service.view(OPERATOR);
    assert.equal(view.available, true);
    assert.equal(view.managesServices, false);
    assert.deepEqual(
      view.services.map((one) => [one.kind, one.saved, one.enabled, one.people]),
      [
        ['email', false, false, 0],
        ['telegram', false, false, 0],
      ],
    );
    assert.deepEqual(
      view.destinations.map((one) => [one.kind, one.address, one.enabled]),
      [
        ['email', null, false],
        ['telegram', null, false],
      ],
    );
    assert.deepEqual(view.topics, []);
    assert.ok(view.reach.every((reach) => reach.people === 0));
    assert.equal((await serviceWith(null).view(ADMIN)).available, false);
    assert.equal((await service.view(ADMIN)).managesServices, true);
  });

  it("shows a service's settings and who saved it to an admin alone, and its secret to nobody", async () => {
    await saveBoth();
    const forAdmin = await service.view(ADMIN);
    const forOperator = await service.view(OPERATOR);

    assert.deepEqual(forAdmin.services[0]?.settings, EMAIL_SETTINGS);
    assert.equal(forAdmin.services[0]?.savedBy, 'alice');
    assert.equal(forAdmin.services[0]?.savedAt, new Date(START).toISOString());
    assert.equal(forOperator.services[0]?.settings, null);
    assert.equal(forOperator.services[0]?.savedBy, null);
    assert.equal(forOperator.services[0]?.savedAt, null);
    assert.equal(forOperator.services[0]?.saved, true);
    assertNoSecret(seen(forAdmin, forOperator));
  });

  it("holds a user's own destinations, and numbers alone of the others'", async () => {
    await saveBoth();
    await service.saveDestination(ADMIN, 'email', ADMIN_MAIL);
    await service.saveDestination(OPERATOR, 'email', OPERATOR_MAIL);
    await service.saveTopics(OPERATOR, ['topup_failed', 'unmarked_stage']);

    const view = await service.view(OPERATOR);
    assert.equal(view.destinations[0]?.address, OPERATOR_MAIL);
    assert.equal(view.services[0]?.people, 2);
    assert.deepEqual(view.topics, ['topup_failed', 'unmarked_stage']);
    assert.deepEqual(
      view.reach.map((reach) => [reach.topic, reach.people]),
      [
        ['topups_coming', 1],
        ['wallet_low', 1],
        ['topup_failed', 2],
        ['stamp_expired', 1],
        ['unmarked_catalogue', 0],
        ['unmarked_stage', 1],
      ],
    );
    assert.ok(!JSON.stringify(view).includes(ADMIN_MAIL), "another user's address is in no answer");
  });
});

describe('the shared services', () => {
  it('are saved, switched and removed by a user with the admin role alone', async () => {
    await assert.rejects(
      service.saveService(OPERATOR, 'email', { settings: EMAIL_SETTINGS, secret: EMAIL_KEY }),
      AdminRequiredError,
    );
    await saveBoth();
    await assert.rejects(service.setServiceEnabled(OPERATOR, 'email', false), AdminRequiredError);
    await assert.rejects(service.removeService(OPERATOR, 'telegram'), AdminRequiredError);
    assert.deepEqual(
      (await store.services()).map((row) => [row.kind, row.enabled]),
      [
        ['email', true],
        ['telegram', true],
      ],
    );
  });

  it('checks the settings and the secret with the rules, every problem at once, and saves nothing then', async () => {
    const error = await service
      .saveService(ADMIN, 'email', { settings: { provider: 'other', senderAddress: 'no' }, secret: 'short' })
      .catch((caught: unknown) => caught);
    assert.ok(error instanceof RequestShapeError);
    assert.ok(error.problems.length >= 3, error.problems.join(' | '));
    assertNoSecret(error.problems.join(' '));
    assert.deepEqual(await store.services(), []);
  });

  it('seals the secret, switches a first save on, audits it without the secret, and keeps it when none is typed', async () => {
    const view = await service.saveService(ADMIN, 'telegram', { settings: {}, secret: `  ${TELEGRAM_TOKEN} ` });
    assert.equal(view.services[1]?.enabled, true);
    const [row] = await store.services();
    assert.equal(openChannelSecret('telegram', row!.secret, KEY), TELEGRAM_TOKEN);

    await service.setServiceEnabled(ADMIN, 'telegram', false);
    clock.now += 60_000;
    await service.saveService(ADMIN, 'telegram', { settings: {}, secret: null });
    const [kept] = await store.services();
    assert.equal(openChannelSecret('telegram', kept!.secret, KEY), TELEGRAM_TOKEN);
    assert.equal(kept?.enabled, false, 'a later save keeps the switch');

    assert.deepEqual(
      audit.entries.map((entry) => [entry.action, entry.details?.secret]),
      [
        ['notification.service.save', 'set'],
        ['notification.service.enabled', undefined],
        ['notification.service.save', 'kept'],
      ],
    );
    assertNoSecret(seen(view));
  });

  it('refuses a first save with no secret', async () => {
    const error = await service
      .saveService(ADMIN, 'email', { settings: EMAIL_SETTINGS, secret: '   ' })
      .catch((caught: unknown) => caught);
    assert.ok(error instanceof RequestShapeError);
    assert.match(error.problems.join(' '), /Enter the API key/);
  });

  it('saves nothing without BRAND_WALLET_SECRET', async () => {
    await assert.rejects(
      serviceWith(null).saveService(ADMIN, 'email', { settings: EMAIL_SETTINGS, secret: EMAIL_KEY }),
      NotificationsUnavailableError,
    );
    assert.deepEqual(await store.services(), []);
  });

  it('refuses a switch of a service never saved, and removes a saved one while keeping the destinations', async () => {
    await assert.rejects(service.setServiceEnabled(ADMIN, 'email', true), NoticeServiceNotSavedError);
    await saveBoth();
    await service.saveDestination(OPERATOR, 'telegram', OPERATOR_CHAT);

    const view = await service.removeService(ADMIN, 'telegram');
    assert.equal(view.services[1]?.saved, false);
    assert.equal((await store.destinations(OPERATOR.userId))[0]?.address, OPERATOR_CHAT);

    await service.removeService(ADMIN, 'telegram');
    assert.equal(
      audit.entries.filter((entry) => entry.action === 'notification.service.remove').length,
      1,
      'a removal of nothing is not audited',
    );
  });
});

describe("a user's own destinations and topics", () => {
  it('saves a destination the rules pass, as they keep it, and ticks the starting topics on the first', async () => {
    const refused = await service
      .saveDestination(OPERATOR, 'email', 'not an address')
      .catch((caught: unknown) => caught);
    assert.ok(refused instanceof RequestShapeError);

    const view = await service.saveDestination(OPERATOR, 'email', '  Bob@Example.org ');
    assert.equal(view.destinations[0]?.address, OPERATOR_MAIL);
    assert.equal(view.destinations[0]?.enabled, true);
    assert.deepEqual(view.topics, [...STARTING_NOTICE_TOPICS]);

    const entry = audit.entries.at(-1);
    assert.equal(entry?.action, 'notification.destination.save');
    assert.deepEqual(entry?.details, { kind: 'email' });
    assert.ok(!JSON.stringify(audit.entries).includes(OPERATOR_MAIL), 'no audit row holds the address');
  });

  it('needs no BRAND_WALLET_SECRET to save a destination or the topics', async () => {
    service = serviceWith(null);
    await service.saveDestination(OPERATOR, 'telegram', OPERATOR_CHAT);
    await service.saveTopics(OPERATOR, ['wallet_low']);
    assert.deepEqual(await store.topics(OPERATOR.userId), ['wallet_low']);
  });

  it("switches and removes the user's own destination alone", async () => {
    await assert.rejects(service.setDestinationEnabled(OPERATOR, 'email', false), NoticeDestinationNotSavedError);
    await service.saveDestination(OPERATOR, 'email', OPERATOR_MAIL);
    await service.saveDestination(ADMIN, 'email', ADMIN_MAIL);

    const off = await service.setDestinationEnabled(OPERATOR, 'email', false);
    assert.equal(off.destinations[0]?.enabled, false);
    assert.equal((await store.destinations(ADMIN.userId))[0]?.enabled, true);

    const removed = await service.removeDestination(OPERATOR, 'email');
    assert.equal(removed.destinations[0]?.address, null);
    assert.equal((await store.destinations(ADMIN.userId)).length, 1);
    assert.deepEqual(
      audit.entries.map((entry) => entry.action),
      [
        'notification.destination.save',
        'notification.destination.save',
        'notification.destination.enabled',
        'notification.destination.remove',
      ],
    );
  });

  it('saves the topics the rules pass, in their order, and refuses others', async () => {
    const refused = await service
      .saveTopics(OPERATOR, ['wallet_low', 'not_a_topic'])
      .catch((caught: unknown) => caught);
    assert.ok(refused instanceof RequestShapeError);

    const view = await service.saveTopics(OPERATOR, ['unmarked_stage', 'wallet_low', 'wallet_low']);
    assert.deepEqual(view.topics, ['wallet_low', 'unmarked_stage']);
    assert.deepEqual(audit.entries.at(-1)?.details, { topics: ['wallet_low', 'unmarked_stage'] });

    await service.saveDestination(OPERATOR, 'email', OPERATOR_MAIL);
    assert.deepEqual(await store.topics(OPERATOR.userId), ['wallet_low', 'unmarked_stage'], 'kept by a first save');
  });
});

describe('a test notice', () => {
  it("goes to the user's saved destination, on or off, through the saved service, with who asked and when", async () => {
    await saveBoth();
    await service.saveDestination(OPERATOR, 'email', OPERATOR_MAIL);
    await service.setDestinationEnabled(OPERATOR, 'email', false);
    await service.setServiceEnabled(ADMIN, 'email', false);

    const answer = await service.test(OPERATOR, 'email');

    assert.equal(answer.sent, true);
    assert.equal(answer.error, null);
    assert.deepEqual(channels.configs, [
      { kind: 'email', settings: EMAIL_SETTINGS, secret: EMAIL_KEY, address: OPERATOR_MAIL },
    ]);
    const notice = channels.sent[0]!.notice;
    assert.deepEqual(notice, testNotice(OPERATOR, new Date(START)));
    assert.equal(noticeProblem(notice), null);
    assert.match(notice.text, /^bob sent this test notice/);
    assert.equal(answer.view.destinations[0]?.lastTestAt, new Date(START).toISOString());
    assertNoSecret(seen(answer));
  });

  it('counts in no rule: how the destination and the service went, and what waits, stay', async () => {
    await saveBoth();
    await service.saveDestination(OPERATOR, 'email', OPERATOR_MAIL);
    channels.failWith = new NotificationSendError(`The email service answered 401: key ${EMAIL_KEY} refused.`, {
      status: 401,
    });

    const answer = await service.test(OPERATOR, 'email');

    assert.equal(answer.sent, false);
    assert.match(answer.error ?? '', /answered 401/);
    assertNoSecret(seen(answer));
    const [row] = await store.destinations(OPERATOR.userId);
    assert.match(row?.lastTestError ?? '', /answered 401/);
    assert.equal(row?.lastError, null);
    assert.equal(row?.lastSentAt, null);
    assert.equal(store.serviceRows.get('email')?.lastFailure, null);
    assert.deepEqual(audit.entries.at(-1)?.details, { kind: 'email', sent: false });
  });

  it('goes a minute at most to a destination', async () => {
    await saveBoth();
    await service.saveDestination(OPERATOR, 'telegram', OPERATOR_CHAT);
    await service.test(OPERATOR, 'telegram');

    clock.now += 45_000;
    const error = await service.test(OPERATOR, 'telegram').catch((caught: unknown) => caught);
    assert.ok(error instanceof NoticeTestTooSoonError);
    assert.equal(error.retryAfterSeconds, 15);
    assert.equal(channels.sent.length, 1);

    clock.now += 15_000;
    assert.equal((await service.test(OPERATOR, 'telegram')).sent, true);
  });

  it('is refused without a destination, without the service, and without BRAND_WALLET_SECRET', async () => {
    await assert.rejects(service.test(OPERATOR, 'email'), NoticeDestinationNotSavedError);
    await service.saveDestination(OPERATOR, 'email', OPERATOR_MAIL);
    await assert.rejects(service.test(OPERATOR, 'email'), NoticeServiceNotSavedError);
    await saveBoth();
    await assert.rejects(serviceWith(null).test(OPERATOR, 'email'), NotificationsUnavailableError);
    assert.equal(channels.sent.length, 0);
  });

  it('says so when the saved secret does not open with this key', async () => {
    await saveBoth();
    await service.saveDestination(OPERATOR, 'email', OPERATOR_MAIL);

    const answer = await serviceWith(OTHER_KEY).test(OPERATOR, 'email');

    assert.equal(answer.sent, false);
    assert.match(answer.error ?? '', /does not open/);
    assert.equal(channels.sent.length, 0);
  });
});

describe('Find my chat', () => {
  it('reads the bot with the saved token, then starts a code that holds for 10 minutes', async () => {
    await saveBoth();
    const before = audit.entries.length;
    const answer = await service.telegramCode(OPERATOR);

    assert.deepEqual(answer, {
      code: CODE,
      expiresAt: new Date(START + TELEGRAM_CHAT_CODE_SECONDS * 1000).toISOString(),
      bot: BOT,
      error: null,
    });
    assert.deepEqual(telegram.botTokens, [TELEGRAM_TOKEN]);
    assert.equal(await store.chatCode(OPERATOR.userId, new Date(START)), CODE);
    assert.equal(audit.entries.length, before, 'a code changes nothing that is audited');
  });

  it('starts no code when the bot could not be read, and says why without the token', async () => {
    await saveBoth();
    telegram.bot = new NotificationSendError(`Telegram answered 401 for bot${TELEGRAM_TOKEN}.`, { status: 401 });

    const answer = await service.telegramCode(OPERATOR);

    assert.equal(answer.code, null);
    assert.equal(answer.bot, null);
    assert.match(answer.error ?? '', /answered 401/);
    assertNoSecret(seen(answer));
    assert.equal(await store.chatCode(OPERATOR.userId, new Date(START)), null);
  });

  it('finds the one chat that sent the code, with the saved token', async () => {
    await saveBoth();
    await service.telegramCode(OPERATOR);
    clock.now += 60_000;

    assert.deepEqual(await service.telegramChat(OPERATOR), { chat: CHAT, error: null });
    assert.deepEqual(telegram.chatAsks, [{ token: TELEGRAM_TOKEN, code: CODE }]);

    telegram.chat = null;
    assert.deepEqual(await service.telegramChat(OPERATOR), { chat: null, error: null });
    assert.equal((await store.destinations(OPERATOR.userId)).length, 0, 'it saves no destination');
  });

  it('is refused with no code that holds, without the Telegram service, and without BRAND_WALLET_SECRET', async () => {
    await assert.rejects(service.telegramCode(OPERATOR), NoticeServiceNotSavedError);
    await saveBoth();
    await assert.rejects(service.telegramChat(OPERATOR), TelegramCodeNotStartedError);
    await service.telegramCode(OPERATOR);
    clock.now += TELEGRAM_CHAT_CODE_SECONDS * 1000;
    await assert.rejects(service.telegramChat(OPERATOR), TelegramCodeNotStartedError, 'over after 10 minutes');
    await assert.rejects(serviceWith(null).telegramCode(OPERATOR), NotificationsUnavailableError);
    assert.deepEqual(telegram.chatAsks, []);
  });

  it('answers why a lookup failed, without the token', async () => {
    await saveBoth();
    await service.telegramCode(OPERATOR);
    telegram.chat = new Error(`socket closed for ${TELEGRAM_TOKEN}`);

    const answer = await service.telegramChat(OPERATOR);
    assert.equal(answer.chat, null);
    assert.match(answer.error ?? '', /error of its own/);
    assertNoSecret(seen(answer));
  });
});

describe('drawTelegramChatCode', () => {
  it('draws ten characters of the alphabet the database takes', () => {
    for (let at = 0; at < 50; at += 1) assert.match(drawTelegramChatCode(), /^[A-HJKMNP-Z2-9]{10}$/);
  });
});

describe('the secrets', () => {
  it('seal under the label the carried secrets were sealed under, so they open as the same service', () => {
    const sealed = sealChannelSecret('telegram', TELEGRAM_TOKEN, KEY);
    assert.equal(openChannelSecret('telegram', sealed, KEY), TELEGRAM_TOKEN);
    assert.throws(() => openChannelSecret('email', sealed, KEY));
  });
});
