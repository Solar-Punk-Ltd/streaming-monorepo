/**
 * StreamRepository against the real database. Needs Postgres up and migrated
 * (`pnpm database:start` plus one `pnpm dev`, which is what the rest of this
 * suite needs anyway); `DATABASE_URL` overrides the connection.
 *
 * What is exercised here is the SQL a fake repository cannot stand in for:
 * the boot-time repair of rows left claimed by a process that died mid-publish.
 * Getting that wrong loses streams — a republish interrupted by a restart that
 * came back as `draft` could then be DELETEd, leaving its entry on the feed
 * with no row left to unpublish it.
 *
 * It creates its own user and removes it in `after` (streams cascade), so no
 * other row is touched.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://web2admin:web2admin@127.0.0.1:5433/web2admin';

const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';

let database: Database;
let streams: StreamRepository;
let userId: string;

before(async () => {
  database = new Database(DATABASE_URL);
  try {
    const user = await database.pool.query<{ id: string }>(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb')
       RETURNING id`,
      [`itest-repo-${randomUUID()}`],
    );
    userId = user.rows[0]!.id;
  } catch (err) {
    assert.fail(
      `Postgres is not reachable/migrated at ${DATABASE_URL} (${String(err)}).\n` +
        'Start it with: pnpm database:start && FEED_GATEWAY=fake pnpm dev',
    );
  }
  streams = new StreamRepository(database.pool);
});

after(async () => {
  if (userId) {
    await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  await database.close();
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
