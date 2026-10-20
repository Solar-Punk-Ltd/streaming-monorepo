/**
 * A finished stream cannot be restarted by mistake, in the SQL itself: migration 022's column and index, Finish's
 * conditional update, what `markLive` and `markVod` do to `finished_at`, and the restart window's sweep worked out
 * against the database's clock. Needs Postgres, like the rest of this suite; `DATABASE_URL` overrides the connection.
 * The service around it is pinned in `test/unit/streamFinish.test.ts`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import type { StreamRow } from '../../src/types/index.js';

import { releaseStack, requireStack, stack } from './helpers.js';

const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';

let database: Database;
let streams: StreamRepository;
let userId: string;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb') RETURNING id`,
    [`itest-${randomUUID().slice(0, 8)}`],
  );
  userId = user.rows[0]!.id;
  streams = new StreamRepository(database.pool);
});

after(async () => {
  if (userId) {
    await database.pool.query('DELETE FROM streams WHERE user_id = $1', [userId]);
    await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  await database.close();
  await releaseStack();
});

/**
 * A stream in `status`, with `ended_at` set by the database's own clock `endedAgo` (a Postgres interval) before now,
 * or null. What a broadcast leaves behind, without the uploader.
 */
async function streamIn(status: StreamRow['status'], endedAgo: string | null = null): Promise<StreamRow> {
  const row = await streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: OWNER,
    title: 'itest finish',
    description: 'a broadcast that ended, for the restart window',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
    stage_id: null,
  });
  await database.pool.query(
    `UPDATE streams
        SET status = $2,
            ended_at = CASE WHEN $3::interval IS NULL THEN NULL ELSE NOW() - $3::interval END,
            manifest_index = CASE WHEN $2 = 'vod' THEN 1 ELSE NULL END,
            duration_seconds = CASE WHEN $2 = 'vod' THEN 10 ELSE NULL END
      WHERE id = $1`,
    [row.id, status, endedAgo],
  );
  return (await streams.findById(row.id))!;
}

/** The sweep's selection, among this file's own rows. */
async function selected(windowMinutes: number, mine: readonly StreamRow[]): Promise<string[]> {
  const ids = new Set(mine.map((row) => row.id));
  return (await streams.listRestartWindowRunOut(windowMinutes)).filter((id) => ids.has(id));
}

describe('migration 022', () => {
  it('adds finished_at, null on every row it found, and the partial index the sweep reads', async () => {
    const column = await database.pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'streams' AND column_name = 'finished_at'`,
    );
    assert.deepEqual(column.rows, [{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
    const index = await database.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'streams' AND indexname = 'streams_restart_window'`,
    );
    assert.equal(index.rows.length, 1);
    assert.match(index.rows[0]!.indexdef, /\(ended_at\)/);
    assert.match(index.rows[0]!.indexdef, /status = 'vod'/);
    assert.match(index.rows[0]!.indexdef, /finished_at IS NULL/);
    assert.equal((await streamIn('vod', '1 hour')).finished_at, null);
  });
});

describe('Finish', () => {
  it('changes the key of a recorded stream once, with finished_at, and matches nothing a second time', async () => {
    const stream = await streamIn('vod', '1 minute');
    const key = newPublishKey();

    const finished = await streams.finish(stream.id, key);

    assert.ok(finished);
    assert.equal(finished.publish_key, key);
    assert.ok(finished.finished_at instanceof Date, 'finished_at is read back');
    assert.deepEqual(finished.publish_key_rotated_at, finished.finished_at);
    assert.equal(finished.status, 'vod');
    assert.equal(await streams.finish(stream.id, newPublishKey()), null, 'a second Finalize matches nothing');
    assert.equal((await streams.findById(stream.id))?.publish_key, key);
  });

  it('matches nothing on a live stream, nor on one that never ended', async () => {
    for (const status of ['live', 'draft', 'published', 'publishing'] as const) {
      const stream = await streamIn(status);
      assert.equal(await streams.finish(stream.id, newPublishKey()), null, status);
      assert.equal((await streams.findById(stream.id))?.publish_key, stream.publish_key);
    }
  });
});

describe('finished_at through the state reports', () => {
  it('is cleared by a comeback from vod, and left by a retried live report and by the vod report', async () => {
    // A row finalized while live by an earlier release (rc.6 on QA): Finalize refuses a live stream now.
    const live = await streamIn('live');
    await database.pool.query(`UPDATE streams SET finished_at = NOW() WHERE id = $1`, [live.id]);
    assert.ok((await streams.markLive(live.id, ['live', 'vod']))?.finished_at, 'live → live leaves it');
    assert.ok((await streams.markVod(live.id, ['live', 'vod'], 2, 20))?.finished_at, 'the vod report leaves it');

    const back = await streams.markLive(live.id, ['live', 'vod']);
    assert.equal(back?.finished_at, null, 'vod → live clears it: a new window at its next end');
  });

  it('is cleared by a broadcast that starts from published, so the sweep finishes that recording in its turn', async () => {
    // A finished recording whose republish was claimed when the process died: the boot's reset puts it back to
    // `published` with its mark still set.
    const stream = await streamIn('vod', '2 hours');
    await streams.finish(stream.id, newPublishKey());
    await database.pool.query(`UPDATE streams SET status = 'published' WHERE id = $1`, [stream.id]);

    const live = await streams.markLive(stream.id, ['published', 'live', 'vod']);
    assert.equal(live?.finished_at, null, 'a live report that starts a broadcast clears it');
    await streams.markVod(stream.id, ['live'], 2, 20);
    await database.pool.query(`UPDATE streams SET ended_at = NOW() - interval '31 minutes' WHERE id = $1`, [stream.id]);

    assert.deepEqual(await selected(30, [stream]), [stream.id], 'its window runs out like any other');
  });
});

describe("the restart window's sweep", () => {
  it('selects recorded, unfinished streams ended at least the window ago by the database clock, or never', async () => {
    const ranOut = await streamIn('vod', '31 minutes');
    const recent = await streamIn('vod', '29 minutes');
    const neverEnded = await streamIn('vod');
    const live = await streamIn('live', '2 hours');
    const finished = await streamIn('vod', '2 hours');
    await streams.finish(finished.id, newPublishKey());
    const mine = [ranOut, recent, neverEnded, live, finished];

    assert.deepEqual(await selected(30, mine), [neverEnded.id, ranOut.id], 'no ended_at first, then the oldest');
    assert.deepEqual(
      (await selected(0, mine)).sort(),
      [neverEnded.id, ranOut.id, recent.id].sort(),
      'a window of 0 takes every recorded stream that has ended',
    );
  });

  it('changes a key whose window ran out once, and leaves one whose window has not', async () => {
    const ranOut = await streamIn('vod', '31 minutes');
    const recent = await streamIn('vod', '29 minutes');
    const key = newPublishKey();

    const finished = await streams.finishAfterWindow(ranOut.id, key, 30);

    assert.equal(finished?.publish_key, key);
    assert.ok(finished?.finished_at instanceof Date);
    assert.equal(await streams.finishAfterWindow(ranOut.id, newPublishKey(), 30), null, 'matches once');
    assert.equal((await streams.findById(ranOut.id))?.publish_key, key);
    assert.equal(await streams.finishAfterWindow(recent.id, newPublishKey(), 30), null, 'its window is still open');
    assert.equal((await streams.findById(recent.id))?.publish_key, recent.publish_key);
  });

  it('leaves a stream that went live again between the selection and its update', async () => {
    const stream = await streamIn('vod', '31 minutes');
    assert.deepEqual(await selected(30, [stream]), [stream.id]);
    await streams.markLive(stream.id, ['live', 'vod']);

    assert.equal(await streams.finishAfterWindow(stream.id, newPublishKey(), 30), null);
    assert.equal((await streams.findById(stream.id))?.publish_key, stream.publish_key);
  });
});
