/**
 * A test stream and the catalogue, against the real database and the suite's own backend. Needs Postgres, like the
 * rest of this suite; `DATABASE_URL` overrides the connection.
 *
 * What a fake cannot stand in for is the SQL: that migration 032 runs on a database that holds streams and leaves each
 * of them a stream that is no test, with its check in force; that the check refuses a test row that is published or
 * being published, or carries a catalogue index, a publish time or an image, and takes one that is a draft, live or
 * recorded; that the rows on the feed leave a test stream out; and that the API refuses a publish and an unpublish of a
 * test stream, and writes no entry for a live or a recorded one in a reconcile.
 *
 * The test streams here are rows inserted with their mark set. Every row is in a throwaway database: the suite's own,
 * dropped with its backend, and one this file makes for the migration and drops.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  TEST_STREAM_ERROR,
  TEST_STREAM_REFUSALS,
  type FeedReconcileResult,
  type StreamStatus,
  type TestStreamRefusal,
} from '@streaming-monorepo/web2-admin-common';
import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { STAGE_ID } from '../unit/support/stageFakes.js';

import { api, login, raw, registerStage, releaseStack, requireStack, stack } from './helpers.js';
import { ADMIN_DATABASE_URL, databaseNameFor } from './instance.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', '..', 'src', 'migrations');
const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';
/** The check migration 032 adds, by name. */
const OFF_CATALOGUE = 'streams_test_off_catalogue';

interface Inserted {
  id: string;
  topic: string;
}

/** What a row is made with, beyond a draft's columns. */
interface RowShape {
  test?: boolean;
  status?: StreamStatus;
  stageId?: string | null;
}

let database: Database;
let userId: string;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  userId = await insertUser(database.pool);
  await login();
  await registerStage();
});

after(async () => {
  await database?.close();
  await releaseStack();
});

/**
 * A stream row as the reports leave it: a live one has its start, a recorded one its recording's place and length, and
 * a published one its catalogue index and publish time. A test stream's description is empty.
 */
async function insertStream(shape: RowShape = {}): Promise<Inserted> {
  const status = shape.status ?? 'draft';
  const test = shape.test ?? false;
  const result = await database.pool.query<Inserted>(
    `INSERT INTO streams (
       user_id, topic, owner, title, description, tags, media_type, publish_key, stage_id, test, status,
       live_since, manifest_index, duration_seconds, ended_at, published_at, published_feed_index
     )
     VALUES ($1, $2, $3, $4, $5, '{}', 'video', $6, $7, $8, $9::text,
       CASE WHEN $9::text IN ('live', 'vod') THEN NOW() END,
       CASE WHEN $9::text = 'vod' THEN 4 END,
       CASE WHEN $9::text = 'vod' THEN 61 END,
       CASE WHEN $9::text = 'vod' THEN NOW() END,
       CASE WHEN $9::text = 'published' THEN NOW() END,
       CASE WHEN $9::text = 'published' THEN 3 END)
     RETURNING id, topic`,
    [
      userId,
      randomUUID(),
      OWNER,
      `itest ${test ? 'test stream' : 'stream'}, ${status}`,
      test ? '' : 'A stream of the test stream suite.',
      newPublishKey(),
      shape.stageId ?? null,
      test,
      status,
    ],
  );
  return result.rows[0]!;
}

async function insertUser(pool: pg.Pool): Promise<string> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb')
     RETURNING id`,
    [`itest-${randomUUID().slice(0, 8)}`],
  );
  return user.rows[0]!.id;
}

async function statusOf(id: string): Promise<string> {
  const row = await database.pool.query<{ status: string }>('SELECT status FROM streams WHERE id = $1', [id]);
  return row.rows[0]!.status;
}

/** Runs `work` and answers the check it broke, or null when it went through. */
async function brokenCheck(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    const failure = error as { code?: string; constraint?: string };
    assert.equal(failure.code, '23514', `a check violation, got ${String(error)}`);
    return failure.constraint ?? null;
  }
}

describe('migration 032 on a database that holds streams', () => {
  const { admin, name, target } = databaseNameFor(ADMIN_DATABASE_URL);
  let adminPool: pg.Pool;
  let directory: string;

  before(async () => {
    adminPool = new pg.Pool({ connectionString: admin, max: 1 });
    await adminPool.query(`CREATE DATABASE "${name}"`);
    directory = await mkdtemp(join(tmpdir(), 'web2-admin-migrations-'));
  });

  after(async () => {
    try {
      await adminPool?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await adminPool?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('marks every stream there as no test stream, and its check holds them all', async () => {
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    const earlier = files.filter((file) => file < '032');
    const later = files.filter((file) => file >= '032');
    assert.ok(later.includes('032_streams_test.sql'));
    for (const file of earlier) await copyFile(join(MIGRATIONS, file), join(directory, file));

    const streams: Inserted[] = [];
    const before032 = new Database(target, directory);
    try {
      await before032.migrate();
      const owner = await insertUser(before032.pool);
      // One of each status, by the columns the schema before 032 has, a published one with an image.
      for (const status of ['draft', 'publishing', 'published', 'live', 'vod'] as const) {
        const row = await before032.pool.query<Inserted>(
          `INSERT INTO streams (user_id, topic, owner, title, description, media_type, publish_key, status,
             published_at, published_feed_index, thumbnail, thumbnail_mime, thumbnail_ref, manifest_index,
             duration_seconds)
           VALUES ($1, $2, $3, $4, 'A stream from before test streams.', 'video', $5, $6::text,
             CASE WHEN $6::text = 'published' THEN NOW() END,
             CASE WHEN $6::text = 'published' THEN 7 END,
             CASE WHEN $6::text = 'published' THEN '\\x89504e47'::bytea END,
             CASE WHEN $6::text = 'published' THEN 'image/png' END,
             CASE WHEN $6::text = 'published' THEN repeat('ab', 32) END,
             CASE WHEN $6::text = 'vod' THEN 4 END,
             CASE WHEN $6::text = 'vod' THEN 61 END)
           RETURNING id, topic`,
          [owner, randomUUID(), OWNER, `itest ${status}`, newPublishKey(), status],
        );
        streams.push(row.rows[0]!);
      }
    } finally {
      await before032.close();
    }

    for (const file of later) await copyFile(join(MIGRATIONS, file), join(directory, file));
    const after032 = new Database(target, directory);
    try {
      await after032.migrate();

      const rows = await after032.pool.query<{ status: string; test: boolean; report_order: number }>(
        'SELECT status, test, report_order FROM streams ORDER BY created_at, id',
      );
      assert.equal(rows.rows.length, streams.length, 'every stream is still there');
      for (const row of rows.rows) {
        assert.equal(row.test, false, `the ${row.status} stream is no test stream`);
        assert.equal(row.report_order, 0);
      }
      const ledger = await after032.pool.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
      assert.deepEqual(
        ledger.rows.map((row) => row.name),
        files,
      );
      const check = await after032.pool.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [OFF_CATALOGUE]);
      assert.equal(check.rowCount, 1, 'the check is in force');

      // The published stream cannot be marked a test: it is on the catalogue.
      const published = streams[2]!;
      assert.equal(
        await brokenCheck(after032.pool.query('UPDATE streams SET test = true WHERE id = $1', [published.id])),
        OFF_CATALOGUE,
      );
    } finally {
      await after032.close();
    }
  });
});

describe('a test stream in the database', () => {
  it('is refused while it is published or being published, or holds a catalogue index, a publish time or an image', async () => {
    const { id } = await insertStream({ test: true });
    const set = (assignment: string) =>
      brokenCheck(database.pool.query(`UPDATE streams SET ${assignment} WHERE id = $1`, [id]));

    assert.equal(await set("status = 'published'"), OFF_CATALOGUE);
    assert.equal(await set("status = 'publishing'"), OFF_CATALOGUE);
    assert.equal(await set('published_feed_index = 0'), OFF_CATALOGUE);
    assert.equal(await set('published_at = NOW()'), OFF_CATALOGUE);
    assert.equal(await set("thumbnail = '\\x89504e47'::bytea, thumbnail_mime = 'image/png'"), OFF_CATALOGUE);
    assert.equal(await set("thumbnail_ref = repeat('cd', 32)"), OFF_CATALOGUE);

    assert.equal(await set("status = 'live', live_since = NOW()"), null, 'live');
    assert.equal(await set("status = 'vod', manifest_index = 2, duration_seconds = 30, ended_at = NOW()"), null);
    assert.equal(await set("status = 'draft'"), null, 'a draft again, holding its recording');
  });

  it('is left out of the rows on the feed, whatever its status', async () => {
    const streams = new StreamRepository(database.pool);
    const listed = [
      await insertStream({ status: 'published' }),
      await insertStream({ status: 'live' }),
      await insertStream({ status: 'vod' }),
    ];
    await insertStream({ status: 'draft' });
    const tests = [
      await insertStream({ test: true, status: 'draft' }),
      await insertStream({ test: true, status: 'live' }),
      await insertStream({ test: true, status: 'vod' }),
    ];

    const onFeed = new Set((await streams.listOnFeed()).map((row) => row.id));

    for (const row of listed) assert.ok(onFeed.has(row.id), 'a published, live or recorded stream is on the feed');
    for (const row of tests) assert.equal(onFeed.has(row.id), false, 'a test stream never is');
  });
});

describe('the API and a test stream', () => {
  function assertRefused(
    response: { status: number; body: unknown },
    id: string,
    action: TestStreamRefusal['action'],
  ): void {
    assert.equal(response.status, 409, JSON.stringify(response.body));
    const expected: TestStreamRefusal = { error: TEST_STREAM_ERROR, id, action, message: TEST_STREAM_REFUSALS[action] };
    assert.deepEqual(response.body, expected);
  }

  it('refuses a publish and an unpublish with test_stream, and leaves the stream as it was', async () => {
    for (const status of ['draft', 'live', 'vod'] as const) {
      const { id } = await insertStream({ test: true, status, stageId: STAGE_ID });

      assertRefused(await raw('POST', `/api/streams/${id}/publish`), id, 'publish');
      assertRefused(await raw('POST', `/api/streams/${id}/unpublish`), id, 'publish');
      assert.equal(await statusOf(id), status);
    }
  });

  it('writes no entry for a live or a recorded test stream in a reconcile', async () => {
    const live = await insertStream({ test: true, status: 'live', stageId: STAGE_ID });
    const recorded = await insertStream({ test: true, status: 'vod', stageId: STAGE_ID });

    const outcome = await api<FeedReconcileResult>('POST', '/api/feed/reconcile');

    assert.equal(outcome.added.includes(live.topic), false, 'the live test stream is not added');
    assert.equal(outcome.added.includes(recorded.topic), false, 'nor the recorded one');
    const written = await database.pool.query<{ payload: { topic?: string }[] }>('SELECT payload FROM feed_writes');
    const topics = new Set(written.rows.flatMap((row) => row.payload.map((entry) => entry.topic)));
    assert.equal(topics.has(live.topic), false, 'no write names the live test stream');
    assert.equal(topics.has(recorded.topic), false, 'nor the recorded one');
    assert.equal(await statusOf(live.id), 'live');
    assert.equal(await statusOf(recorded.id), 'vod');
  });
});
