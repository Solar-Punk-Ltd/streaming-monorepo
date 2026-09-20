import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';

import { ContinuationRepository } from '../../src/domain/ContinuationRepository.js';
import { Database } from '../../src/domain/Database.js';
import { ManagedLifecycleRepository } from '../../src/domain/ManagedLifecycleRepository.js';
import { ManagedLifecycleConflict } from '../../src/domain/managedLifecycle.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';

const { Pool } = pg;
const UPLOADER_ID = 'srs-157-90-34-105';

let adminPool: pg.Pool;
let database: Database;
let continuations: ContinuationRepository;
let lifecycle: ManagedLifecycleRepository;
let streams: StreamRepository;
let schema: string;
let ownerId: string;
let otherOwnerId: string;

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');

  schema = `continuations_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  database = new Database(isolatedUrl.toString());
  await database.migrate();
  continuations = new ContinuationRepository(database.pool);
  lifecycle = new ManagedLifecycleRepository(database.pool);
  streams = new StreamRepository(database.pool);

  const users = await database.pool.query<{ id: string; username: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ('continuation-owner', 'hash'), ('continuation-other', 'hash')
     RETURNING id, username`,
  );
  ownerId = users.rows.find(({ username }) => username === 'continuation-owner')!.id;
  otherOwnerId = users.rows.find(
    ({ username }) => username === 'continuation-other',
  )!.id;
});

after(async () => {
  if (database) await database.close();
  if (adminPool && schema) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

async function completedManagedStream(): Promise<{
  streamId: string;
  checkpointReference: string;
}> {
  const stream = await streams.insert({
    user_id: ownerId,
    topic: randomUUID(),
    owner: 'fixture-owner',
    title: 'continued stream',
    description: 'completed stream ready for another run',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
  });
  const checkpointReference = randomUUID();
  await database.pool.query(
    `UPDATE streams
        SET lifecycle_version = 1, lifecycle_revision = 5,
            current_run_number = 1
      WHERE id = $1`,
    [stream.id],
  );
  await database.pool.query(
    `INSERT INTO stream_runs (
       stream_id, run_number, state, permission, assigned_uploader_id,
       claim_id, claim_request_id, claim_request_digest, revision,
       last_event_sequence, last_event_digest, last_observed_at,
       last_received_at, close_reason
     ) VALUES ($1, 1, 'closed', 'closed', $2, $3, $4, 'claim-digest', 4,
               1, 'closed-digest', NOW(), NOW(), 'reconnect_timeout')`,
    [stream.id, UPLOADER_ID, randomUUID(), randomUUID()],
  );
  await database.pool.query(
    `INSERT INTO stream_run_recordings (
       stream_id, run_number, checkpoint_reference, master_topic,
       master_index, master_reference, duration_seconds
     ) VALUES ($1, 1, $2, $3, 12, repeat('a', 64), 45)`,
    [stream.id, checkpointReference, stream.topic],
  );
  await database.pool.query(
    `UPDATE stream_runs
        SET state = 'vod', revision = 5, last_event_sequence = 2,
            last_event_digest = 'vod-digest', last_observed_at = NOW(),
            last_received_at = NOW()
      WHERE stream_id = $1 AND run_number = 1`,
    [stream.id],
  );
  await database.pool.query(
    `UPDATE streams
        SET status = 'vod', completed_run_number = 1,
            manifest_index = 12, duration_seconds = 45
      WHERE id = $1`,
    [stream.id],
  );
  return { streamId: stream.id, checkpointReference };
}

describe('continuation operations', () => {
  it('allocates once, scopes the owner and opens only after preparation', async () => {
    const { streamId, checkpointReference } = await completedManagedStream();
    const requestId = randomUUID();
    const operation = await continuations.create(streamId, ownerId, {
      requestId,
      expectedRevision: 5,
    });

    assert.equal(operation.status, 'pending');
    assert.equal(operation.previousRunNumber, 1);
    assert.equal(operation.nextRunNumber, 2);
    assert.equal(operation.revision, 6);
    assert.equal(operation.retainedRecording?.checkpointReference, checkpointReference);
    assert.equal(
      (await continuations.create(streamId, ownerId, {
        requestId,
        expectedRevision: 5,
      })).operationId,
      operation.operationId,
    );
    await assert.rejects(
      continuations.create(streamId, ownerId, {
        requestId: randomUUID(),
        expectedRevision: 6,
      }),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict &&
        error.code === 'revision_conflict',
    );
    await assert.rejects(
      continuations.get(streamId, operation.operationId, otherOwnerId),
    );

    const pending = await continuations.listPending(UPLOADER_ID);
    assert.deepEqual(pending.map((item) => item.operationId), [
      operation.operationId,
    ]);
    const preparedCheckpoint = randomUUID();
    const ready = await continuations.prepare(streamId, operation.operationId, {
      lifecycleVersion: 1,
      uploaderId: UPLOADER_ID,
      expectedRevision: 6,
      status: 'ready',
      checkpointReference: preparedCheckpoint,
    });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.revision, 7);
    assert.equal(
      (await continuations.prepare(streamId, operation.operationId, {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: 6,
        status: 'ready',
        checkpointReference: preparedCheckpoint,
      })).status,
      'ready',
    );

    const stream = await database.pool.query<{
      current_run_number: number;
      lifecycle_revision: number;
    }>(
      `SELECT current_run_number, lifecycle_revision FROM streams WHERE id = $1`,
      [streamId],
    );
    assert.deepEqual(stream.rows[0], {
      current_run_number: 2,
      lifecycle_revision: 7,
    });

    const claimed = await lifecycle.claim(streamId, 2, {
      lifecycleVersion: 1,
      uploaderId: UPLOADER_ID,
      expectedRevision: 7,
      requestId: randomUUID(),
    });
    assert.equal(claimed.permission, 'claimed');
    assert.equal(
      (await continuations.get(streamId, operation.operationId, ownerId)).status,
      'claimed',
    );
    await assert.rejects(
      continuations.cancel(streamId, operation.operationId, ownerId),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'closed',
    );
  });

  it('cancels an unclaimed ready run and never lets preparation reopen it', async () => {
    const { streamId } = await completedManagedStream();
    const operation = await continuations.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: 5,
    });
    const preparation = {
      lifecycleVersion: 1 as const,
      uploaderId: UPLOADER_ID,
      expectedRevision: 6,
      status: 'ready' as const,
      checkpointReference: randomUUID(),
    };
    await continuations.prepare(streamId, operation.operationId, preparation);

    const cancelled = await continuations.cancel(
      streamId,
      operation.operationId,
      ownerId,
    );
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(
      (await continuations.cancel(streamId, operation.operationId, ownerId)).status,
      'cancelled',
    );
    await assert.rejects(
      continuations.prepare(streamId, operation.operationId, preparation),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'closed',
    );
    await assert.rejects(
      lifecycle.claim(streamId, 2, {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: cancelled.revision,
        requestId: randomUUID(),
      }),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'closed',
    );
  });

  it('allocates a new run after a pending continuation is cancelled', async () => {
    const { streamId, checkpointReference } = await completedManagedStream();
    const firstRequestId = randomUUID();
    const first = await continuations.create(streamId, ownerId, {
      requestId: firstRequestId,
      expectedRevision: 5,
    });
    const cancelled = await continuations.cancel(
      streamId,
      first.operationId,
      ownerId,
    );

    assert.equal(
      (await continuations.create(streamId, ownerId, {
        requestId: firstRequestId,
        expectedRevision: 5,
      })).status,
      'cancelled',
      'the same request reconciles its terminal operation',
    );
    const replacement = await continuations.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: cancelled.revision,
    });
    assert.equal(replacement.previousRunNumber, 1);
    assert.equal(replacement.nextRunNumber, 3, 'run 2 is never reused');
    assert.equal(
      replacement.retainedRecording?.checkpointReference,
      checkpointReference,
    );
  });

  it('allocates a new run after preparation fails', async () => {
    const { streamId } = await completedManagedStream();
    const first = await continuations.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: 5,
    });
    const failed = await continuations.prepare(streamId, first.operationId, {
      lifecycleVersion: 1,
      uploaderId: UPLOADER_ID,
      expectedRevision: first.revision,
      status: 'failed',
      failure: 'checkpoint unavailable',
    });

    const replacement = await continuations.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: failed.revision,
    });
    assert.equal(replacement.previousRunNumber, 1);
    assert.equal(replacement.nextRunNumber, 3, 'failed run 2 is never reused');
  });

  it('records a ready cancellation as empty and continues from a fresh run', async () => {
    const { streamId, checkpointReference } = await completedManagedStream();
    const first = await continuations.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: 5,
    });
    const preparedCheckpoint = randomUUID();
    await continuations.prepare(streamId, first.operationId, {
      lifecycleVersion: 1,
      uploaderId: UPLOADER_ID,
      expectedRevision: first.revision,
      status: 'ready',
      checkpointReference: preparedCheckpoint,
    });
    const cancelled = await continuations.cancel(
      streamId,
      first.operationId,
      ownerId,
    );

    const closedRun = await database.pool.query<{
      close_reason: string;
      empty_checkpoint_reference: string;
      accepted_media_count: number;
    }>(
      `SELECT close_reason, empty_checkpoint_reference, accepted_media_count
         FROM stream_runs WHERE stream_id = $1 AND run_number = 2`,
      [streamId],
    );
    assert.deepEqual(closedRun.rows[0], {
      close_reason: 'empty',
      empty_checkpoint_reference: preparedCheckpoint,
      accepted_media_count: 0,
    });

    const replacement = await continuations.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: cancelled.revision,
    });
    assert.equal(replacement.previousRunNumber, 2);
    assert.equal(replacement.nextRunNumber, 3);
    assert.deepEqual(replacement.previousEmptyOutcome, {
      runNumber: 2,
      checkpointReference: preparedCheckpoint,
      acceptedMediaCount: 0,
    });
    assert.equal(
      replacement.retainedRecording?.checkpointReference,
      checkpointReference,
      'the previous completed replay remains retained',
    );
    const ownerState = await streams.managedOwnerState(streamId);
    assert.deepEqual(ownerState?.lifecycle, {
      version: 1,
      revision: replacement.revision,
      runNumber: 2,
      state: 'closed',
      permission: 'closed',
    });
    assert.equal(ownerState?.completedRecording?.runNumber, 1);
  });
});
