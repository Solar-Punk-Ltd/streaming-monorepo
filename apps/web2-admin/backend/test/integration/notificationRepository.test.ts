/**
 * Migration 037 against the real database, through the repository the admin keeps its notification services, each
 * user's destinations, topics and chat code, and the waiting notices with: a service's save, switch and removal, a
 * destination's save, switch and removal, the topics, who a notice reaches, and the waiting notices. Needs Postgres,
 * like the rest of this suite; `DATABASE_URL` overrides the connection.
 *
 * Every row it writes is in the suite's throwaway database; it empties the tables, and removes its own users, before
 * each test.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type EmailServiceSettings, STARTING_NOTICE_TOPICS } from '@streaming-monorepo/web2-admin-common';

import { Database } from '../../src/domain/Database.js';
import { NoticeRepository } from '../../src/domain/notifications/NoticeRepository.js';
import type { NewWaitingNotice, NoticeServiceSave, SealedSecret } from '../../src/domain/notifications/NoticeStore.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let store: NoticeRepository;

const AT = new Date('2026-11-25T10:00:00.000Z');
const LATER = new Date('2026-11-25T11:00:00.000Z');
const OPERATOR = 'operator-a';
const OTHER_OPERATOR = 'operator-b';
const USER_PREFIX = 'notice-test-';

function sealed(over: Partial<SealedSecret> = {}): SealedSecret {
  return { ciphertext: randomBytes(40), iv: randomBytes(12), authTag: randomBytes(16), keyVersion: 1, ...over };
}

const EMAIL_SETTINGS: EmailServiceSettings = {
  provider: 'brevo',
  senderAddress: 'alerts@example.org',
  senderName: 'Example alerts',
};

function email(secret: SealedSecret | null = sealed()): NoticeServiceSave {
  return { kind: 'email', settings: EMAIL_SETTINGS, secret };
}

function telegram(secret: SealedSecret | null = sealed()): NoticeServiceSave {
  return { kind: 'telegram', settings: {}, secret };
}

/** A user of this file, made `minutesAgo` before now so the earliest is first. */
async function user(name: string, minutesAgo = 0): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash, created_at)
     VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb', NOW() - make_interval(mins => $2))
     RETURNING id`,
    [`${USER_PREFIX}${name}`, minutesAgo],
  );
  return result.rows[0]!.id;
}

function waitingNotice(userId: string, over: Partial<NewWaitingNotice> = {}): NewWaitingNotice {
  return {
    userId,
    kind: 'telegram',
    title: 'Stamp auto top-up: a top-up failed',
    text: 'The stamp could not be topped up.\nIt is tried again on the next tick.',
    subjects: ['auto-top-up/warning/topup_failed/0xabc', 'auto-top-up/coming/0xabc'],
    raisedAt: AT,
    error: 'The telegram service answered 502.',
    ...over,
  };
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  store = new NoticeRepository(database.pool);
});

after(async () => {
  if (database) await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM notification_deliveries');
  await database.pool.query('DELETE FROM notification_services');
  await database.pool.query('DELETE FROM users WHERE username LIKE $1', [`${USER_PREFIX}%`]);
});

describe('notification services', () => {
  it('reads none while none were saved, and counts nobody on either', async () => {
    assert.deepEqual(await store.services(), []);
    assert.deepEqual(await store.serviceCounts(), [
      { kind: 'email', people: 0, failing: 0, waiting: 0 },
      { kind: 'telegram', people: 0, failing: 0, waiting: 0 },
    ]);
  });

  it('makes a service on its first save, switched on, with its settings and its sealed secret', async () => {
    const secret = sealed({ keyVersion: 2 });
    assert.equal(await store.saveService(email(secret), OPERATOR, AT), true);

    assert.deepEqual(await store.services(), [
      {
        kind: 'email',
        enabled: true,
        settings: EMAIL_SETTINGS,
        secret,
        savedAt: AT,
        savedBy: OPERATOR,
        lastSentAt: null,
        lastFailure: null,
        lastFailureAt: null,
      },
    ]);
  });

  it('refuses a first save with no secret, and saves nothing', async () => {
    assert.equal(await store.saveService(telegram(null), OPERATOR, AT), false);
    assert.deepEqual(await store.services(), []);
  });

  it('lists the services in the order of NOTICE_SERVICE_KINDS', async () => {
    await store.saveService(telegram(), OPERATOR, AT);
    await store.saveService(email(), OPERATOR, AT);
    assert.deepEqual(
      (await store.services()).map((row) => row.kind),
      ['email', 'telegram'],
    );
  });

  it('replaces the settings and the secret on a later save, and keeps the switch and how its sends went', async () => {
    await store.saveService(email(), OPERATOR, AT);
    await store.setServiceEnabled('email', false);
    await store.recordServiceSent('email', AT);
    await store.recordServiceFailure('email', AT, 'The email service answered 401.');

    const newSecret = sealed();
    const settings = { ...EMAIL_SETTINGS, senderName: 'Alerts' };
    assert.equal(await store.saveService({ kind: 'email', settings, secret: newSecret }, OTHER_OPERATOR, LATER), true);

    assert.deepEqual(await store.services(), [
      {
        kind: 'email',
        enabled: false,
        settings,
        secret: newSecret,
        savedAt: LATER,
        savedBy: OTHER_OPERATOR,
        lastSentAt: AT,
        lastFailure: 'The email service answered 401.',
        lastFailureAt: AT,
      },
    ]);
  });

  it('keeps the stored secret on a save with none', async () => {
    const secret = sealed();
    await store.saveService(telegram(secret), OPERATOR, AT);
    assert.equal(await store.saveService(telegram(null), OTHER_OPERATOR, LATER), true);

    const [row] = await store.services();
    assert.deepEqual(row?.secret, secret);
    assert.equal(row?.savedBy, OTHER_OPERATOR);
  });

  it("keeps a service's latest failure after a later send went out", async () => {
    await store.saveService(telegram(), OPERATOR, AT);
    await store.recordServiceFailure('telegram', AT, 'The telegram service gave no answer.');
    await store.recordServiceSent('telegram', LATER);

    const [row] = await store.services();
    assert.equal(row?.lastSentAt?.toISOString(), LATER.toISOString());
    assert.equal(row?.lastFailure, 'The telegram service gave no answer.');
    assert.equal(row?.lastFailureAt?.toISOString(), AT.toISOString());
  });

  it("switches a saved service, and drops its destinations' waiting notices when it goes off", async () => {
    const ana = await user('ana');
    await store.saveService(email(), OPERATOR, AT);
    await store.saveService(telegram(), OPERATOR, AT);
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.addWaiting([waitingNotice(ana, { kind: 'email' }), waitingNotice(ana, { kind: 'telegram' })]);

    assert.equal(await store.setServiceEnabled('telegram', true), true);
    assert.equal((await store.waiting()).length, 2, 'on keeps them');
    assert.equal(await store.setServiceEnabled('telegram', false), true);

    assert.deepEqual(
      (await store.waiting()).map((row) => row.kind),
      ['email'],
    );
    assert.equal((await store.services()).find((row) => row.kind === 'telegram')?.enabled, false);
  });

  it('answers false for a switch of a service never saved, and drops nothing', async () => {
    const ana = await user('ana');
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.addWaiting([waitingNotice(ana)]);

    assert.equal(await store.setServiceEnabled('telegram', false), false);
    assert.equal((await store.waiting()).length, 1);
  });

  it("removes a service with its secret and its destinations' waiting notices, and keeps the destinations", async () => {
    const ana = await user('ana');
    await store.saveService(email(), OPERATOR, AT);
    await store.saveService(telegram(), OPERATOR, AT);
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.addWaiting([waitingNotice(ana)]);

    await store.removeService('telegram');

    assert.deepEqual(
      (await store.services()).map((row) => row.kind),
      ['email'],
    );
    assert.deepEqual(await store.waiting(), []);
    assert.deepEqual(
      (await store.destinations(ana)).map((row) => row.address),
      ['123456789'],
    );
  });

  it('counts the destinations that are on, those of them failing, and the waiting notices, for each service', async () => {
    const ana = await user('ana');
    const ben = await user('ben');
    const cleo = await user('cleo');
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ben, kind: 'email' }, 'ben@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: cleo, kind: 'email' }, 'cleo@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.setDestinationEnabled({ userId: cleo, kind: 'email' }, false);
    await store.recordFailed({ userId: ben, kind: 'email' }, AT, 'The email service answered 400.');
    await store.addWaiting([waitingNotice(ben, { kind: 'email' }), waitingNotice(ben, { kind: 'email' })]);

    assert.deepEqual(await store.serviceCounts(), [
      { kind: 'email', people: 2, failing: 1, waiting: 2 },
      { kind: 'telegram', people: 1, failing: 0, waiting: 0 },
    ]);
  });
});

describe("a user's destinations", () => {
  it('makes a destination on its first save, switched on, and starts the topics of a user who has none', async () => {
    const ana = await user('ana');
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);

    assert.deepEqual(await store.destinations(ana), [
      {
        userId: ana,
        kind: 'email',
        address: 'ana@example.org',
        enabled: true,
        savedAt: AT,
        lastSentAt: null,
        lastError: null,
        lastErrorAt: null,
        lastTestAt: null,
        lastTestError: null,
      },
    ]);
    assert.deepEqual(await store.topics(ana), [...STARTING_NOTICE_TOPICS]);
  });

  it("reads one user's destinations alone, in the order of NOTICE_SERVICE_KINDS", async () => {
    const ana = await user('ana');
    const ben = await user('ben');
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ben, kind: 'email' }, 'ben@example.org', AT, STARTING_NOTICE_TOPICS);

    assert.deepEqual(
      (await store.destinations(ana)).map((row) => [row.kind, row.address]),
      [
        ['email', 'ana@example.org'],
        ['telegram', '123456789'],
      ],
    );
    assert.deepEqual(await store.destinations('not-a-user-id'), []);
  });

  it('leaves the topics of a user who saved them before their first destination', async () => {
    const ana = await user('ana');
    await store.saveTopics(ana, ['unmarked_stage'], AT);
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', LATER, STARTING_NOTICE_TOPICS);
    assert.deepEqual(await store.topics(ana), ['unmarked_stage']);
  });

  it('keeps the switch, how its notices and tests went, and its waiting notices on a save of the same address', async () => {
    const ana = await user('ana');
    const key = { userId: ana, kind: 'email' } as const;
    await store.saveDestination(key, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.setDestinationEnabled(key, false);
    await store.setDestinationEnabled(key, true);
    await store.recordSent(key, AT);
    await store.recordFailed(key, AT, 'The email service answered 400.');
    assert.equal(await store.claimTest(key, AT, 60), true);
    await store.recordTest(key, 'The email service answered 401.');
    await store.addWaiting([waitingNotice(ana, { kind: 'email' })]);

    await store.saveDestination(key, 'ana@example.org', LATER, STARTING_NOTICE_TOPICS);

    const [row] = await store.destinations(ana);
    assert.equal(row?.savedAt.toISOString(), LATER.toISOString());
    assert.equal(row?.lastSentAt?.toISOString(), AT.toISOString());
    assert.equal(row?.lastError, 'The email service answered 400.');
    assert.equal(row?.lastTestError, 'The email service answered 401.');
    assert.equal((await store.waiting()).length, 1);
  });

  it('clears how the old address went, and drops what waited for it, on a save of another address', async () => {
    const ana = await user('ana');
    const key = { userId: ana, kind: 'email' } as const;
    await store.saveDestination(key, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.setDestinationEnabled(key, false);
    await store.recordSent(key, AT);
    await store.recordFailed(key, AT, 'The email service answered 400.');
    await store.claimTest(key, AT, 60);
    await store.recordTest(key, 'The email service answered 401.');
    await store.addWaiting([waitingNotice(ana, { kind: 'email' })]);

    await store.saveDestination(key, 'ana@example.net', LATER, STARTING_NOTICE_TOPICS);

    assert.deepEqual(await store.destinations(ana), [
      {
        userId: ana,
        kind: 'email',
        address: 'ana@example.net',
        enabled: false,
        savedAt: LATER,
        lastSentAt: null,
        lastError: null,
        lastErrorAt: null,
        lastTestAt: null,
        lastTestError: null,
      },
    ]);
    assert.deepEqual(await store.waiting(), []);
  });

  it('switches a saved destination, and drops its own waiting notices alone when it goes off', async () => {
    const ana = await user('ana');
    const ben = await user('ben');
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ben, kind: 'telegram' }, '987654321', AT, STARTING_NOTICE_TOPICS);
    await store.addWaiting([waitingNotice(ana), waitingNotice(ana, { kind: 'email' }), waitingNotice(ben)]);

    assert.equal(await store.setDestinationEnabled({ userId: ana, kind: 'telegram' }, false), true);

    assert.deepEqual(
      (await store.waiting()).map((row) => [row.userId, row.kind]),
      [
        [ana, 'email'],
        [ben, 'telegram'],
      ],
    );
    assert.equal(await store.setDestinationEnabled({ userId: ben, kind: 'email' }, false), false, 'never saved');
  });

  it('removes a destination with its waiting notices', async () => {
    const ana = await user('ana');
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.addWaiting([waitingNotice(ana), waitingNotice(ana, { kind: 'email' })]);

    await store.removeDestination({ userId: ana, kind: 'telegram' });

    assert.deepEqual(
      (await store.destinations(ana)).map((row) => row.kind),
      ['email'],
    );
    assert.deepEqual(
      (await store.waiting()).map((row) => row.kind),
      ['email'],
    );
  });

  it('records a notice taken, which clears the last error, and one that failed', async () => {
    const ana = await user('ana');
    const key = { userId: ana, kind: 'telegram' } as const;
    await store.saveDestination(key, '123456789', AT, STARTING_NOTICE_TOPICS);

    await store.recordFailed(key, AT, 'The telegram service answered 403.');
    let [row] = await store.destinations(ana);
    assert.equal(row?.lastError, 'The telegram service answered 403.');
    assert.equal(row?.lastErrorAt?.toISOString(), AT.toISOString());

    await store.recordSent(key, LATER);
    [row] = await store.destinations(ana);
    assert.equal(row?.lastSentAt?.toISOString(), LATER.toISOString());
    assert.equal(row?.lastError, null);
    assert.equal(row?.lastErrorAt, null);
  });

  it('claims one test a minute on a saved destination, and none on one never saved', async () => {
    const ana = await user('ana');
    const key = { userId: ana, kind: 'email' } as const;
    assert.equal(await store.claimTest(key, AT, 60), false, 'never saved');
    await store.saveDestination(key, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);

    const [first, second] = await Promise.all([store.claimTest(key, AT, 60), store.claimTest(key, AT, 60)]);
    assert.equal([first, second].filter(Boolean).length, 1, 'two at once claim one');
    await store.recordTest(key, 'The email service answered 401.');
    assert.equal(await store.claimTest(key, new Date(AT.getTime() + 59_000), 60), false);
    assert.equal((await store.destinations(ana))[0]?.lastTestError, 'The email service answered 401.');

    assert.equal(await store.claimTest(key, new Date(AT.getTime() + 60_000), 60), true);
    const [row] = await store.destinations(ana);
    assert.equal(row?.lastTestAt?.toISOString(), new Date(AT.getTime() + 60_000).toISOString());
    assert.equal(row?.lastTestError, null, 'a new claim clears how the last test went');
  });

  it("counts one user's waiting notices for each of their destinations", async () => {
    const ana = await user('ana');
    const ben = await user('ben');
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ben, kind: 'telegram' }, '987654321', AT, STARTING_NOTICE_TOPICS);
    await store.addWaiting([waitingNotice(ana), waitingNotice(ana), waitingNotice(ben)]);

    assert.deepEqual([...(await store.waitingCounts(ana))], [['telegram', 2]]);
    assert.deepEqual([...(await store.waitingCounts('not-a-user-id'))], []);
  });
});

describe("a user's topics and chat code", () => {
  it('reads no topics while the user has no row, then what they saved, in the order of NOTICE_TOPICS', async () => {
    const ana = await user('ana');
    assert.equal(await store.topics(ana), null);

    await store.saveTopics(ana, ['unmarked_stage', 'wallet_low'], AT);
    assert.deepEqual(await store.topics(ana), ['wallet_low', 'unmarked_stage']);

    await store.saveTopics(ana, [], LATER);
    assert.deepEqual(await store.topics(ana), [], 'a row of no topics is kept');
  });

  it('passes over a topic name the code no longer has', async () => {
    const ana = await user('ana');
    await database.pool.query(
      `INSERT INTO notification_choices (user_id, topics) VALUES ($1, ARRAY['retired_topic', 'topup_failed'])`,
      [ana],
    );
    assert.deepEqual(await store.topics(ana), ['topup_failed']);
  });

  it('holds one chat code a user, replaced by a new one, until it is over', async () => {
    const ana = await user('ana');
    assert.equal(await store.chatCode(ana, AT), null);

    await store.startChatCode(ana, 'ABCDEFGH23', new Date(AT.getTime() + 600_000));
    await store.startChatCode(ana, 'HJKMNPQR45', new Date(AT.getTime() + 600_000));

    assert.equal(await store.chatCode(ana, AT), 'HJKMNPQR45');
    assert.equal(await store.chatCode(ana, new Date(AT.getTime() + 600_000)), null, 'over at its end');
  });

  it('goes with its user: destinations, topics, chat code and waiting notices', async () => {
    const ana = await user('ana');
    const ben = await user('ben');
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ben, kind: 'telegram' }, '987654321', AT, STARTING_NOTICE_TOPICS);
    await store.startChatCode(ana, 'ABCDEFGH23', new Date(AT.getTime() + 600_000));
    await store.addWaiting([waitingNotice(ana), waitingNotice(ben)]);

    await database.pool.query('DELETE FROM users WHERE id = $1', [ana]);

    assert.deepEqual(await store.destinations(ana), []);
    assert.equal(await store.topics(ana), null);
    assert.equal(await store.chatCode(ana, AT), null);
    assert.deepEqual(
      (await store.waiting()).map((row) => row.userId),
      [ben],
    );
  });
});

describe('who a notice reaches', () => {
  it('names each user with topics and a destination that is on, on a service saved and on, the earliest first', async () => {
    const ana = await user('ana', 30);
    const ben = await user('ben', 20);
    const cleo = await user('cleo', 10);
    const dan = await user('dan', 5);
    await store.saveService(email(), OPERATOR, AT);
    await store.saveService(telegram(), OPERATOR, AT);
    await store.setServiceEnabled('telegram', false);

    // Ben: on email and Telegram; Telegram is switched off at the service for now.
    await store.saveDestination({ userId: ben, kind: 'telegram' }, '987654321', AT, STARTING_NOTICE_TOPICS);
    await store.saveDestination({ userId: ben, kind: 'email' }, 'ben@example.org', AT, STARTING_NOTICE_TOPICS);
    // Ana: on both, her email switched off.
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.setDestinationEnabled({ userId: ana, kind: 'email' }, false);
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    // Cleo: a destination, and no topic ticked.
    await store.saveDestination({ userId: cleo, kind: 'email' }, 'cleo@example.org', AT, STARTING_NOTICE_TOPICS);
    await store.saveTopics(cleo, [], AT);
    // Dan: topics, and no destination.
    await store.saveTopics(dan, ['wallet_low'], AT);

    assert.deepEqual(
      (await store.recipients()).map((recipient) => ({
        userId: recipient.userId,
        topics: recipient.topics,
        destinations: recipient.destinations.map((destination) => destination.address),
      })),
      [{ userId: ben, topics: [...STARTING_NOTICE_TOPICS], destinations: ['ben@example.org'] }],
    );

    await store.setServiceEnabled('telegram', true);
    assert.deepEqual(
      (await store.recipients()).map((recipient) => [
        recipient.userId,
        recipient.destinations.map((destination) => destination.kind),
      ]),
      [
        [ana, ['telegram']],
        [ben, ['email', 'telegram']],
      ],
    );
  });

  it('leaves out a user whose ticks hold only names the code no longer has', async () => {
    const ana = await user('ana');
    await store.saveService(email(), OPERATOR, AT);
    await store.saveDestination({ userId: ana, kind: 'email' }, 'ana@example.org', AT, STARTING_NOTICE_TOPICS);
    await database.pool.query(`UPDATE notification_choices SET topics = ARRAY['retired_topic'] WHERE user_id = $1`, [
      ana,
    ]);
    assert.deepEqual(await store.recipients(), []);
  });
});

describe('waiting notices', () => {
  it('keeps them, the earliest raised first, and counts each try with why it failed', async () => {
    const ana = await user('ana');
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.addWaiting([
      waitingNotice(ana, { title: 'Later', raisedAt: LATER }),
      waitingNotice(ana, { title: 'Earlier', raisedAt: AT }),
    ]);

    const rows = await store.waiting();
    assert.deepEqual(
      rows.map((row) => row.title),
      ['Earlier', 'Later'],
    );
    const { id, ...earlier } = rows[0]!;
    assert.match(id, /^[1-9]\d*$/);
    assert.deepEqual(earlier, {
      userId: ana,
      kind: 'telegram',
      title: 'Earlier',
      text: 'The stamp could not be topped up.\nIt is tried again on the next tick.',
      subjects: ['auto-top-up/warning/topup_failed/0xabc', 'auto-top-up/coming/0xabc'],
      raisedAt: AT,
      attempts: 1,
      lastError: 'The telegram service answered 502.',
    });

    await store.recordAttempt(id, 'The telegram service gave no answer.');
    const [tried] = await store.waiting();
    assert.equal(tried?.attempts, 2);
    assert.equal(tried?.lastError, 'The telegram service gave no answer.');
  });

  it('removes the ones named, and passes over an id that names none', async () => {
    const ana = await user('ana');
    await store.saveDestination({ userId: ana, kind: 'telegram' }, '123456789', AT, STARTING_NOTICE_TOPICS);
    await store.addWaiting([waitingNotice(ana, { title: 'One' }), waitingNotice(ana, { title: 'Two' })]);
    const [one] = await store.waiting();

    await store.removeWaiting([one!.id, 'not-an-id', '0']);
    await store.recordAttempt('not-an-id', 'passed over');

    assert.deepEqual(
      (await store.waiting()).map((row) => row.title),
      ['Two'],
    );
  });

  it('refuses a notice for a destination that was never saved', async () => {
    const ana = await user('ana');
    await assert.rejects(() => store.addWaiting([waitingNotice(ana)]));
    assert.deepEqual(await store.waiting(), []);
  });
});
