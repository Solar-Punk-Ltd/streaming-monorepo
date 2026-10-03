/**
 * Migration 013 against the real database: the batch the catalogue is written with on `catalogue_stamp`, and the
 * exact bytes and the batch of every write on `feed_writes`. Needs Postgres, like the rest of this suite;
 * `DATABASE_URL` overrides the connection.
 *
 * What a fake cannot stand in for is the SQL: that pinning a batch already pinned changes nothing; that a push for
 * the pinned batch refreshes its record and a push for another leaves it as it was, as does a clear; that the CHECKs
 * refuse half a pin, a pinned record of another batch and a payload text that is not the payload; and that the
 * catalogue batch service over these tables writes with the pinned batch while a move waits.
 *
 * Every row it writes is in the suite's throwaway database; it empties the tables it uses before each test.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { CatalogueBatchService } from '../../src/domain/CatalogueBatch.js';
import { Database } from '../../src/domain/Database.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { FeedWriteRepository } from '../../src/domain/FeedWriteRepository.js';
import { PostgresAuditLog } from '../../src/domain/PostgresAuditLog.js';
import { CatalogueStampRepository } from '../../src/domain/StageRepository.js';
import { CATALOGUE_BATCH_ID, catalogueStampRecord } from '../unit/support/stageFakes.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let catalogue: CatalogueStampRepository;
let feedWrites: FeedWriteRepository;

const NEXT_BATCH_ID = 'd3'.repeat(32);

/** Who the writes here are made by: the suite, which has no user row an operator actor would need. */
const WRITER = { kind: 'system', reason: 'catalogue writes itest' } as const;

/** A feed of the suite's own, so nothing the instance publishes is in the way. */
const feed: FeedIdentity = { owner: 'ab'.repeat(20), topic: 'catalogue-writes-itest', topicHex: 'cd'.repeat(32) };

/** A manager's moment on a day the database's clock is nowhere near. */
const at = (time: string) => `2030-01-01T${time}.000Z`;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  catalogue = new CatalogueStampRepository(database.pool);
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
  await database.pool.query('DELETE FROM catalogue_stamp');
  await database.pool.query('DELETE FROM feed_writes WHERE feed_owner = $1', [feed.owner]);
  await database.pool.query("DELETE FROM audit_log WHERE action = 'catalogue.batch.pin'");
});

describe('catalogue_stamp, the pinned batch', () => {
  it('pins once: a second pin of the same batch changes nothing', async () => {
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:00:00') }));

    assert.equal(await catalogue.pin(catalogueStampRecord({ observedAt: at('10:00:00') })), true);
    const first = await catalogue.get();
    assert.equal(first?.active_batch_id, CATALOGUE_BATCH_ID);
    assert.equal(first?.active_record?.beeApiUrl, 'http://192.0.2.10:1633');
    assert.ok(first?.active_pinned_at);

    assert.equal(await catalogue.pin(catalogueStampRecord({ observedAt: at('10:00:00') })), false);
    assert.deepEqual((await catalogue.get())?.active_pinned_at, first.active_pinned_at);
  });

  it('refreshes the pinned record on a push for its batch, and keeps it through another designation and a clear', async () => {
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:00:00') }));
    await catalogue.pin(catalogueStampRecord({ observedAt: at('10:00:00') }));

    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:01:00'), ttlSeconds: 86_400 }));
    assert.equal((await catalogue.get())?.active_record?.ttlSeconds, 86_400);

    await catalogue.upsert(
      catalogueStampRecord({ observedAt: at('10:02:00'), batchId: NEXT_BATCH_ID, ttlSeconds: 90 * 86_400 }),
    );
    const moved = await catalogue.get();
    assert.equal(moved?.batch_id, NEXT_BATCH_ID);
    assert.equal(moved?.active_batch_id, CATALOGUE_BATCH_ID);
    assert.equal(moved?.active_record?.ttlSeconds, 86_400, 'a push for another batch leaves the pinned one be');
    assert.equal(moved?.active_record?.observedAt, at('10:01:00'));

    await catalogue.clear(at('10:03:00'));
    const cleared = await catalogue.get();
    assert.ok(cleared?.cleared_observed_at);
    assert.equal(cleared?.active_batch_id, CATALOGUE_BATCH_ID, 'a clear leaves the pin');
  });

  it('refreshes the pinned record from the previous batch a move pushes, and only from a reading not older than it', async () => {
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:00:00') }));
    await catalogue.pin(catalogueStampRecord({ observedAt: at('10:00:00') }));
    const { nodeName, beeApiUrl, batchId, immutable, depth, state, fillRatio } = catalogueStampRecord();
    const previous = { nodeName, beeApiUrl, batchId, immutable, depth, state, ttlSeconds: 90 * 86_400, fillRatio };

    await catalogue.upsert(
      catalogueStampRecord({ observedAt: at('10:01:00'), batchId: NEXT_BATCH_ID, nodeName: 'next', previous }),
    );
    const refreshed = await catalogue.get();
    assert.equal(refreshed?.batch_id, NEXT_BATCH_ID);
    assert.equal(refreshed?.active_batch_id, CATALOGUE_BATCH_ID);
    assert.equal(refreshed?.active_record?.batchId, CATALOGUE_BATCH_ID);
    assert.equal(refreshed?.active_record?.nodeName, 'catalogue-node');
    assert.equal(refreshed?.active_record?.ttlSeconds, 90 * 86_400);
    assert.equal(refreshed?.active_record?.observedAt, at('10:01:00'));
    assert.equal(refreshed?.active_record?.designatedAt, catalogueStampRecord().designatedAt);

    // A previous of another batch, or none, leaves the pinned record as it was.
    await catalogue.upsert(
      catalogueStampRecord({
        observedAt: at('10:02:00'),
        batchId: NEXT_BATCH_ID,
        previous: { ...previous, batchId: 'e4'.repeat(32), ttlSeconds: 1 },
      }),
    );
    await catalogue.upsert(
      catalogueStampRecord({ observedAt: at('10:03:00'), batchId: NEXT_BATCH_ID, previous: null }),
    );
    assert.equal((await catalogue.get())?.active_record?.observedAt, at('10:01:00'));

    // A pinned reading newer than the record is kept, whatever the record's previous says.
    await database.pool.query(`UPDATE catalogue_stamp SET active_record = active_record || $1::jsonb`, [
      JSON.stringify({ observedAt: at('10:30:00') }),
    ]);
    await catalogue.upsert(
      catalogueStampRecord({
        observedAt: at('10:04:00'),
        batchId: NEXT_BATCH_ID,
        previous: { ...previous, ttlSeconds: 1 },
      }),
    );
    const kept = await catalogue.get();
    assert.equal(kept?.batch_id, NEXT_BATCH_ID);
    assert.equal(kept?.active_record?.ttlSeconds, 90 * 86_400);
    assert.equal(kept?.active_record?.observedAt, at('10:30:00'));
  });

  it('pins with the stored designated record when it is for that batch, not an older copy the caller read', async () => {
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:00:00'), ttlSeconds: 30 * 86_400 }));
    const readEarlier = catalogueStampRecord({ observedAt: at('10:00:00'), ttlSeconds: 30 * 86_400 });
    // The manager pushes a fresher reading of the same batch between the plan and the pin.
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:01:00'), ttlSeconds: 29 * 86_400 }));

    assert.equal(await catalogue.pin(readEarlier), true);
    const pinned = await catalogue.get();
    assert.equal(pinned?.active_record?.observedAt, at('10:01:00'));
    assert.equal(pinned?.active_record?.ttlSeconds, 29 * 86_400);
  });

  it('pins with the record it is handed when the designated one is for another batch', async () => {
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:00:00'), batchId: NEXT_BATCH_ID }));

    assert.equal(await catalogue.pin(catalogueStampRecord({ observedAt: at('09:00:00') })), true);
    const pinned = await catalogue.get();
    assert.equal(pinned?.active_batch_id, CATALOGUE_BATCH_ID);
    assert.equal(pinned?.active_record?.batchId, CATALOGUE_BATCH_ID);
    assert.equal(pinned?.active_record?.observedAt, at('09:00:00'));
  });

  it('refuses half a pin, and a pinned record of another batch', async () => {
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:00:00') }));
    const broken = [
      [`UPDATE catalogue_stamp SET active_batch_id = $1`, [CATALOGUE_BATCH_ID]],
      [
        `UPDATE catalogue_stamp SET active_batch_id = $1, active_record = $2::jsonb, active_pinned_at = NOW()`,
        [NEXT_BATCH_ID, JSON.stringify(catalogueStampRecord())],
      ],
    ] as const;
    for (const [sql, values] of broken) {
      await assert.rejects(database.pool.query(sql, [...values]), { code: '23514' }, sql);
    }
  });
});

describe('feed_writes, the exact bytes', () => {
  it('stores the text as it was uploaded, with its batch, and the payload parsed from it', async () => {
    // Key order and spacing a JSONB column would not keep: the text is what was sent, not what reads back.
    const payloadText = '[{"topic":"t","owner":"o","title":"Ünïcödé"}]';
    await feedWrites.record({
      owner: feed.owner,
      topic: feed.topicHex,
      feedIndex: 0,
      entryCount: 1,
      payload: JSON.parse(payloadText) as unknown[],
      payloadText,
      reference: 'e'.repeat(64),
      batchId: CATALOGUE_BATCH_ID,
    });

    const stored = await database.pool.query<{ payload: unknown; payload_text: string; batch_id: string }>(
      'SELECT payload, payload_text, batch_id FROM feed_writes WHERE feed_owner = $1',
      [feed.owner],
    );
    assert.equal(stored.rows[0]?.payload_text, payloadText);
    assert.equal(stored.rows[0]?.batch_id, CATALOGUE_BATCH_ID);
    assert.deepEqual(stored.rows[0]?.payload, JSON.parse(payloadText));
    assert.deepEqual((await feedWrites.lastWrite(feed.owner, feed.topicHex))?.entries, JSON.parse(payloadText));
  });

  it('takes a row without the text, as rows written before the migration are, and refuses a text that is not the payload', async () => {
    await database.pool.query(
      `INSERT INTO feed_writes (feed_owner, feed_topic, feed_index, entry_count, payload) VALUES ($1, $2, 0, 0, '[]')`,
      [feed.owner, feed.topicHex],
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO feed_writes (feed_owner, feed_topic, feed_index, entry_count, payload, payload_text)
         VALUES ($1, $2, 1, 0, '[]', '[1]')`,
        [feed.owner, feed.topicHex],
      ),
      { code: '23514' },
    );
  });

  it('counts the writes of this feed with no batch recorded, and no one else’s', async () => {
    const insert = (owner: string, index: number, batchId: string | null) =>
      database.pool.query(
        `INSERT INTO feed_writes (feed_owner, feed_topic, feed_index, entry_count, payload, payload_text, batch_id)
         VALUES ($1, $2, $3, 0, '[]', '[]', $4)`,
        [owner, feed.topicHex, index, batchId],
      );
    await insert(feed.owner, 0, null);
    await insert(feed.owner, 1, null);
    await insert(feed.owner, 2, CATALOGUE_BATCH_ID);
    // Another feed key's writes are not this feed's history.
    await insert('ef'.repeat(20), 0, null);

    try {
      assert.equal(await feedWrites.countUnrecordedBatch(feed.owner, feed.topicHex), 2);
      assert.equal(await feedWrites.countUnrecordedBatch(feed.owner.toUpperCase(), feed.topicHex), 2, 'any case');
      assert.equal(await feedWrites.countUnrecordedBatch(feed.owner, 'ee'.repeat(32)), 0);
    } finally {
      await database.pool.query('DELETE FROM feed_writes WHERE feed_owner = $1', ['ef'.repeat(20)]);
    }
  });
});

describe('CatalogueBatchService over Postgres', () => {
  it('writes with the pinned batch once the feed has history, and names the designated one as a waiting move', async () => {
    const batches = new CatalogueBatchService(catalogue, feedWrites, feed, new PostgresAuditLog(database.pool), {
      stampRequired: true,
    });
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:00:00') }));

    const target = await batches.forWrite(WRITER);
    assert.equal(target?.batchId, CATALOGUE_BATCH_ID);
    await feedWrites.record({
      owner: feed.owner,
      topic: feed.topicHex,
      feedIndex: 0,
      entryCount: 0,
      payload: [],
      payloadText: '[]',
      reference: 'e'.repeat(64),
      batchId: target!.batchId,
    });

    await catalogue.upsert(
      catalogueStampRecord({
        observedAt: at('10:01:00'),
        batchId: NEXT_BATCH_ID,
        beeApiUrl: 'http://198.51.100.7:1633',
      }),
    );
    assert.deepEqual(await batches.forWrite(WRITER), {
      beeApiUrl: 'http://192.0.2.10:1633',
      batchId: CATALOGUE_BATCH_ID,
    });
    const status = await batches.status();
    assert.equal(status.moveWaitingTo, NEXT_BATCH_ID);
    assert.equal(status.batch?.batchId, CATALOGUE_BATCH_ID);
    assert.equal(status.unrecordedHistory, null, 'the one write names its batch');

    // A write from before the catalogue stamp, which names none.
    await database.pool.query(
      `INSERT INTO feed_writes (feed_owner, feed_topic, feed_index, entry_count, payload) VALUES ($1, $2, 1, 0, '[]')`,
      [feed.owner, feed.topicHex],
    );
    assert.deepEqual((await batches.status()).unrecordedHistory, { writes: 1 });

    const audited = await database.pool.query<{ action: string; actor_kind: string }>(
      `SELECT action, actor_kind FROM audit_log WHERE action = 'catalogue.batch.pin'`,
    );
    assert.deepEqual(
      audited.rows.map((row) => [row.action, row.actor_kind]),
      [['catalogue.batch.pin', 'system']],
    );
  });
});
