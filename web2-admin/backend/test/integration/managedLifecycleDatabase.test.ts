import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { ManagedLifecycleRepository } from '../../src/domain/ManagedLifecycleRepository.js';
import { ManagedLifecycleConflict } from '../../src/domain/managedLifecycle.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { StreamRenditionRepository } from '../../src/domain/StreamRenditionRepository.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';

const { Pool } = pg;
const OWNER = 'fixture-owner';

let adminPool: pg.Pool;
let database: Database;
let streams: StreamRepository;
let renditions: StreamRenditionRepository;
let lifecycle: ManagedLifecycleRepository;
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
  lifecycle = new ManagedLifecycleRepository(database.pool);

  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ('managed-lifecycle-test', 'scrypt$16384$8$1$aaaa$bbbb')
     RETURNING id`,
  );
  userId = user.rows[0].id;
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
         claim_id, claim_request_id, claim_request_digest, revision,
         last_event_sequence, last_event_digest,
         last_observed_at, close_reason
       ) VALUES ($1, 1, 'closed', 'closed', 'itest-uploader', $2, $3,
                 'claim-digest', 4, 3, 'closed-3', NOW(), 'reconnect_timeout')`,
      [id, claimId, randomUUID()],
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

    await database.pool.query(
      `INSERT INTO stream_runs (
         stream_id, run_number, state, permission, assigned_uploader_id,
         revision
       ) VALUES ($1, 2, 'ready', 'open', 'itest-uploader', 6)`,
      [id],
    );
    await database.pool.query(
      `UPDATE streams
          SET lifecycle_revision = 6, current_run_number = 2
        WHERE id = $1`,
      [id],
    );

    const recovered = await lifecycle.readClaimedRun(
      id,
      1,
      'itest-uploader',
      claimId,
    );
    assert.deepEqual(recovered.lastAcceptedEvent, {
      sequence: 4,
      digest: 'vod-4',
    });
    assert.equal(recovered.completedRecording?.checkpointReference, checkpointReference);
    assert.equal(recovered.completedRecording?.master.reference, masterReference);
    assert.deepEqual(recovered.completedRecording?.expectedRenditions, [
      '360p',
      '720p',
    ]);
    assert.deepEqual(
      recovered.completedRecording?.renditions.map((rendition) => ({
        name: rendition.name,
        reference: rendition.reference,
        width: rendition.width,
        bandwidth: rendition.bandwidth,
      })),
      [
        {
          name: '360p',
          reference: 'c'.repeat(64),
          width: 640,
          bandwidth: 800_000,
        },
        {
          name: '720p',
          reference: 'd'.repeat(64),
          width: 1280,
          bandwidth: 2_800_000,
        },
      ],
    );

    const catalogueState = await streams.managedCatalogueState(id);
    assert.deepEqual(catalogueState?.lifecycle, {
      version: 1,
      revision: 6,
      runNumber: 2,
      state: 'ready',
    });
    assert.equal(catalogueState?.completedRecording?.runNumber, 1);
    assert.equal(
      catalogueState?.completedRecording?.master.reference,
      masterReference,
    );
    assert.deepEqual(
      catalogueState?.completedRecording?.expectedRenditions,
      ['360p', '720p'],
    );
    assert.ok(
      !('checkpointReference' in (catalogueState?.completedRecording ?? {})),
      'the public catalogue projection excludes the private checkpoint',
    );
    await assert.rejects(
      lifecycle.report(id, 1, {
        lifecycleVersion: 1,
        runNumber: 1,
        uploaderId: 'itest-uploader',
        claimId,
        eventSequence: 5,
        observedAt: '2026-09-20T10:20:00.000Z',
        state: 'closed',
        reason: 'recovery_required',
      }),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'stale_run',
    );

    await assert.rejects(
      database.pool.query(
        `UPDATE streams SET completed_run_number = NULL WHERE id = $1`,
        [id],
      ),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'managed_stream_lifecycle_order');
        return true;
      },
    );
  });

  it('keeps VOD-to-Live behavior for a legacy stream', async () => {
    const id = await recordedLadder();

    const live = await streams.markLive(id, ['published', 'live', 'vod']);

    assert.equal(live?.status, 'live');
    assert.equal(live?.manifest_index, null);
  });
});

describe('managed run database invariants', () => {
  it('presents reconnect time and continuation eligibility from server state', async () => {
    const row = await streams.insert({
      user_id: userId,
      topic: randomUUID(),
      owner: OWNER,
      title: 'owner lifecycle projection',
      description: 'server-relative reconnect and close status',
      tags: [],
      media_type: 'video',
      scheduled_start_time: null,
      publish_key: newPublishKey(),
    });
    const claimId = randomUUID();
    await database.pool.query(
      `UPDATE streams SET lifecycle_version = 1, lifecycle_revision = 2,
                          current_run_number = 1 WHERE id = $1`,
      [row.id],
    );
    await database.pool.query(
      `INSERT INTO stream_runs (
         stream_id, run_number, state, permission, assigned_uploader_id,
         claim_id, claim_request_id, claim_request_digest, revision,
         last_event_sequence, last_event_digest, last_observed_at,
         last_received_at, reconnect_deadline
       ) VALUES ($1, 1, 'waiting', 'claimed', 'itest-uploader', $2, $3,
                 'claim-digest', 2, 1, 'waiting-digest',
                 clock_timestamp() + interval '1 hour', clock_timestamp(),
                 clock_timestamp() + interval '1 hour 40 seconds')`,
      [row.id, claimId, randomUUID()],
    );

    const waiting = await streams.managedOwnerState(row.id);
    assert.equal(waiting?.lifecycle.state, 'waiting');
    assert.equal(waiting?.lifecycle.canContinue, false);
    assert.ok(
      (waiting?.lifecycle.reconnectRemainingMs ?? 0) > 35_000,
      'remaining time preserves the uploader-reported interval across clock skew',
    );
    assert.ok((waiting?.lifecycle.reconnectRemainingMs ?? 0) <= 40_000);

    await database.pool.query(
      `UPDATE stream_runs
          SET state = 'closed', permission = 'closed', revision = 3,
              reconnect_deadline = NULL, close_reason = 'recovery_required'
        WHERE stream_id = $1 AND run_number = 1`,
      [row.id],
    );
    await database.pool.query(
      `UPDATE streams SET lifecycle_revision = 3 WHERE id = $1`,
      [row.id],
    );

    assert.deepEqual((await streams.managedOwnerState(row.id))?.lifecycle, {
      version: 1,
      revision: 3,
      runNumber: 1,
      state: 'closed',
      permission: 'closed',
      closeReason: 'recovery_required',
      canContinue: false,
    });
  });

  it('returns the current claim on an exact retry and refuses it after closure', async () => {
    const row = await streams.insert({
      user_id: userId,
      topic: randomUUID(),
      owner: OWNER,
      title: 'claim retry',
      description: 'claim response recovery',
      tags: [],
      media_type: 'video',
      scheduled_start_time: null,
      publish_key: newPublishKey(),
    });
    await database.pool.query(
      `UPDATE streams SET lifecycle_version = 1, lifecycle_revision = 1,
                          current_run_number = 1 WHERE id = $1`,
      [row.id],
    );
    await database.pool.query(
      `INSERT INTO stream_runs (
         stream_id, run_number, state, permission, assigned_uploader_id,
         revision
       ) VALUES ($1, 1, 'ready', 'open', 'itest-uploader', 1)`,
      [row.id],
    );
    const expectedRenditions = [
      {
        name: '360p',
        topic: randomUUID(),
        width: 640,
        height: 360,
        bandwidth: 800_000,
        avgBandwidth: 700_000,
      },
      {
        name: '720p',
        topic: randomUUID(),
        width: 1280,
        height: 720,
        bandwidth: 2_800_000,
        avgBandwidth: 2_500_000,
      },
    ];
    for (const rendition of [...expectedRenditions].reverse()) {
      await database.pool.query(
        `INSERT INTO stream_run_expected_renditions (
           stream_id, run_number, name, topic, width, height, bandwidth,
           avg_bandwidth
         ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          rendition.name,
          rendition.topic,
          rendition.width,
          rendition.height,
          rendition.bandwidth,
          rendition.avgBandwidth,
        ],
      );
    }
    await assert.rejects(
      database.pool.query(
        `INSERT INTO stream_run_expected_renditions (
           stream_id, run_number, name, topic, width, height, bandwidth,
           avg_bandwidth
         ) VALUES ($1, 1, 'duplicate-topic', $2, 1920, 1080, 5000000, 4500000)`,
        [row.id, expectedRenditions[0].topic],
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505',
    );
    const request = {
      lifecycleVersion: 1 as const,
      expectedRevision: 1,
      uploaderId: 'itest-uploader',
      requestId: randomUUID(),
    };

    const claimed = await lifecycle.claim(row.id, 1, request);
    const retried = await lifecycle.claim(row.id, 1, request);
    assert.equal(claimed.claimId, retried.claimId);
    assert.equal(retried.permission, 'claimed');
    assert.deepEqual(claimed.expectedRenditions, expectedRenditions);
    assert.deepEqual(retried.expectedRenditions, expectedRenditions);

    const observedAt = '2026-09-20T10:00:00.000Z';
    const live = {
      lifecycleVersion: 1 as const,
      runNumber: 1,
      uploaderId: request.uploaderId,
      claimId: claimed.claimId!,
      eventSequence: 1,
      observedAt,
      state: 'live' as const,
    };
    assert.equal((await lifecycle.report(row.id, 1, live)).state, 'live');
    assert.equal((await streams.findById(row.id, userId))?.status, 'live');
    assert.equal((await lifecycle.report(row.id, 1, live)).revision, 3);
    await lifecycle.report(row.id, 1, {
      ...live,
      eventSequence: 2,
      state: 'waiting',
      reconnectDeadline: '2026-09-20T10:01:00.000Z',
    });
    await lifecycle.report(row.id, 1, {
      ...live,
      eventSequence: 3,
      state: 'closed',
      reason: 'empty',
      emptyOutcome: {
        checkpointReference: randomUUID(),
        acceptedMediaCount: 0,
      },
    });
    await assert.rejects(
      lifecycle.claim(row.id, 1, request),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'closed',
    );
    const recovered = await lifecycle.readClaimedRun(
      row.id,
      1,
      request.uploaderId,
      claimed.claimId!,
    );
    assert.equal(recovered.state, 'closed');
    assert.equal(recovered.permission, 'closed');
    assert.deepEqual(recovered.expectedRenditions, expectedRenditions);
  });

  it('retains the winning claim request and requires proof for an empty close', async () => {
    const row = await streams.insert({
      user_id: userId,
      topic: randomUUID(),
      owner: OWNER,
      title: 'claim identity',
      description: 'durable claim and empty outcome',
      tags: [],
      media_type: 'video',
      scheduled_start_time: null,
      publish_key: newPublishKey(),
    });
    const claimId = randomUUID();
    const requestId = randomUUID();
    const checkpointReference = randomUUID();
    await database.pool.query(
      `UPDATE streams
          SET lifecycle_version = 1, lifecycle_revision = 1,
              current_run_number = 1
        WHERE id = $1`,
      [row.id],
    );
    await database.pool.query(
      `INSERT INTO stream_runs (
         stream_id, run_number, state, permission, assigned_uploader_id,
         revision
       ) VALUES ($1, 1, 'ready', 'open', 'itest-uploader', 1)`,
      [row.id],
    );
    await database.pool.query(
      `UPDATE stream_runs
          SET state = 'claimed', permission = 'claimed', claim_id = $2,
              claim_request_id = $3, claim_request_digest = 'request-a',
              revision = 2
        WHERE stream_id = $1 AND run_number = 1`,
      [row.id, claimId, requestId],
    );

    await assert.rejects(
      database.pool.query(
        `UPDATE stream_runs SET claim_request_id = $2
          WHERE stream_id = $1 AND run_number = 1`,
        [row.id, randomUUID()],
      ),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'managed_run_claim_identity');
        return true;
      },
    );
    await assert.rejects(
      database.pool.query(
        `UPDATE stream_runs
            SET state = 'closed', permission = 'closed',
                close_reason = 'empty', revision = 3
          WHERE stream_id = $1 AND run_number = 1`,
        [row.id],
      ),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'stream_runs_empty_outcome');
        return true;
      },
    );
    await database.pool.query(
      `UPDATE stream_runs
          SET state = 'closed', permission = 'closed', close_reason = 'empty',
              empty_checkpoint_reference = $2, accepted_media_count = 0,
              revision = 3
        WHERE stream_id = $1 AND run_number = 1`,
      [row.id, checkpointReference],
    );
    const stored = await database.pool.query<{
      request_id: string;
      checkpoint_reference: string;
      accepted_media_count: string;
    }>(
      `SELECT claim_request_id AS request_id,
              empty_checkpoint_reference AS checkpoint_reference,
              accepted_media_count
         FROM stream_runs WHERE stream_id = $1 AND run_number = 1`,
      [row.id],
    );
    assert.deepEqual(stored.rows, [{
      request_id: requestId,
      checkpoint_reference: checkpointReference,
      accepted_media_count: 0,
    }]);
  });

  it('requires every managed stream to identify its current run', async () => {
    const row = await streams.insert({
      user_id: userId,
      topic: randomUUID(),
      owner: OWNER,
      title: 'missing current run',
      description: 'invalid managed identity',
      tags: [],
      media_type: 'video',
      scheduled_start_time: null,
      publish_key: newPublishKey(),
    });

    await assert.rejects(
      database.pool.query(
        `UPDATE streams
            SET lifecycle_version = 1, lifecycle_revision = 1,
                current_run_number = NULL
          WHERE id = $1`,
        [row.id],
      ),
      (error: NodeJS.ErrnoException & { constraint?: string }) => {
        assert.equal(error.code, '23514');
        assert.equal(error.constraint, 'streams_lifecycle_shape');
        return true;
      },
    );
  });

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
         claim_id, claim_request_id, claim_request_digest, revision
       ) VALUES ($1, 1, 'claimed', 'claimed', 'itest-uploader', $2, $3,
                 'claim-digest', 1)`,
      [row.id, claimId, randomUUID()],
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
  it('installs durable continuation operation storage', async () => {
    const result = await database.pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('continuation_operations')::text AS table_name`,
    );
    assert.equal(result.rows[0].table_name, 'continuation_operations');
  });

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
