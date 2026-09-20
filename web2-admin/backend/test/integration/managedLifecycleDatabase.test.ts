import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { StreamRenditionRepository } from '../../src/domain/StreamRenditionRepository.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';

const { Pool } = pg;
const OWNER = 'fixture-owner';

let adminPool: pg.Pool;
let database: Database;
let streams: StreamRepository;
let renditions: StreamRenditionRepository;
let schema: string;
let isolatedDatabaseUrl: string;
let userId: string;

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');

  schema = `managed_lifecycle_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);

  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  isolatedDatabaseUrl = isolatedUrl.toString();
  database = new Database(isolatedDatabaseUrl);
  await database.migrate();
  streams = new StreamRepository(database.pool);
  renditions = new StreamRenditionRepository(database.pool);

  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ('managed-lifecycle-test', 'scrypt$16384$8$1$aaaa$bbbb')
     RETURNING id`,
  );
  userId = user.rows[0]!.id;
});

after(async () => {
  if (database) await database.close();
  if (adminPool && schema) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

async function recordedLadder(): Promise<string> {
  const row = await streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: OWNER,
    title: 'managed recording',
    description: 'a completed recording protected from legacy SQL',
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

describe('managed closed recording protection', () => {
  it('refuses pre-feature markLive SQL and preserves every completed reference', async () => {
    const id = await recordedLadder();
    const claimId = randomUUID();
    const masterReference = 'a'.repeat(64);
    const checkpointReference = randomUUID();

    await database.pool.query(
      `UPDATE streams
          SET lifecycle_version = 1,
              lifecycle_revision = 4,
              current_run_number = 1,
              completed_run_number = NULL
        WHERE id = $1`,
      [id],
    );
    await database.pool.query(
      `INSERT INTO stream_runs (
         stream_id, run_number, state, permission, assigned_uploader_id,
         claim_id, revision, last_event_sequence, last_event_digest,
         last_observed_at, close_reason
       ) VALUES ($1, 1, 'closed', 'closed', 'itest-uploader', $2, 4, 3, 'closed-3', NOW(), 'reconnect_timeout')`,
      [id, claimId],
    );
    await database.pool.query(
      `INSERT INTO stream_run_recordings (
         stream_id, run_number, checkpoint_reference, master_topic,
         master_index, master_reference, duration_seconds
       )
       SELECT id, 1, $2, topic, manifest_index, $3, duration_seconds
         FROM streams WHERE id = $1`,
      [id, checkpointReference, masterReference],
    );
    await database.pool.query(
      `INSERT INTO stream_run_expected_renditions (
         stream_id, run_number, name, topic, width, height, bandwidth,
         avg_bandwidth
       )
       SELECT stream_id, 1, name, topic, width, height, bandwidth, avg_bandwidth
         FROM stream_renditions WHERE stream_id = $1`,
      [id],
    );
    await database.pool.query(
      `INSERT INTO stream_run_recording_renditions (
         stream_id, run_number, name, topic, manifest_index, reference,
         duration_seconds, width, height, bandwidth, avg_bandwidth
       )
       SELECT stream_id, 1, name, topic, manifest_index,
              CASE name
                WHEN '360p' THEN repeat('c', 64)
                ELSE repeat('d', 64)
              END,
              duration_seconds, width, height, bandwidth, avg_bandwidth
         FROM stream_renditions WHERE stream_id = $1`,
      [id],
    );
    await database.pool.query(
      `UPDATE stream_runs
          SET state = 'vod', revision = 5, last_event_sequence = 4,
              last_event_digest = 'vod-4', last_observed_at = NOW()
        WHERE stream_id = $1 AND run_number = 1`,
      [id],
    );
    await database.pool.query(
      `UPDATE streams
          SET lifecycle_revision = 5, completed_run_number = 1
        WHERE id = $1`,
      [id],
    );

    await assert.rejects(
      streams.markLive(id, ['published', 'live', 'vod']),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'managed_closed_stream_guard');
        return true;
      },
    );

    const stream = await streams.findById(id, userId);
    assert.equal(stream?.status, 'vod');
    assert.equal(Number(stream?.manifest_index), 7);
    assert.equal(Number(stream?.duration_seconds), 62.5);

    const storedRungs = await renditions.listByStream(id);
    assert.equal(Number(storedRungs.find((r) => r.name === '360p')?.manifest_index), 10);
    assert.equal(Number(storedRungs.find((r) => r.name === '720p')?.manifest_index), 12);

    const retained = await database.pool.query<{
      checkpoint_reference: string;
      master_reference: string;
      rung_count: number;
      max_width: number;
    }>(
      `SELECT recording.checkpoint_reference,
              recording.master_reference,
              COUNT(rungs.name)::int AS rung_count,
              MAX(rungs.width)::int AS max_width
         FROM stream_run_recordings recording
         JOIN stream_run_recording_renditions rungs
           USING (stream_id, run_number)
        WHERE recording.stream_id = $1 AND recording.run_number = 1
        GROUP BY recording.checkpoint_reference, recording.master_reference`,
      [id],
    );
    assert.deepEqual(retained.rows, [
      {
        checkpoint_reference: checkpointReference,
        master_reference: masterReference,
        rung_count: 2,
        max_width: 1280,
      },
    ]);
  });

  it('keeps VOD-to-Live behavior for a legacy stream', async () => {
    const id = await recordedLadder();

    const live = await streams.markLive(id, ['published', 'live', 'vod']);

    assert.equal(live?.status, 'live');
    assert.equal(live?.manifest_index, null);
  });
});

describe('managed run database invariants', () => {
  it('refuses conflicting, stale and late events without changing the claim', async () => {
    const row = await streams.insert({
      user_id: userId,
      topic: randomUUID(),
      owner: OWNER,
      title: 'managed event ordering',
      description: 'one claimed run with ordered reports',
      tags: [],
      media_type: 'video',
      scheduled_start_time: null,
      publish_key: newPublishKey(),
    });
    const claimId = randomUUID();
    await database.pool.query(
      `UPDATE streams
          SET lifecycle_version = 1,
              lifecycle_revision = 1,
              current_run_number = 1
        WHERE id = $1`,
      [row.id],
    );
    await database.pool.query(
      `INSERT INTO stream_runs (
         stream_id, run_number, state, permission, assigned_uploader_id,
         claim_id, revision
       ) VALUES ($1, 1, 'claimed', 'claimed', 'itest-uploader', $2, 1)`,
      [row.id, claimId],
    );
    await database.pool.query(
      `UPDATE stream_runs
          SET state = 'live', revision = 2, last_event_sequence = 1,
              last_event_digest = 'live-1', last_observed_at = NOW()
        WHERE stream_id = $1 AND run_number = 1`,
      [row.id],
    );

    await database.pool.query(
      `UPDATE stream_runs
          SET last_event_sequence = 1, last_event_digest = 'live-1'
        WHERE stream_id = $1 AND run_number = 1`,
      [row.id],
    );
    await assert.rejects(
      database.pool.query(
        `UPDATE stream_runs
            SET last_event_sequence = 1, last_event_digest = 'different-live-1'
          WHERE stream_id = $1 AND run_number = 1`,
        [row.id],
      ),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'managed_run_event_order');
        return true;
      },
    );
    await assert.rejects(
      database.pool.query(
        `UPDATE stream_runs
            SET last_event_sequence = 0, last_event_digest = 'stale'
          WHERE stream_id = $1 AND run_number = 1`,
        [row.id],
      ),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'managed_run_event_order');
        return true;
      },
    );

    await database.pool.query(
      `UPDATE stream_runs
          SET state = 'closed', permission = 'closed', revision = 3,
              last_event_sequence = 2, last_event_digest = 'closed-2',
              last_observed_at = NOW(), close_reason = 'reconnect_timeout'
        WHERE stream_id = $1 AND run_number = 1`,
      [row.id],
    );
    await assert.rejects(
      database.pool.query(
        `UPDATE stream_runs
            SET state = 'waiting', revision = 4, last_event_sequence = 3,
                last_event_digest = 'waiting-3', last_observed_at = NOW(),
                reconnect_deadline = NOW() + INTERVAL '60 seconds'
          WHERE stream_id = $1 AND run_number = 1`,
        [row.id],
      ),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'managed_run_state_transition');
        return true;
      },
    );
    await assert.rejects(
      database.pool.query(
        `UPDATE stream_runs
            SET assigned_uploader_id = 'another-uploader'
          WHERE stream_id = $1 AND run_number = 1`,
        [row.id],
      ),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'managed_run_claim_identity');
        return true;
      },
    );

    const unchanged = await database.pool.query<{
      state: string;
      permission: string;
      assigned_uploader_id: string;
      claim_id: string;
      last_event_sequence: number;
    }>(
      `SELECT state, permission, assigned_uploader_id, claim_id,
              last_event_sequence
         FROM stream_runs WHERE stream_id = $1 AND run_number = 1`,
      [row.id],
    );
    assert.deepEqual(unchanged.rows, [
      {
        state: 'closed',
        permission: 'closed',
        assigned_uploader_id: 'itest-uploader',
        claim_id: claimId,
        last_event_sequence: 2,
      },
    ]);
  });
});

describe('managed lifecycle schema compatibility', () => {
  it('refuses a database lifecycle version newer than this binary supports', async () => {
    await database.pool.query(
      `UPDATE schema_compatibility
          SET version = 2
        WHERE component = 'managed_stream_lifecycle'`,
    );
    const olderBinary = new Database(isolatedDatabaseUrl);

    try {
      await assert.rejects(
        olderBinary.migrate(),
        /managed_stream_lifecycle schema version 2 is newer than supported version 1/,
      );
    } finally {
      await olderBinary.close();
      await database.pool.query(
        `UPDATE schema_compatibility
            SET version = 1
          WHERE component = 'managed_stream_lifecycle'`,
      );
    }
  });
});
