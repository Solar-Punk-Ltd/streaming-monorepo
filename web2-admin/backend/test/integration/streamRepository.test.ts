/**
 * StreamRepository against the real database. Needs Postgres up and migrated
 * (`pnpm database:start` plus one `pnpm dev`, which is what the rest of this
 * suite needs anyway); `DATABASE_URL` overrides the connection.
 *
 * What is exercised here is the SQL a fake repository cannot stand in for:
 * the boot-time repair of rows left claimed by a process that died mid-publish,
 * the un-finishing of an ABR ladder when a broadcast goes live again, an
 * unpublish that keeps the recording and its rungs, and which writes count as
 * a console edit for the "Edited since it was published" notice (migration
 * 006).
 * Getting the first wrong loses streams — a republish interrupted by a restart
 * that came back as `draft` could then be DELETEd, leaving its entry on the
 * feed with no row left to unpublish it. Getting the second wrong is invisible
 * to any fake: `markLive` clears the rungs from inside its own statement, and
 * a CTE that clears none of them returns exactly the same row as one that
 * clears them all.
 *
 * It creates its own user and removes it in `after` (streams cascade), so no
 * other row is touched.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { StreamRenditionRepository } from '../../src/domain/StreamRenditionRepository.js';
import {
  StreamRepository,
  type StreamUpdateData,
} from '../../src/domain/StreamRepository.js';
import { hasUnpublishedEdits } from '../../src/domain/unpublishedEdits.js';
import { EDITABLE_STATUSES, type StreamRow } from '../../src/types/index.js';

import { releaseStack, requireStack, stack } from './helpers.js';

const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';

let database: Database;
let streams: StreamRepository;
let renditions: StreamRenditionRepository;
let userId: string;

before(async () => {
  // The suite's own instance, so the schema is migrated and no row of the
  // development database is ever touched.
  await requireStack();
  database = new Database(stack().databaseUrl);
  try {
    const user = await database.pool.query<{ id: string }>(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb')
       RETURNING id`,
      // Short and lower-case: migration 005 added a CHECK mirroring
      // USERNAME_RE, and a 47 character name would be refused by it.
      [`itest-${randomUUID().slice(0, 8)}`],
    );
    userId = user.rows[0]!.id;
  } catch (err) {
    assert.fail(
      `Postgres is not reachable/migrated at ${stack().databaseUrl} (${String(err)}).\n` +
        'Start it with: pnpm database:start',
    );
  }
  streams = new StreamRepository(database.pool);
  renditions = new StreamRenditionRepository(database.pool);
});

after(async () => {
  if (userId) {
    await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  await database.close();
  await releaseStack();
});

async function claimedStream(publishedFeedIndex: number | null): Promise<string> {
  const row = await streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: OWNER,
    title: 'itest orphan',
    description: 'left claimed by a process that died mid-publish',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
  });
  // What a crash between the claim and finishPublish leaves behind.
  await database.pool.query(
    `UPDATE streams
        SET status = 'publishing',
            published_feed_index = $2,
            published_at = CASE WHEN $2::bigint IS NULL THEN NULL ELSE NOW() END
      WHERE id = $1`,
    [row.id, publishedFeedIndex],
  );
  return row.id;
}

describe('resetOrphanedPublishing', () => {
  it('sends a first-time publish back to draft and a republish back to published', async () => {
    const firstPublish = await claimedStream(null);
    const republish = await claimedStream(7);

    const reset = await streams.resetOrphanedPublishing();
    assert.ok(
      reset.some((s) => s.id === firstPublish) &&
        reset.some((s) => s.id === republish),
      'both claimed rows are reported',
    );

    const draft = await streams.findById(firstPublish, userId);
    assert.equal(draft?.status, 'draft', 'never reached the feed');
    assert.equal(draft?.publish_error, 'backend restarted while publishing');

    const published = await streams.findById(republish, userId);
    assert.equal(
      published?.status,
      'published',
      'was on the feed before the interrupted publish, so it still is',
    );
    assert.equal(published?.published_feed_index, 7);
    assert.equal(published?.publish_error, 'backend restarted while publishing');
  });

  it('leaves a published row that is not claimed alone, and is idempotent', async () => {
    const republish = await claimedStream(3);
    await streams.resetOrphanedPublishing();

    const again = await streams.resetOrphanedPublishing();
    assert.equal(
      again.some((s) => s.id === republish),
      false,
      'a second boot has nothing to repair',
    );
    assert.equal((await streams.findById(republish, userId))?.status, 'published');
  });

  it('keeps a repaired published row undeletable until it is unpublished', async () => {
    // The reason the CASE matters: DELETE is only allowed from draft.
    const republish = await claimedStream(9);
    await streams.resetOrphanedPublishing();

    assert.equal(
      await streams.deleteById(republish, userId, ['draft']),
      false,
      'its entry is still on the feed',
    );
    assert.ok(await streams.findById(republish, userId));
  });
});

/** A finished two-rung ladder on a stream whose recording is final. */
async function recordedLadder(): Promise<string> {
  const row = await streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: OWNER,
    title: 'itest ladder',
    description: 'a recording that is about to go live again',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
  });
  await streams.finishPublish(
    row.id,
    userId,
    1,
    null,
    row.content_edited_at,
    'published',
  );
  await renditions.upsert(row.id, {
    name: '360p',
    width: 640,
    height: 360,
    topic: randomUUID(),
    bandwidth: 800_000,
    avgBandwidth: 700_000,
    index: 10,
    duration: 61,
  });
  await renditions.upsert(row.id, {
    name: '720p',
    width: 1280,
    height: 720,
    topic: randomUUID(),
    bandwidth: 2_800_000,
    avgBandwidth: 2_500_000,
    index: 12,
    duration: 62.5,
  });
  await streams.markLive(row.id, ['published', 'live', 'vod']);
  await streams.markVod(row.id, ['published', 'live', 'vod'], 7, 62.5);
  return row.id;
}

describe('markLive un-finishes a broadcast that comes back', () => {
  it('clears the row and every rung when it resumes from vod', async () => {
    const id = await recordedLadder();

    const live = await streams.markLive(id, ['published', 'live', 'vod']);

    assert.equal(live?.status, 'live');
    assert.equal(live?.manifest_index ?? null, null, 'no recording while live');
    assert.equal(live?.duration_seconds ?? null, null);
    assert.equal(live?.ended_at ?? null, null);

    const rungs = await renditions.listByStream(id);
    assert.equal(rungs.length, 2, 'the rungs themselves survive');
    for (const rung of rungs) {
      assert.equal(
        rung.manifest_index ?? null,
        null,
        `${rung.name} no longer points at the previous recording`,
      );
      assert.equal(rung.duration_seconds ?? null, null, `${rung.name} duration`);
    }
  });

  it('leaves rungs that finalized since a repeated live report alone', async () => {
    const id = await recordedLadder();
    await streams.markLive(id, ['published', 'live', 'vod']);

    // The new session's 360p finishes while the broadcast is still live.
    await renditions.upsert(id, {
      name: '360p',
      width: 640,
      height: 360,
      topic: randomUUID(),
      bandwidth: 800_000,
      avgBandwidth: 700_000,
      index: 99,
      duration: 5,
    });

    await streams.markLive(id, ['published', 'live', 'vod']);

    const rungs = await renditions.listByStream(id);
    const low = rungs.find((r) => r.name === '360p');
    assert.equal(
      Number(low?.manifest_index),
      99,
      'a repeated live report must not throw away what finished since',
    );
    assert.equal(Number(low?.duration_seconds), 5);
  });

  it('touches nothing when the transition is refused', async () => {
    const id = await recordedLadder();

    const refused = await streams.markLive(id, ['published']);

    assert.equal(refused, null, 'vod is not in allowedFrom');
    const row = await streams.findById(id, userId);
    assert.equal(row?.status, 'vod', 'still the recording it was');
    const rungs = await renditions.listByStream(id);
    assert.equal(Number(rungs.find((r) => r.name === '720p')?.manifest_index), 12);
  });
});

describe('an unpublish keeps the recording for the next publish', () => {
  it('takes the row off the catalogue and keeps the recording and every rung', async () => {
    const id = await recordedLadder();

    const draft = await streams.finishUnpublish(id, userId);

    assert.equal(draft?.status, 'draft');
    assert.equal(draft?.published_at, null, 'no longer announced');
    assert.equal(draft?.published_feed_index, null);
    assert.equal(draft?.manifest_index, 7, 'where the recording is');
    assert.equal(draft?.duration_seconds, 62.5, 'how long it runs');
    assert.ok(draft?.live_since, 'when it went live');
    assert.ok(draft?.ended_at, 'when it ended');

    const rungs = await renditions.listByStream(id);
    assert.deepEqual(
      rungs.map((r) => [r.name, Number(r.manifest_index), Number(r.duration_seconds)]),
      [
        ['360p', 10, 61],
        ['720p', 12, 62.5],
      ],
      'every rung, finished as it was',
    );
  });

  it('finishes the next publish as the recording it holds', async () => {
    const id = await recordedLadder();
    const draft = await streams.finishUnpublish(id, userId);
    assert.ok(draft);

    const listed = await streams.finishPublish(
      id,
      userId,
      2,
      null,
      draft.content_edited_at,
      'vod',
    );

    assert.equal(listed?.status, 'vod');
    assert.equal(listed?.published_feed_index, 2);
    assert.ok(listed?.published_at);
    assert.equal(listed?.manifest_index, 7);
  });
});

/** A published stream nobody has edited, as a first publish leaves it. */
async function publishedStream(
  scheduledStartTime: string | null = null,
): Promise<StreamRow> {
  const row = await streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: OWNER,
    title: 'itest notice',
    description: 'published, and not edited since',
    tags: ['itest'],
    media_type: 'video',
    scheduled_start_time: scheduledStartTime,
    publish_key: newPublishKey(),
  });
  const published = await streams.finishPublish(
    row.id,
    userId,
    1,
    null,
    row.content_edited_at,
    'published',
  );
  assert.ok(published);
  return published;
}

/** The form as the row holds it: what a save that changes nothing sends. */
function sameValues(row: StreamRow): StreamUpdateData {
  return {
    title: row.title,
    description: row.description,
    tags: row.tags,
    media_type: row.media_type,
    scheduled_start_time: row.scheduled_start_time?.toISOString() ?? null,
  };
}

/** Puts the edit stamp somewhere unmistakable, so a write can be seen to move it. */
async function setEditStamp(id: string, at: string): Promise<void> {
  await database.pool.query(
    'UPDATE streams SET content_edited_at = $2 WHERE id = $1',
    [id, at],
  );
}

describe('which writes count as a console edit (migration 006)', () => {
  it('starts with nothing to republish, and neither the uploader nor the bookkeeping adds any', async () => {
    const row = await publishedStream();
    assert.equal(row.content_edited_at, null);
    assert.equal(row.entry_content_edited_at, null);

    await streams.markLive(row.id, ['published', 'live', 'vod']);
    await streams.markVod(row.id, ['published', 'live', 'vod'], 7, 61);
    await streams.rotatePublishKey(row.id, userId, newPublishKey());
    await streams.recordThumbnailRef(row.id, userId, 'a'.repeat(64));
    await streams.recordPublishError(row.id, userId, 'bee unreachable');

    const reread = await streams.findById(row.id, userId);
    assert.ok(reread);
    assert.equal(reread.status, 'vod');
    assert.equal(reread.content_edited_at, null);
    assert.equal(hasUnpublishedEdits(reread), false);
  });

  it('stamps a real edit to the millisecond, and a save that changes nothing is not one', async () => {
    const row = await publishedStream('2026-10-01T09:00:00.000Z');

    const resaved = await streams.update(
      row.id,
      userId,
      {
        ...sameValues(row),
        // The same instant, written the way another client might send it.
        scheduled_start_time: '2026-10-01T11:00:00.000+02:00',
      },
      EDITABLE_STATUSES,
    );
    assert.ok(resaved);
    assert.equal(resaved.content_edited_at, null, 'nothing the entry carries changed');

    const edited = await streams.update(
      row.id,
      userId,
      { ...sameValues(row), tags: ['itest', 'retagged'] },
      EDITABLE_STATUSES,
    );
    assert.ok(edited);
    assert.ok(edited.content_edited_at, 'a changed tag is an edit');
    assert.equal(hasUnpublishedEdits(edited), true);

    const stamp = await database.pool.query<{ whole: boolean }>(
      `SELECT content_edited_at = date_trunc('milliseconds', content_edited_at) AS whole
         FROM streams WHERE id = $1`,
      [row.id],
    );
    assert.equal(stamp.rows[0]?.whole, true, 'nothing finer than a Date holds');
  });

  it('counts a new image always, and a removal only when there was an image', async () => {
    const row = await publishedStream();

    const nothingRemoved = await streams.clearThumbnail(
      row.id,
      userId,
      EDITABLE_STATUSES,
    );
    assert.ok(nothingRemoved);
    assert.equal(nothingRemoved.content_edited_at, null);

    const withImage = await streams.setThumbnail(
      row.id,
      userId,
      Buffer.from([1, 2, 3]),
      'image/png',
      EDITABLE_STATUSES,
    );
    assert.ok(withImage);
    assert.ok(withImage.content_edited_at, 'a new image is an edit');

    await setEditStamp(row.id, '2000-01-01T00:00:00.000Z');
    const removed = await streams.clearThumbnail(
      row.id,
      userId,
      EDITABLE_STATUSES,
    );
    assert.ok(removed);
    assert.ok(removed.content_edited_at);
    assert.ok(
      removed.content_edited_at.getTime() > Date.parse('2000-01-01T00:00:00.000Z'),
      'removing the image is an edit',
    );
  });

  it('records the edit an entry was built from, not the one the row holds when the write lands', async () => {
    const row = await publishedStream();
    const edited = await streams.update(
      row.id,
      userId,
      { ...sameValues(row), title: 'itest retitled' },
      EDITABLE_STATUSES,
    );
    assert.ok(edited?.content_edited_at);
    const builtFrom = edited.content_edited_at;

    const caughtUp = await streams.recordRepublish(row.id, userId, 2, null, builtFrom);
    assert.ok(caughtUp);
    assert.equal(hasUnpublishedEdits(caughtUp), false);
    const equal = await database.pool.query<{ equal: boolean }>(
      `SELECT content_edited_at = entry_content_edited_at AS equal
         FROM streams WHERE id = $1`,
      [row.id],
    );
    assert.equal(
      equal.rows[0]?.equal,
      true,
      'equal in SQL too, after the round trip through a Date',
    );

    // The console saves another edit while the next write is on its way, and
    // that write still records the edit its entry was built from.
    await setEditStamp(row.id, '2099-01-01T00:00:00.000Z');
    const behind = await streams.recordRepublish(row.id, userId, 3, null, builtFrom);
    assert.ok(behind);
    assert.equal(behind.entry_content_edited_at?.getTime(), builtFrom.getTime());
    assert.equal(hasUnpublishedEdits(behind), true, 'the later edit is not on the entry');
  });

  it('lets a reconcile record the entry it rebuilt', async () => {
    const row = await publishedStream();
    const edited = await streams.update(
      row.id,
      userId,
      { ...sameValues(row), description: 'itest, reconciled' },
      EDITABLE_STATUSES,
    );
    assert.ok(edited?.content_edited_at);

    await streams.recordEntryRebuilt(row.id, edited.content_edited_at);

    const reread = await streams.findById(row.id, userId);
    assert.ok(reread);
    assert.equal(hasUnpublishedEdits(reread), false);
  });
});
