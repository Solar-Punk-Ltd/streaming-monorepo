/**
 * StreamRepository against the real database. Needs Postgres up and migrated
 * (`pnpm database:start` plus one `pnpm dev`, which is what the rest of this
 * suite needs anyway); `DATABASE_URL` overrides the connection.
 *
 * What is exercised here is the SQL a fake repository cannot stand in for:
 * the boot-time repair of rows left claimed by a process that died mid-publish,
 * and the un-finishing of an ABR ladder when a broadcast goes live again.
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
import { StreamRepository } from '../../src/domain/StreamRepository.js';

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
    userId = user.rows[0].id;
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
  await streams.finishPublish(row.id, userId, 1, null);
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
