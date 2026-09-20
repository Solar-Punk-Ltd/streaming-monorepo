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
const CONTINUATION_STREAM_LOCK = 'continuation_lock_owned_stream';
const MANAGED_RUN_LOCK = 'FOR UPDATE OF stream, run';
const OPERATION_LOCK = 'FOR UPDATE OF stream, operation';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface QueryGate {
  pool: pg.Pool;
  started: Promise<void>;
  locked: Promise<void>;
  release(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function queryGate(
  pool: pg.Pool,
  marker: string,
  holdAfterLock: boolean,
): QueryGate {
  const started = deferred();
  const locked = deferred();
  const release = deferred();
  let intercepted = false;

  const adapted = {
    async connect(): Promise<pg.PoolClient> {
      const client = await pool.connect();
      const query = async <R extends pg.QueryResultRow = pg.QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<pg.QueryResult<R>> => {
        if (!intercepted && text.includes(marker)) {
          intercepted = true;
          started.resolve();
          const result = await client.query<R>(text, values);
          locked.resolve();
          if (holdAfterLock) await release.promise;
          return result;
        }
        return client.query<R>(text, values);
      };
      return {
        query: query as pg.PoolClient['query'],
        release: client.release.bind(client),
      } as unknown as pg.PoolClient;
    },
  } as unknown as pg.Pool;

  return {
    pool: adapted,
    started: started.promise,
    locked: locked.promise,
    release: release.resolve,
  };
}

function assertConflict(
  result: PromiseSettledResult<unknown>,
  code: ManagedLifecycleConflict['code'],
): void {
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.ok(result.reason instanceof ManagedLifecycleConflict);
    assert.equal(result.reason.code, code);
  }
}

let adminPool: pg.Pool;
let database: Database;
let continuations: ContinuationRepository;
let lifecycle: ManagedLifecycleRepository;
let streams: StreamRepository;
let schema: string;
let ownerId: string;

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');

  schema = `continuation_races_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  database = new Database(isolatedUrl.toString());
  await database.migrate();
  continuations = new ContinuationRepository(database.pool);
  lifecycle = new ManagedLifecycleRepository(database.pool);
  streams = new StreamRepository(database.pool);

  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ('continuation-race-owner', 'hash') RETURNING id`,
  );
  ownerId = user.rows[0].id;
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
    title: 'concurrent continuation',
    description: 'row-lock concurrency fixture',
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

async function readyContinuation(streamId: string): Promise<{
  operationId: string;
  runNumber: number;
  revision: number;
}> {
  const operation = await continuations.create(streamId, ownerId, {
    requestId: randomUUID(),
    expectedRevision: 5,
  });
  const ready = await continuations.prepare(streamId, operation.operationId, {
    lifecycleVersion: 1,
    uploaderId: UPLOADER_ID,
    expectedRevision: operation.revision,
    status: 'ready',
    checkpointReference: randomUUID(),
  });
  return {
    operationId: operation.operationId,
    runNumber: operation.nextRunNumber,
    revision: ready.revision,
  };
}

async function claimedContinuation(streamId: string): Promise<{
  operationId: string;
  runNumber: number;
  revision: number;
  claimId: string;
}> {
  const ready = await readyContinuation(streamId);
  const claimed = await lifecycle.claim(streamId, ready.runNumber, {
    lifecycleVersion: 1,
    uploaderId: UPLOADER_ID,
    expectedRevision: ready.revision,
    requestId: randomUUID(),
  });
  assert.ok(claimed.claimId);
  return { ...ready, revision: claimed.revision, claimId: claimed.claimId };
}

describe('continuation transaction races', () => {
  it('serializes different Continue requests and allocates one run', async () => {
    const { streamId, checkpointReference } = await completedManagedStream();
    const firstGate = queryGate(database.pool, CONTINUATION_STREAM_LOCK, true);
    const secondGate = queryGate(database.pool, CONTINUATION_STREAM_LOCK, false);
    const firstRepository = new ContinuationRepository(firstGate.pool);
    const secondRepository = new ContinuationRepository(secondGate.pool);

    const first = firstRepository.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: 5,
    });
    await firstGate.locked;
    const second = secondRepository.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: 5,
    });
    await secondGate.started;
    firstGate.release();

    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, 'fulfilled');
    assertConflict(results[1], 'revision_conflict');
    const stored = await continuations.listPending(UPLOADER_ID);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].nextRunNumber, 2);
    assert.equal(
      stored[0].retainedRecording?.checkpointReference,
      checkpointReference,
    );
  });

  it('reconciles two simultaneous retries with the same request id', async () => {
    const { streamId } = await completedManagedStream();
    const requestId = randomUUID();
    const firstGate = queryGate(database.pool, CONTINUATION_STREAM_LOCK, true);
    const secondGate = queryGate(database.pool, CONTINUATION_STREAM_LOCK, false);
    const firstRepository = new ContinuationRepository(firstGate.pool);
    const secondRepository = new ContinuationRepository(secondGate.pool);

    const request = { requestId, expectedRevision: 5 };
    const first = firstRepository.create(streamId, ownerId, request);
    await firstGate.locked;
    const second = secondRepository.create(streamId, ownerId, request);
    await secondGate.started;
    firstGate.release();

    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.operationId, right.operationId);
    assert.equal(left.nextRunNumber, 2);
  });

  it('lets cancellation follow preparation without reopening the run', async () => {
    const { streamId } = await completedManagedStream();
    const operation = await continuations.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: 5,
    });
    const prepareGate = queryGate(database.pool, OPERATION_LOCK, true);
    const cancelGate = queryGate(database.pool, CONTINUATION_STREAM_LOCK, false);
    const preparing = new ContinuationRepository(prepareGate.pool).prepare(
      streamId,
      operation.operationId,
      {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: operation.revision,
        status: 'ready',
        checkpointReference: randomUUID(),
      },
    );
    await prepareGate.locked;
    const cancelling = new ContinuationRepository(cancelGate.pool).cancel(
      streamId,
      operation.operationId,
      ownerId,
    );
    await cancelGate.started;
    prepareGate.release();

    const [prepared, cancelled] = await Promise.all([preparing, cancelling]);
    assert.equal(prepared.status, 'ready');
    assert.equal(cancelled.status, 'cancelled');
    const stored = await database.pool.query<{ state: string; permission: string }>(
      `SELECT state, permission FROM stream_runs
        WHERE stream_id = $1 AND run_number = 2`,
      [streamId],
    );
    assert.deepEqual(stored.rows[0], { state: 'closed', permission: 'closed' });
  });

  it('makes preparation lose when cancellation already holds the stream', async () => {
    const { streamId } = await completedManagedStream();
    const operation = await continuations.create(streamId, ownerId, {
      requestId: randomUUID(),
      expectedRevision: 5,
    });
    const cancelGate = queryGate(database.pool, CONTINUATION_STREAM_LOCK, true);
    const prepareGate = queryGate(database.pool, OPERATION_LOCK, false);
    const cancelling = new ContinuationRepository(cancelGate.pool).cancel(
      streamId,
      operation.operationId,
      ownerId,
    );
    await cancelGate.locked;
    const preparing = new ContinuationRepository(prepareGate.pool).prepare(
      streamId,
      operation.operationId,
      {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: operation.revision,
        status: 'ready',
        checkpointReference: randomUUID(),
      },
    );
    await prepareGate.started;
    cancelGate.release();

    const results = await Promise.allSettled([cancelling, preparing]);
    assert.equal(results[0].status, 'fulfilled');
    assertConflict(results[1], 'closed');
    const runs = await database.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM stream_runs WHERE stream_id = $1`,
      [streamId],
    );
    assert.equal(runs.rows[0].count, 1, 'cancelled preparation creates no run');
  });

  it('makes cancellation lose after a claim has taken the run', async () => {
    const { streamId } = await completedManagedStream();
    const ready = await readyContinuation(streamId);
    const claimGate = queryGate(database.pool, MANAGED_RUN_LOCK, true);
    const cancelGate = queryGate(database.pool, CONTINUATION_STREAM_LOCK, false);
    const claiming = new ManagedLifecycleRepository(claimGate.pool).claim(
      streamId,
      ready.runNumber,
      {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: ready.revision,
        requestId: randomUUID(),
      },
    );
    await claimGate.locked;
    const cancelling = new ContinuationRepository(cancelGate.pool).cancel(
      streamId,
      ready.operationId,
      ownerId,
    );
    await cancelGate.started;
    claimGate.release();

    const results = await Promise.allSettled([claiming, cancelling]);
    assert.equal(results[0].status, 'fulfilled');
    assertConflict(results[1], 'closed');
    assert.equal(
      (await continuations.get(streamId, ready.operationId, ownerId)).status,
      'claimed',
    );
  });

  it('makes a claim lose after cancellation has closed the ready run', async () => {
    const { streamId } = await completedManagedStream();
    const ready = await readyContinuation(streamId);
    const cancelGate = queryGate(database.pool, CONTINUATION_STREAM_LOCK, true);
    const claimGate = queryGate(database.pool, MANAGED_RUN_LOCK, false);
    const cancelling = new ContinuationRepository(cancelGate.pool).cancel(
      streamId,
      ready.operationId,
      ownerId,
    );
    await cancelGate.locked;
    const claiming = new ManagedLifecycleRepository(claimGate.pool).claim(
      streamId,
      ready.runNumber,
      {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: ready.revision,
        requestId: randomUUID(),
      },
    );
    await claimGate.started;
    cancelGate.release();

    const results = await Promise.allSettled([cancelling, claiming]);
    assert.equal(results[0].status, 'fulfilled');
    assertConflict(results[1], 'closed');
    assert.equal(
      (await continuations.get(streamId, ready.operationId, ownerId)).status,
      'cancelled',
    );
  });

  it('allows exactly one of two simultaneous claims', async () => {
    const { streamId } = await completedManagedStream();
    const ready = await readyContinuation(streamId);
    const firstGate = queryGate(database.pool, MANAGED_RUN_LOCK, true);
    const secondGate = queryGate(database.pool, MANAGED_RUN_LOCK, false);
    const firstRequestId = randomUUID();
    const first = new ManagedLifecycleRepository(firstGate.pool).claim(
      streamId,
      ready.runNumber,
      {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: ready.revision,
        requestId: firstRequestId,
      },
    );
    await firstGate.locked;
    const second = new ManagedLifecycleRepository(secondGate.pool).claim(
      streamId,
      ready.runNumber,
      {
        lifecycleVersion: 1,
        uploaderId: UPLOADER_ID,
        expectedRevision: ready.revision,
        requestId: randomUUID(),
      },
    );
    await secondGate.started;
    firstGate.release();

    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, 'fulfilled');
    assertConflict(results[1], 'revision_conflict');
    const stored = await lifecycle.readClaimedRun(
      streamId,
      ready.runNumber,
      UPLOADER_ID,
      results[0].status === 'fulfilled' ? results[0].value.claimId ?? '' : '',
    );
    assert.equal(stored.permission, 'claimed');
  });

  it('orders overlapping reports by event sequence', async () => {
    const { streamId } = await completedManagedStream();
    const claimed = await claimedContinuation(streamId);
    const olderGate = queryGate(database.pool, MANAGED_RUN_LOCK, true);
    const newerGate = queryGate(database.pool, MANAGED_RUN_LOCK, false);
    const older = new ManagedLifecycleRepository(olderGate.pool).report(
      streamId,
      claimed.runNumber,
      {
        lifecycleVersion: 1,
        runNumber: claimed.runNumber,
        uploaderId: UPLOADER_ID,
        claimId: claimed.claimId,
        eventSequence: 1,
        observedAt: '2026-09-20T10:00:00.000Z',
        state: 'live',
      },
    );
    await olderGate.locked;
    const newer = new ManagedLifecycleRepository(newerGate.pool).report(
      streamId,
      claimed.runNumber,
      {
        lifecycleVersion: 1,
        runNumber: claimed.runNumber,
        uploaderId: UPLOADER_ID,
        claimId: claimed.claimId,
        eventSequence: 2,
        observedAt: '2026-09-20T10:00:10.000Z',
        state: 'closed',
        reason: 'recovery_required',
      },
    );
    await newerGate.started;
    olderGate.release();

    const [live, closed] = await Promise.all([older, newer]);
    assert.equal(live.state, 'live');
    assert.equal(closed.state, 'closed');
    assert.deepEqual(closed.lastAcceptedEvent, {
      sequence: 2,
      digest: closed.lastAcceptedEvent?.digest,
    });
  });

  it('refuses an older report after a newer report wins the lock', async () => {
    const { streamId } = await completedManagedStream();
    const claimed = await claimedContinuation(streamId);
    const newerGate = queryGate(database.pool, MANAGED_RUN_LOCK, true);
    const olderGate = queryGate(database.pool, MANAGED_RUN_LOCK, false);
    const newer = new ManagedLifecycleRepository(newerGate.pool).report(
      streamId,
      claimed.runNumber,
      {
        lifecycleVersion: 1,
        runNumber: claimed.runNumber,
        uploaderId: UPLOADER_ID,
        claimId: claimed.claimId,
        eventSequence: 2,
        observedAt: '2026-09-20T10:00:10.000Z',
        state: 'closed',
        reason: 'recovery_required',
      },
    );
    await newerGate.locked;
    const older = new ManagedLifecycleRepository(olderGate.pool).report(
      streamId,
      claimed.runNumber,
      {
        lifecycleVersion: 1,
        runNumber: claimed.runNumber,
        uploaderId: UPLOADER_ID,
        claimId: claimed.claimId,
        eventSequence: 1,
        observedAt: '2026-09-20T10:00:00.000Z',
        state: 'live',
      },
    );
    await olderGate.started;
    newerGate.release();

    const results = await Promise.allSettled([newer, older]);
    assert.equal(results[0].status, 'fulfilled');
    assertConflict(results[1], 'stale_event');
    const stored = await lifecycle.readClaimedRun(
      streamId,
      claimed.runNumber,
      UPLOADER_ID,
      claimed.claimId,
    );
    assert.equal(stored.state, 'closed');
    assert.equal(stored.lastAcceptedEvent?.sequence, 2);
  });
});
