/**
 * Migration 037's `stamp_watch_notices` against the real database, through the repository the alert job keeps the
 * stamps not on auto top-up with: a reading's upsert, what a listed stamp keeps and what it takes, the level a notice
 * told of, the removal, the order, and the table's checks. Needs Postgres, like the rest of this suite;
 * `DATABASE_URL` overrides the connection.
 *
 * Every row it writes is in the suite's throwaway database; it empties the table before each test.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { UnmarkedStampRepository } from '../../src/domain/funding/UnmarkedStampRepository.js';
import type { UnmarkedStampReading } from '../../src/domain/funding/UnmarkedStampStore.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let store: UnmarkedStampRepository;

const batchOf = (byte: string) => `0x${byte.repeat(32)}`;
const BATCH_A = batchOf('a1');
const BATCH_B = batchOf('b2');
const AT = new Date('2026-11-24T10:00:00.000Z');
const LATER = new Date('2026-11-24T11:00:00.000Z');
const LATEST = new Date('2026-11-24T12:00:00.000Z');

function reading(over: Partial<UnmarkedStampReading> = {}): UnmarkedStampReading {
  return {
    batchId: BATCH_A,
    nodeId: 'stage-1:uploader',
    holder: 'stage',
    level: 'low',
    message: 'The stage batch has 5 days left.',
    ...over,
  };
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  store = new UnmarkedStampRepository(database.pool);
});

after(async () => {
  if (database) await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM stamp_watch_notices');
});

describe('the stamps not on auto top-up, in Postgres', () => {
  it('lists a stamp from its first reading, since and level since at that moment, nothing told of it yet', async () => {
    await store.record(reading(), AT);
    assert.deepEqual(await store.rows(), [
      {
        batchId: BATCH_A,
        nodeId: 'stage-1:uploader',
        holder: 'stage',
        level: 'low',
        since: AT,
        levelSince: AT,
        message: 'The stage batch has 5 days left.',
        notifiedLevel: null,
        notifiedAt: null,
      },
    ]);
  });

  it('keeps since and what was told of a listed stamp, takes its words, node and holder, and moves its level since on a new level alone', async () => {
    await store.record(reading(), AT);
    await store.setNotified([{ batchId: BATCH_A, level: 'low' }], AT);

    await store.record(reading({ nodeId: 'stage-1:rung-720p', message: 'The stage batch has 4 days left.' }), LATER);
    const reworded = (await store.rows())[0]!;
    assert.equal(reworded.nodeId, 'stage-1:rung-720p');
    assert.equal(reworded.message, 'The stage batch has 4 days left.');
    assert.deepEqual(reworded.since, AT);
    assert.deepEqual(reworded.levelSince, AT);
    assert.equal(reworded.notifiedLevel, 'low');
    assert.deepEqual(reworded.notifiedAt, AT);

    await store.record(reading({ level: 'last', holder: 'catalogue', message: 'It has a day left.' }), LATEST);
    const moved = (await store.rows())[0]!;
    assert.equal(moved.level, 'last');
    assert.equal(moved.holder, 'catalogue');
    assert.deepEqual(moved.since, AT);
    assert.deepEqual(moved.levelSince, LATEST);
    assert.equal(moved.notifiedLevel, 'low');
    assert.deepEqual(moved.notifiedAt, AT);
  });

  it('never moves a level since to before its since', async () => {
    await store.record(reading(), LATER);
    await store.record(reading({ level: 'last' }), AT);
    const row = (await store.rows())[0]!;
    assert.equal(row.level, 'last');
    assert.deepEqual(row.levelSince, LATER);
  });

  it('records the level a taken notice named, removes the stamps named and leaves the others, the earliest since first', async () => {
    await store.record(reading({ batchId: BATCH_B, nodeId: 'catalogue:uploader', holder: 'catalogue' }), LATER);
    await store.record(reading(), AT);
    assert.deepEqual(
      (await store.rows()).map((row) => row.batchId),
      [BATCH_A, BATCH_B],
    );

    await store.setNotified(
      [
        { batchId: BATCH_A, level: 'last' },
        { batchId: BATCH_B, level: 'low' },
      ],
      LATEST,
    );
    await store.setNotified([], AT);
    assert.deepEqual(
      (await store.rows()).map((row) => [row.batchId, row.notifiedLevel, row.notifiedAt]),
      [
        [BATCH_A, 'last', LATEST],
        [BATCH_B, 'low', LATEST],
      ],
    );

    await store.remove([]);
    await store.remove([BATCH_A, batchOf('c3')]);
    assert.deepEqual(
      (await store.rows()).map((row) => row.batchId),
      [BATCH_B],
    );
  });

  it('refuses what migration 037 holds a listed stamp to', async () => {
    await assert.rejects(store.record(reading({ batchId: batchOf('A1') }), AT), /stamp_watch_notices_batch_id_check/);
    await assert.rejects(store.record(reading({ nodeId: 'a node' }), AT), /stamp_watch_notices_node_id_check/);
    await assert.rejects(store.record(reading({ holder: 'gateway' as never }), AT), /stamp_watch_notices_holder_check/);
    await assert.rejects(store.record(reading({ level: 'gone' as never }), AT), /stamp_watch_notices_level_check/);
    await assert.rejects(store.record(reading({ message: '' }), AT), /stamp_watch_notices_message_check/);
    assert.deepEqual(await store.rows(), []);
  });
});
