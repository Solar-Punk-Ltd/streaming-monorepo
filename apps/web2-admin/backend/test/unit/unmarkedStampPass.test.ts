/**
 * The stamps not on auto top-up: the alert job's pass that lists the unmarked stamps running low, words what the Auto
 * top-up tab says of each, tells of them in one notice under the topic of whoever holds them, again once a day while
 * they stay under the threshold, and takes them off the list; its words; and the list the tab reads. Unit test over a
 * store in memory and a notifier whose people tick topics. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { FundingBatch } from '@streaming-monorepo/contracts';
import { SECONDS_PER_DAY } from '@streaming-monorepo/web2-admin-common';

import type { AutoTopUpMarkRow } from '../../src/domain/funding/StampAutoTopUpStore.js';
import { UnmarkedStampPass, unmarkedStampsView } from '../../src/domain/funding/UnmarkedStampPass.js';
import {
  unmarkedStampSubject,
  type UnmarkedStampRow,
  type UnmarkedStampStore,
} from '../../src/domain/funding/UnmarkedStampStore.js';
import {
  unmarkedStampExpiredText,
  unmarkedStampLowText,
  unmarkedStampUnlistedText,
  unmarkedStampsNotice,
} from '../../src/domain/funding/unmarkedStampTexts.js';

import { BATCH_CATALOGUE, BATCH_RUNG, BATCH_STAGE, NODE_A, NODE_CATALOGUE, NODE_RUNG } from './support/fundingFakes.js';
import {
  BATCH_ARCHIVE,
  BATCH_NEW,
  EXPIRED,
  InMemoryUnmarkedStampStore,
  PeopleNotifier,
  WATCH_T0 as T0,
  markRowOf as markOf,
  watchAt as at,
  watchContext as context,
  watchInventory as inventory,
  type Shelf,
} from './support/unmarkedStampFakes.js';

const DAY = SECONDS_PER_DAY;
const HOUR = 3600;
const MINUTE = 60;

let store: InMemoryUnmarkedStampStore;
let notifier: PeopleNotifier;
let pass: UnmarkedStampPass;
let logged: string[];

function logger() {
  return {
    info: () => undefined,
    warn: (...args: unknown[]) => {
      logged.push(String(args[0]));
    },
  };
}

beforeEach(() => {
  store = new InMemoryUnmarkedStampStore();
  notifier = new PeopleNotifier();
  logged = [];
  pass = new UnmarkedStampPass({ store, logger: logger() });
});

function tick(seconds: number, shelf: Shelf = {}, marks: readonly AutoTopUpMarkRow[] = []): Promise<string | null> {
  return pass.run(context(at(seconds), inventory(shelf), marks), notifier);
}

async function row(batchId: string): Promise<UnmarkedStampRow | undefined> {
  return (await store.rows()).find((listed) => listed.batchId === batchId);
}

function stageName() {
  return { batchId: BATCH_STAGE, title: 'The batch of stage "Main stage"', nodeLabel: 'Main stage uploader' };
}

describe('the stamps not on auto top-up', () => {
  it('lists an unmarked stamp read under "Top up when under", tells of it once under its topic, and words it anew each run', async () => {
    const outcome = await tick(0, { stage: { ttlSeconds: 5 * DAY } });

    const listed = await row(BATCH_STAGE);
    assert.equal(listed?.level, 'low');
    assert.equal(listed?.holder, 'stage');
    assert.equal(listed?.nodeId, NODE_A);
    assert.deepEqual(listed?.since, T0);
    assert.equal(
      listed?.message,
      'The batch of stage "Main stage" (batch 0xb1b1b1b1…, on Main stage uploader) is not on auto top-up and has ' +
        '5 days left, under the 7 days of "Top up when under". Top it up on the Stamps tab of the Funding page, or ' +
        'mark it there for auto top-up.',
    );
    assert.equal(notifier.reads.length, 1);
    assert.equal(notifier.reads[0]!.notice.title, 'Stamp auto top-up: a stamp not on auto top-up is running low');
    assert.deepEqual(notifier.reads[0]!.subjects, [unmarkedStampSubject(BATCH_STAGE)]);
    assert.equal(listed?.notifiedLevel, 'low');
    assert.deepEqual(listed?.notifiedAt, T0);
    assert.equal(outcome, 'Stamps not on auto top-up: 1 under "Top up when under". Told of 1 stamp in a notice.');
    assert.equal(await row(BATCH_CATALOGUE), undefined, 'a stamp with 30 days is not listed');

    const again = await tick(10 * MINUTE, { stage: { ttlSeconds: 5 * DAY - 2 * HOUR } });
    assert.equal(notifier.reads.length, 1, 'no second notice of the same level');
    const worded = await row(BATCH_STAGE);
    assert.match(worded!.message, /has 4 days 22 hours left/);
    assert.deepEqual(worded?.since, T0);
    assert.deepEqual(worded?.levelSince, T0);
    assert.equal(again, 'Stamps not on auto top-up: 1 under "Top up when under".');
  });

  it("lists the catalogue batch, the archive stamps and each stage's batches, and takes off one marked or topped up", async () => {
    await tick(
      0,
      {
        catalogue: { ttlSeconds: 6 * DAY },
        archive: { ttlSeconds: 5 * DAY },
        stage: { ttlSeconds: 4 * DAY },
        rung: { ttlSeconds: 3 * DAY },
      },
      [markOf(BATCH_RUNG, NODE_RUNG)],
    );

    const rows = await store.rows();
    assert.deepEqual(
      rows.map((listed) => [listed.batchId, listed.holder, listed.nodeId]).sort(),
      [
        [BATCH_STAGE, 'stage', NODE_A],
        [BATCH_CATALOGUE, 'catalogue', NODE_CATALOGUE],
        [BATCH_ARCHIVE, 'catalogue', NODE_CATALOGUE],
      ].sort(),
      'the marked rung is left out',
    );
    assert.match(
      (await row(BATCH_CATALOGUE))!.message,
      /^The catalogue batch \(batch 0xc2c2c2c2…, on Catalogue node\) /,
    );
    assert.match(
      (await row(BATCH_ARCHIVE))!.message,
      /^Archive stamp "Keynotes" \(batch 0xe4e4e4e4…, on Catalogue node\) /,
    );

    await tick(
      10 * MINUTE,
      { catalogue: { ttlSeconds: 7 * DAY }, archive: { ttlSeconds: 5 * DAY }, stage: { ttlSeconds: 4 * DAY } },
      [markOf(BATCH_RUNG, NODE_RUNG), markOf(BATCH_STAGE, NODE_A)],
    );
    assert.deepEqual(
      (await store.rows()).map((listed) => listed.batchId),
      [BATCH_ARCHIVE],
      'the stage batch, marked, and the catalogue batch, back at the threshold, leave the list',
    );
  });

  it('tells of a stamp again under 2 days and once more when it expires, and lists no stamp first read expired', async () => {
    await tick(0, { stage: { ttlSeconds: 3 * DAY }, rung: { state: 'gone', ttlSeconds: null, depth: null } });
    assert.equal(await row(BATCH_RUNG), undefined, 'a stamp first read expired is not listed');

    await tick(HOUR, { stage: { ttlSeconds: DAY - HOUR } });
    const last = await row(BATCH_STAGE);
    assert.equal(last?.level, 'last');
    assert.deepEqual(last?.levelSince, at(HOUR));
    assert.equal(notifier.reads.length, 2);
    assert.equal(
      notifier.reads[1]!.notice.title,
      'Stamp auto top-up: a stamp not on auto top-up has under 2 days left',
    );
    assert.match(
      last!.message,
      /has 23 hours left, under 2 days\. Top it up on the Stamps tab of the Funding page before it runs out, or mark it there for auto top-up\.$/,
    );

    await tick(2 * HOUR, { stage: EXPIRED });
    const expired = await row(BATCH_STAGE);
    assert.equal(expired?.level, 'expired');
    assert.equal(expired?.notifiedLevel, 'expired');
    assert.equal(notifier.reads.length, 3);
    assert.equal(notifier.reads[2]!.notice.title, 'Stamp auto top-up: a stamp not on auto top-up expired');
    assert.equal(expired?.message, unmarkedStampExpiredText({ stamp: stageName(), archive: false }));

    await tick(3 * HOUR, { stage: EXPIRED });
    assert.equal(notifier.reads.length, 3, 'an expired stamp is told of once');
  });

  it('keeps an expired stamp listed for a day from when it expired, and after that while the manager lists it', async () => {
    const gone: Partial<FundingBatch> = { state: 'gone', ttlSeconds: null, depth: null, usable: null };
    await tick(0, { stage: { ttlSeconds: HOUR } });
    await tick(2 * HOUR, { stage: gone });
    assert.deepEqual((await row(BATCH_STAGE))?.levelSince, at(2 * HOUR));

    await tick(3 * DAY, { stage: gone });
    assert.equal((await row(BATCH_STAGE))?.level, 'expired', 'still listed by the manager, so still on the list');

    await tick(3 * DAY + 10 * MINUTE, { stage: { batchId: BATCH_NEW } });
    assert.equal(await row(BATCH_STAGE), undefined, 'listed no more, and expired for over a day');
    assert.equal(await row(BATCH_NEW), undefined, 'its new batch, with 30 days, is not listed');
  });

  it('records a listed stamp the manager lists no more as expired, tells of it once, and takes it off a day later', async () => {
    await tick(0, { archive: { ttlSeconds: 5 * DAY } });
    await tick(HOUR, { archive: null });

    const unlisted = await row(BATCH_ARCHIVE);
    assert.equal(unlisted?.level, 'expired');
    assert.deepEqual(unlisted?.levelSince, at(HOUR));
    assert.equal(
      unlisted?.message,
      unmarkedStampUnlistedText({
        batchId: BATCH_ARCHIVE,
        title: 'The catalogue batch or an archive stamp',
        nodeLabel: 'Catalogue node',
      }),
    );
    assert.equal(notifier.reads.length, 2);
    assert.equal(notifier.reads[1]!.notice.title, 'Stamp auto top-up: a stamp not on auto top-up expired');

    await tick(HOUR + DAY - MINUTE, { archive: null });
    assert.equal((await row(BATCH_ARCHIVE))?.level, 'expired');
    await tick(HOUR + DAY, { archive: null });
    assert.equal(await row(BATCH_ARCHIVE), undefined);
    assert.equal(notifier.reads.length, 2);
  });

  it('leaves a stamp that could not be read where it stands, and lists none first read so', async () => {
    await tick(0, { stage: { ttlSeconds: 5 * DAY } });
    const before = await row(BATCH_STAGE);

    await tick(10 * MINUTE, { stage: { ttlSeconds: HOUR }, stageNode: { chainLagBlocks: 500 } });
    await tick(20 * MINUTE, { stage: { ttlSeconds: HOUR }, stageNode: { chainLagBlocks: null } });
    await tick(30 * MINUTE, { stage: { ttlSeconds: HOUR }, stageNode: { readError: 'The node did not answer.' } });
    await tick(40 * MINUTE, { stage: { ttlSeconds: HOUR, usable: false } });
    await tick(50 * MINUTE, {
      stage: { ttlSeconds: null, depth: null, readError: 'The node could not be read about the batch.' },
      rung: { ttlSeconds: null, depth: null, readError: 'The node could not be read about the batch.' },
    });

    assert.deepEqual(await row(BATCH_STAGE), before, 'neither its level nor its words moved');
    assert.equal(await row(BATCH_RUNG), undefined);
    assert.equal(notifier.reads.length, 1);
  });

  it('sends the stamps one run finds as one notice, each person reading those of the topics they ticked', async () => {
    notifier.people = [['unmarked_catalogue'], ['unmarked_stage'], ['unmarked_catalogue', 'unmarked_stage']];
    await tick(0, {
      catalogue: { ttlSeconds: 6 * DAY },
      archive: { ttlSeconds: 5 * DAY },
      stage: { ttlSeconds: 4 * DAY },
      rung: { ttlSeconds: DAY },
    });

    assert.equal(notifier.notifies, 1);
    const byPerson = new Map(notifier.reads.map((read) => [read.person, read]));
    assert.deepEqual(byPerson.get(0)!.subjects, [BATCH_ARCHIVE, BATCH_CATALOGUE].map(unmarkedStampSubject));
    assert.equal(byPerson.get(0)!.notice.title, 'Stamp auto top-up: 2 stamps not on auto top-up are running low');
    assert.deepEqual(byPerson.get(1)!.subjects, [BATCH_RUNG, BATCH_STAGE].map(unmarkedStampSubject));
    assert.deepEqual(
      byPerson.get(2)!.subjects,
      [BATCH_RUNG, BATCH_STAGE, BATCH_ARCHIVE, BATCH_CATALOGUE].map(unmarkedStampSubject),
      'under 2 days first, then the least time left first',
    );
    const text = byPerson.get(2)!.notice.text;
    assert.ok(text.indexOf('Main stage 720p rung') < text.indexOf('Main stage uploader'));
    assert.match(text, /^The admin tops none of these stamps up: they are not marked for auto top-up\.\n\n- /);
    assert.equal(byPerson.get(1)!.notice.text.includes('Keynotes'), false, 'no archive stamp reaches stage stamps');
  });

  it("lists every stamp still under in the day's notice once one was last told of a day ago, and no expired one", async () => {
    await tick(0, { stage: { ttlSeconds: 5 * DAY } });
    await tick(12 * HOUR, {
      stage: { ttlSeconds: 4 * DAY },
      catalogue: { ttlSeconds: 6 * DAY },
      archive: { ttlSeconds: 2 * HOUR },
    });
    assert.equal(notifier.reads.length, 2);
    assert.deepEqual(notifier.reads[1]!.subjects, [BATCH_ARCHIVE, BATCH_CATALOGUE].map(unmarkedStampSubject));

    const later = { stage: { ttlSeconds: 4 * DAY }, catalogue: { ttlSeconds: 5 * DAY }, archive: EXPIRED };
    await tick(13 * HOUR, later);
    assert.equal(notifier.reads.length, 3);

    await tick(DAY - MINUTE, later);
    assert.equal(notifier.reads.length, 3, 'not a day yet');

    await tick(DAY, later);
    assert.equal(notifier.reads.length, 4);
    const daily = notifier.reads[3]!;
    assert.deepEqual(daily.subjects, [BATCH_STAGE, BATCH_CATALOGUE].map(unmarkedStampSubject));
    assert.equal(daily.notice.title, 'Stamp auto top-up: 2 stamps not on auto top-up are still running low');
    assert.match(daily.notice.text, /a notice lists it once a day/);
    assert.deepEqual((await row(BATCH_CATALOGUE))?.notifiedAt, at(DAY));
    assert.deepEqual((await row(BATCH_STAGE))?.notifiedAt, at(DAY));

    await tick(DAY + 10 * MINUTE, later);
    assert.equal(notifier.reads.length, 4);
  });

  it("a stamp topped up from under 2 days back to low and falling under 2 days again gets no second notice of it: the day's notice lists it meanwhile", async () => {
    await tick(0, { stage: { ttlSeconds: DAY - HOUR } });
    assert.equal((await row(BATCH_STAGE))?.notifiedLevel, 'last');

    await tick(HOUR, { stage: { ttlSeconds: 5 * DAY } });
    assert.equal((await row(BATCH_STAGE))?.level, 'low');
    assert.equal(notifier.reads.length, 1, 'a level that drops back is not told of');

    await tick(DAY, { stage: { ttlSeconds: 4 * DAY } });
    assert.equal(notifier.reads.length, 2);
    assert.equal(notifier.reads[1]!.notice.title, 'Stamp auto top-up: a stamp not on auto top-up is still running low');
    assert.equal((await row(BATCH_STAGE))?.notifiedLevel, 'last', 'the level told of stays');

    await tick(DAY + HOUR, { stage: { ttlSeconds: DAY } });
    assert.equal((await row(BATCH_STAGE))?.level, 'last');
    assert.equal(notifier.reads.length, 2, 'no second notice of under 2 days');

    await tick(DAY + 2 * HOUR, { stage: EXPIRED });
    assert.equal(notifier.reads.length, 3, 'expired is a level not told of yet');
  });

  it('tells nobody of a stamp whose topic nobody gets, and tells of it once someone ticks that topic', async () => {
    notifier.people = [['unmarked_catalogue']];
    const quiet = await tick(0, { stage: { ttlSeconds: 5 * DAY } });
    assert.equal(notifier.notifies, 0);
    assert.equal((await row(BATCH_STAGE))?.notifiedAt, null);
    assert.equal(quiet, 'Stamps not on auto top-up: 1 under "Top up when under".');

    notifier.people = [];
    const nobody = await tick(10 * MINUTE, { stage: { ttlSeconds: 5 * DAY } });
    assert.equal(
      nobody,
      'Stamps not on auto top-up: 1 under "Top up when under". Nobody gets their notices, so the Auto top-up tab ' +
        'alone lists them.',
    );

    notifier.people = [['unmarked_stage']];
    await tick(20 * MINUTE, { stage: { ttlSeconds: 5 * DAY } });
    assert.equal(notifier.reads.length, 1);
    assert.deepEqual((await row(BATCH_STAGE))?.notifiedAt, at(20 * MINUTE));
  });

  it('sends a notice no destination took again at the next run, and logs and says that none did', async () => {
    notifier.failing = true;
    const failed = await tick(0, { stage: { ttlSeconds: 5 * DAY } });
    assert.equal(
      failed,
      'Stamps not on auto top-up: 1 under "Top up when under". No destination took their notice, since 1 ' +
        'destination could not take it: it goes again at the next run.',
    );
    assert.equal((await row(BATCH_STAGE))?.notifiedAt, null);
    assert.equal(logged.length, 1);
    assert.match(
      logged[0]!,
      /no destination took the notice "Stamp auto top-up: a stamp not on auto top-up is running low"/,
    );

    notifier.failing = false;
    await tick(10 * MINUTE, { stage: { ttlSeconds: 5 * DAY } });
    assert.equal(notifier.reads.length, 1);
    assert.deepEqual((await row(BATCH_STAGE))?.notifiedAt, at(10 * MINUTE));
  });

  it('names as standing the subject of every listed stamp, an expired one included', async () => {
    await tick(0, { stage: { ttlSeconds: 5 * DAY }, archive: { ttlSeconds: 5 * DAY } });
    await tick(HOUR, { stage: { ttlSeconds: 5 * DAY }, archive: EXPIRED });
    assert.deepEqual(
      (await pass.standingSubjects()).sort(),
      [BATCH_STAGE, BATCH_ARCHIVE].map(unmarkedStampSubject).sort(),
    );
  });

  it('logs and says a run it could not make, and never throws', async () => {
    const broken: UnmarkedStampStore = {
      rows: async () => {
        throw new Error('the database did not answer');
      },
      record: async () => undefined,
      remove: async () => undefined,
      setNotified: async () => undefined,
    };
    const failing = new UnmarkedStampPass({ store: broken, logger: logger() });
    const outcome = await failing.run(context(T0, inventory()), notifier);
    assert.equal(outcome, 'The stamps not on auto top-up could not be read in this run. The log says why.');
    assert.match(logged[0]!, /the database did not answer/);
  });
});

describe('the words of the stamps not on auto top-up', () => {
  it('name a stamp as a marked one is named, with its time left and what a person can do', () => {
    assert.equal(
      unmarkedStampLowText({ stamp: stageName(), level: 'last', ttlSeconds: 30 * HOUR, topUpUnderDays: 7 }),
      'The batch of stage "Main stage" (batch 0xb1b1b1b1…, on Main stage uploader) is not on auto top-up and has ' +
        '1 day 6 hours left, under 2 days. Top it up on the Stamps tab of the Funding page before it runs out, or ' +
        'mark it there for auto top-up.',
    );
    const archive = { batchId: BATCH_ARCHIVE, title: 'Archive stamp "Keynotes"', nodeLabel: 'Catalogue node' };
    assert.equal(
      unmarkedStampExpiredText({ stamp: archive, archive: true }),
      'Archive stamp "Keynotes" (batch 0xe4e4e4e4…, on Catalogue node) is not on auto top-up and expired, or its ' +
        'node holds it no more. An expired stamp cannot be topped up: the recordings copied onto it read "Archive ' +
        `expired" on the Archive page, and each can be archived again onto another stamp. Batch: ${BATCH_ARCHIVE}.`,
    );
    assert.match(
      unmarkedStampExpiredText({ stamp: stageName(), archive: false }),
      /An expired batch cannot be topped up: buy a new one with Buy new on its row of the Stamps tab\. Batch: 0xb1/,
    );
  });

  it('write one notice, with the new stamps and the ones still under apart, and the daily line while one is under', () => {
    const notice = unmarkedStampsNotice([
      { level: 'expired', fresh: true, message: 'A expired.' },
      { level: 'last', fresh: true, message: 'B under 2 days.' },
      { level: 'low', fresh: false, message: 'C low.' },
    ]);
    assert.equal(notice.title, 'Stamp auto top-up: 3 stamps not on auto top-up are running low or expired');
    assert.equal(
      notice.text,
      'The admin tops none of these stamps up: they are not marked for auto top-up.\n\nNew:\n- A expired.\n' +
        '- B under 2 days.\n\nStill under "Top up when under":\n- C low.\n\nWhile a stamp stays under "Top up when ' +
        'under", a notice lists it once a day, and the Auto top-up tab of the Funding page lists it.\n',
    );

    const expiredOnly = unmarkedStampsNotice([
      { level: 'expired', fresh: true, message: 'A expired.' },
      { level: 'expired', fresh: true, message: 'D expired.' },
    ]);
    assert.equal(expiredOnly.title, 'Stamp auto top-up: 2 stamps not on auto top-up expired');
    assert.equal(expiredOnly.text.includes('once a day'), false);
    assert.equal(
      unmarkedStampsNotice([{ level: 'low', fresh: true, message: 'C low.' }]).text,
      'The admin does not top this stamp up: it is not marked for auto top-up.\n\n- C low.\n\nWhile a stamp stays ' +
        'under "Top up when under", a notice lists it once a day, and the Auto top-up tab of the Funding page lists ' +
        'it.\n',
    );
  });
});

describe('the list of the stamps not on auto top-up', () => {
  it('answers the listed stamps, expired first, then under 2 days, then low, each the earliest first', () => {
    const listed = (batchId: string, level: UnmarkedStampRow['level'], since: Date): UnmarkedStampRow => ({
      batchId,
      nodeId: NODE_A,
      holder: 'stage',
      level,
      since,
      levelSince: since,
      message: `${batchId} is ${level}.`,
      notifiedLevel: null,
      notifiedAt: null,
    });
    const view = unmarkedStampsView([
      listed(BATCH_STAGE, 'low', at(0)),
      listed(BATCH_CATALOGUE, 'low', at(-HOUR)),
      listed(BATCH_RUNG, 'last', at(0)),
      { ...listed(BATCH_ARCHIVE, 'expired', at(0)), notifiedLevel: 'expired', notifiedAt: at(MINUTE) },
    ]);
    assert.deepEqual(
      view.stamps.map((stamp) => stamp.batchId),
      [BATCH_ARCHIVE, BATCH_RUNG, BATCH_CATALOGUE, BATCH_STAGE],
    );
    assert.deepEqual(view.stamps[0], {
      batchId: BATCH_ARCHIVE,
      nodeId: NODE_A,
      holder: 'stage',
      level: 'expired',
      since: T0.toISOString(),
      levelSince: T0.toISOString(),
      message: `${BATCH_ARCHIVE} is expired.`,
      notifiedAt: at(MINUTE).toISOString(),
    });
    assert.equal(view.stamps[1]!.notifiedAt, null);
  });
});
