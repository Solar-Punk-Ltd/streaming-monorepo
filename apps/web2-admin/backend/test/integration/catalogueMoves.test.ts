/**
 * Migration 014 against the real database: `catalogue_moves`, the restamp columns of `feed_writes`, and the
 * repository the catalogue move keeps its progress with. Needs Postgres, like the rest of this suite;
 * `DATABASE_URL` overrides the connection.
 *
 * What the in-memory store of the unit tests cannot stand in for is the SQL: that one move runs per feed and a second
 * start answers null; that a slot is recorded only as the move's next one while it runs, and marks its row in the same
 * transaction; that the counts treat a row with no batch as under none; that a retry is only of a failed move and
 * never beside a running one; that the CHECKs refuse a half-recorded state; and that a thumbnail is found by its
 * reference only while a stream still names it.
 *
 * Every row it writes is in the suite's throwaway database; it empties the tables it uses before each test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { BeeFeedGateway } from '../../src/domain/BeeFeedGateway.js';
import { CatalogueMoveService } from '../../src/domain/CatalogueMove.js';
import { CatalogueMoveRepository } from '../../src/domain/CatalogueMoveRepository.js';
import { Database } from '../../src/domain/Database.js';
import { feedIdentityFrom } from '../../src/domain/feedIdentity.js';
import { FeedWriteRepository } from '../../src/domain/FeedWriteRepository.js';
import { Mutex } from '../../src/domain/Mutex.js';
import { PostgresAuditLog } from '../../src/domain/PostgresAuditLog.js';
import { CatalogueStampRepository } from '../../src/domain/StageRepository.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { EDITABLE_STATUSES } from '../../src/types/index.js';
import { FakeBee } from '../unit/support/fakeBee.js';
import { catalogueStampRecord } from '../unit/support/stageFakes.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let moves: CatalogueMoveRepository;
let feedWrites: FeedWriteRepository;

const OWNER = 'ab'.repeat(20);
const TOPIC = 'ef'.repeat(32);
const OLD = 'a1'.repeat(32);
const NEW = 'b2'.repeat(32);

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  moves = new CatalogueMoveRepository(database.pool);
  feedWrites = new FeedWriteRepository(database.pool);
});

after(async () => {
  if (!database) {
    await releaseStack();
    return;
  }
  await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM catalogue_moves');
  await database.pool.query('DELETE FROM feed_writes WHERE feed_owner = $1', [OWNER]);
});

/** A slot written with `batchId`, with its bytes recorded unless `text` is false. */
async function slot(index: number, batchId: string | null, text = true): Promise<void> {
  const payload = [{ topic: `s${index}` }];
  await feedWrites.record({
    owner: OWNER,
    topic: TOPIC,
    feedIndex: index,
    entryCount: 1,
    payload,
    payloadText: text ? JSON.stringify(payload) : null,
    reference: null,
    batchId,
  });
}

function start(targetBatchId = NEW) {
  return moves.create({ owner: OWNER, topic: TOPIC, targetBatchId, fromBatchId: OLD, startedBy: 'itest' });
}

describe('catalogue_moves', () => {
  it('runs one move per feed: a second start answers null, and another feed has its own', async () => {
    const first = await start();
    assert.equal(first?.state, 'running');
    assert.equal(first?.nextIndex, 0);
    assert.equal(first?.headIndex, null);
    assert.equal(await start(), null);

    const other = await moves.create({
      owner: OWNER,
      topic: 'aa'.repeat(32),
      targetBatchId: NEW,
      fromBatchId: null,
      startedBy: 'itest',
    });
    assert.equal(other?.state, 'running');
    assert.equal((await moves.latest(OWNER, TOPIC))?.id, first?.id);
  });

  it('records a slot only as the next one of a running move, and marks its row in the same step', async () => {
    await slot(0, OLD);
    await slot(1, OLD);
    const move = (await start())!;

    const zero = await moves.recordSlot(move.id, { owner: OWNER, topic: TOPIC, index: 0, restamped: true, head: 1 });
    assert.equal(zero?.nextIndex, 1);
    assert.equal(zero?.headIndex, 1);
    assert.equal(zero?.restampedSlots, 1);
    assert.equal(
      await moves.recordSlot(move.id, { owner: OWNER, topic: TOPIC, index: 0, restamped: true, head: 1 }),
      null,
      'slot 0 again',
    );
    const skipped = await moves.recordSlot(move.id, {
      owner: OWNER,
      topic: TOPIC,
      index: 1,
      restamped: false,
      head: 1,
    });
    assert.equal(skipped?.skippedSlots, 1);

    const rows = await moves.slots(OWNER, TOPIC, 0, 1);
    assert.deepEqual(
      rows.map((row) => [row.index, row.restampedBatchId]),
      [
        [0, NEW],
        [1, null],
      ],
    );
    const marked = await database.pool.query<{ restamped_at: Date | null }>(
      'SELECT restamped_at FROM feed_writes WHERE feed_owner = $1 AND feed_index = 0',
      [OWNER],
    );
    assert.ok(marked.rows[0]?.restamped_at);

    await moves.fail(move.id, 'stopped');
    assert.equal(
      await moves.recordSlot(move.id, { owner: OWNER, topic: TOPIC, index: 2, restamped: true, head: 2 }),
      null,
      'a failed move records nothing',
    );
  });

  it('answers the rows of a span in order, and none for a slot with no row', async () => {
    await slot(2, OLD);
    await slot(0, null, false);
    const rows = await moves.slots(OWNER, TOPIC, 0, 2);
    assert.deepEqual(
      rows.map((row) => [row.index, row.batchId, row.payloadText !== null]),
      [
        [0, null, false],
        [2, OLD, true],
      ],
    );
  });

  it('counts the rows under a batch and those that can be uploaded again, a row with no batch under none', async () => {
    await slot(0, null, false);
    await slot(1, null, true);
    await slot(2, OLD, true);
    await slot(3, NEW, false);
    const move = (await start())!;
    await moves.recordSlot(move.id, { owner: OWNER, topic: TOPIC, index: 0, restamped: true, head: 3 });

    assert.deepEqual(await moves.slotCounts(OWNER, TOPIC, NEW, 0, 3), { underTarget: 2, readable: 4 });
    assert.deepEqual(await moves.slotCounts(OWNER, TOPIC, NEW, 1, 2), { underTarget: 0, readable: 2 });
    assert.deepEqual(await moves.slotCounts(OWNER, TOPIC, OLD, 0, 3), { underTarget: 1, readable: 2 });
  });

  it('retries only a failed move, and not beside a running one', async () => {
    const move = (await start())!;
    assert.equal(await moves.retry(move.id), null, 'it is running');
    const failed = await moves.fail(move.id, 'the node answered 500');
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.error, 'the node answered 500');
    assert.ok(failed?.finishedAt);

    const other = (await start('c3'.repeat(32)))!;
    assert.equal(await moves.retry(move.id), null, 'another move runs');
    await moves.fail(other.id, 'x');

    const again = await moves.retry(move.id);
    assert.equal(again?.state, 'running');
    assert.equal(again?.error, null);
    assert.equal(again?.finishedAt, null);
  });

  it('finishes only a running move, and says which slots a finished move to a batch covers', async () => {
    const move = (await start())!;
    for (const index of [0, 1, 2]) {
      await moves.recordSlot(move.id, { owner: OWNER, topic: TOPIC, index, restamped: true, head: 2 });
    }
    assert.equal(await moves.coveredBelow(OWNER, TOPIC, NEW), 0, 'not before it is done');
    const done = await moves.finish(move.id, 2);
    assert.equal(done?.state, 'done');
    assert.equal(done?.thumbnails, 2);
    assert.equal(await moves.finish(move.id, 2), null);
    assert.equal(await moves.fail(move.id, 'late'), null);
    assert.equal(await moves.coveredBelow(OWNER, TOPIC, NEW), 3);
    assert.equal(await moves.coveredBelow(OWNER, TOPIC, OLD), 0);
  });

  it('refuses half a state: a failure with no reason, a finish time on a running move, half a restamp mark', async () => {
    const move = (await start())!;
    await assert.rejects(
      database.pool.query("UPDATE catalogue_moves SET state = 'failed' WHERE id = $1", [move.id]),
      /check constraint/,
    );
    await assert.rejects(
      database.pool.query('UPDATE catalogue_moves SET finished_at = NOW() WHERE id = $1', [move.id]),
      /check constraint/,
    );
    await assert.rejects(
      database.pool.query(
        "INSERT INTO catalogue_moves (feed_owner, feed_topic, target_batch_id, state, started_by) VALUES ($1, $2, 'not-a-batch', 'done', 'x')",
        [OWNER, 'bb'.repeat(32)],
      ),
      /check constraint/,
    );
    await slot(0, OLD);
    await assert.rejects(
      database.pool.query('UPDATE feed_writes SET restamped_batch_id = $2 WHERE feed_owner = $1', [OWNER, NEW]),
      /check constraint/,
    );
  });
});

describe('CatalogueMoveService over Postgres', () => {
  const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const identity = feedIdentityFrom(KEY, 'catalogue-moves-itest');
  const MOVER = { kind: 'system', reason: 'catalogue moves itest' } as const;
  let bee: FakeBee;

  before(async () => {
    bee = await new FakeBee().start();
  });

  after(async () => {
    await bee.stop();
  });

  beforeEach(async () => {
    await database.pool.query('DELETE FROM catalogue_stamp');
    await database.pool.query('DELETE FROM feed_writes WHERE feed_owner = $1', [identity.owner]);
    await database.pool.query("DELETE FROM audit_log WHERE action LIKE 'catalogue.%'");
  });

  it('moves every slot under the new batch, records its progress, switches the pinned batch and audits both ends', async () => {
    const gateway = new BeeFeedGateway({ feedPrivateKey: KEY, feedTopic: 'catalogue-moves-itest' });
    const stamps = new CatalogueStampRepository(database.pool);
    const old = catalogueStampRecord({ batchId: OLD, beeApiUrl: bee.url, observedAt: '2030-01-01T10:00:00.000Z' });
    await stamps.upsert(old);
    await stamps.pin(old);
    const written: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const payloadText = JSON.stringify([{ topic: `s${index}` }]);
      const reference = await gateway.write(payloadText, index, { beeApiUrl: bee.url, batchId: OLD });
      written.push(reference);
      await feedWrites.record({
        owner: identity.owner,
        topic: identity.topicHex,
        feedIndex: index,
        entryCount: 1,
        payload: JSON.parse(payloadText) as unknown[],
        // Slot 1 is from before migration 013: no bytes, no batch.
        payloadText: index === 1 ? null : payloadText,
        reference: index === 1 ? null : reference,
        batchId: index === 1 ? null : OLD,
      });
    }
    await stamps.upsert({ ...old, batchId: NEW, observedAt: '2030-01-01T10:01:00.000Z' });

    const audit = new PostgresAuditLog(database.pool);
    const moving = new CatalogueMoveService(
      moves,
      stamps,
      feedWrites,
      new StreamRepository(database.pool),
      gateway,
      new Mutex(),
      identity,
      audit,
      { enabled: true, now: () => Date.parse('2030-01-01T10:05:00.000Z'), sliceSlots: 2 },
    );

    assert.deepEqual((await moving.status()).waiting, { targetBatchId: NEW, fromBatchId: OLD, slots: 4 });
    await moving.start(MOVER, NEW);
    await moving.settled();

    const status = await moving.status();
    assert.equal(status.latest?.state, 'done', status.latest?.error ?? '');
    assert.equal(status.latest?.slotsDone, 4);
    assert.equal(status.waiting, null);
    assert.deepEqual(
      bee.under(NEW, 'soc').map((upload) => upload.address),
      written,
    );
    assert.equal((await stamps.get())?.active_batch_id, NEW);
    const marked = await database.pool.query<{ feed_index: string; restamped_batch_id: string }>(
      'SELECT feed_index, restamped_batch_id FROM feed_writes WHERE feed_owner = $1 ORDER BY feed_index',
      [identity.owner],
    );
    assert.deepEqual(
      marked.rows.map((row) => [Number(row.feed_index), row.restamped_batch_id]),
      [
        [0, NEW],
        [1, NEW],
        [2, NEW],
        [3, NEW],
      ],
    );
    const audited = await database.pool.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE action LIKE 'catalogue.move.%' ORDER BY id",
    );
    assert.deepEqual(
      audited.rows.map((row) => row.action),
      ['catalogue.move.start', 'catalogue.move.done'],
    );
  });
});

describe('a thumbnail by its reference', () => {
  let userId: string;
  let streams: StreamRepository;

  before(async () => {
    streams = new StreamRepository(database.pool);
    const user = await database.pool.query<{ id: string }>(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb') RETURNING id`,
      [`itest-${randomUUID().slice(0, 8)}`],
    );
    userId = user.rows[0]!.id;
  });

  after(async () => {
    await database.pool.query('DELETE FROM streams WHERE user_id = $1', [userId]);
    await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('is found while the stream names it, with its topic, and not once the image changed', async () => {
    const row = await streams.insert({
      user_id: userId,
      topic: randomUUID(),
      owner: '90f8bf6a479f320ead074411a4b0e7944ea8c9c1',
      title: 'itest thumbnail',
      description: 'a stream whose image the catalogue names',
      tags: [],
      media_type: 'video',
      scheduled_start_time: null,
      publish_key: newPublishKey(),
      stage_id: null,
    });
    const reference = 'fe'.repeat(32);
    await streams.setThumbnail(row.id, Buffer.from([1, 2, 3]), 'image/png', EDITABLE_STATUSES);
    await streams.recordThumbnailRef(row.id, reference);

    const found = await streams.findThumbnailByRef(reference);
    assert.deepEqual(found && [found.topic, found.thumbnail_mime, [...found.thumbnail]], [
      row.topic,
      'image/png',
      [1, 2, 3],
    ]);

    await streams.setThumbnail(row.id, Buffer.from([4, 5]), 'image/jpeg', EDITABLE_STATUSES);
    assert.equal(await streams.findThumbnailByRef(reference), null);
  });
});
