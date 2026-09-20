import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import type {
  LegacyAdoptionPreparationRequest,
  ReleaseGuardActiveArtifact,
  ReleaseGuardReceipt,
  UploaderCapabilities,
} from '@streaming-monorepo/web2-admin-common';
import pg from 'pg';

import { ContinuationRepository } from '../../src/domain/ContinuationRepository.js';
import { Database } from '../../src/domain/Database.js';
import { LegacyAdoptionRepository } from '../../src/domain/LegacyAdoptionRepository.js';
import { ManagedEnrollmentReadiness } from '../../src/domain/ManagedEnrollmentReadiness.js';
import { ManagedLifecycleConflict } from '../../src/domain/managedLifecycle.js';
import { managedRungTopicFor } from '../../src/domain/managedRungTopic.js';
import { ReleaseGuardReceiptRepository } from '../../src/domain/ReleaseGuardReceiptRepository.js';
import { UploaderCapabilityRepository } from '../../src/domain/UploaderCapabilityRepository.js';

const { Pool } = pg;
const UPLOADER_ID = 'srs-uploader-a';
const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';
const activeAdminArtifact: ReleaseGuardActiveArtifact = {
  schemaVersion: 1,
  installationId: '22222222-2222-4222-8222-222222222222',
  generation: 3,
  slot: { role: 'admin', id: 'default' },
  artifact: {
    treeDigest: 'e'.repeat(64),
    images: [{ service: 'admin', imageId: `sha256:${'c'.repeat(64)}` }],
  },
};
const capability: UploaderCapabilities = {
  lifecycleVersion: 1,
  capabilities: { durableCheckpointStore: 1, legacyRecordingAdoption: 1 },
  profiles: [
    {
      mediaType: 'video',
      renditions: [
        {
          name: '360p',
          width: 640,
          height: 360,
          bandwidth: 800_000,
          avgBandwidth: 700_000,
        },
        {
          name: '720p',
          width: 1280,
          height: 720,
          bandwidth: 2_800_000,
          avgBandwidth: 2_500_000,
        },
      ],
    },
  ],
};

let adminPool: pg.Pool;
let database: Database;
let adoptions: LegacyAdoptionRepository;
let capabilities: UploaderCapabilityRepository;
let receipts: ReleaseGuardReceiptRepository;
let schema: string;
let userId: string;

async function waitForLockWaiters(
  count: number,
  streamSelectOnly = true,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          ${
            streamSelectOnly
              ? "AND query LIKE '%FROM streams WHERE id = $1%FOR UPDATE%'"
              : ''
          }`,
    );
    if (Number(result.rows[0]?.count) >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`expected ${count} stream row-lock waiters`);
}

function guardReceipt(
  role: ReleaseGuardReceipt['slot']['role'],
  id: string,
): ReleaseGuardReceipt {
  return {
    schemaVersion: 1,
    installationId:
      role === 'admin'
        ? activeAdminArtifact.installationId
        : '11111111-1111-4111-8111-111111111111',
    generation: role === 'admin' ? activeAdminArtifact.generation : 1,
    stateDigest: 'a'.repeat(64),
    slot: { role, id },
    minimums: { srsLifecycle: 1 },
    artifact:
      role === 'admin'
        ? activeAdminArtifact.artifact
        : {
            treeDigest: 'b'.repeat(64),
            images: [{ service: role, imageId: `sha256:${'d'.repeat(64)}` }],
          },
  };
}

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');
  schema = `legacy_adoption_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  database = new Database(isolatedUrl.toString());
  await database.migrate();
  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ('legacy-adoption-owner', 'hash') RETURNING id`,
  );
  userId = user.rows[0].id;
  capabilities = new UploaderCapabilityRepository(database.pool, UPLOADER_ID);
  receipts = new ReleaseGuardReceiptRepository(database.pool, UPLOADER_ID);
  adoptions = new LegacyAdoptionRepository(
    database.pool,
    new ManagedEnrollmentReadiness(
      receipts,
      capabilities,
      activeAdminArtifact,
    ),
    UPLOADER_ID,
  );
});

after(async () => {
  if (database) await database.close();
  if (adminPool && schema) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE streams CASCADE');
  await database.pool.query(
    'TRUNCATE release_guard_receipts, uploader_capability_receipts',
  );
  await capabilities.record(UPLOADER_ID, capability);
  for (const receipt of [
    guardReceipt('manager', 'default'),
    guardReceipt('admin', 'default'),
    guardReceipt('viewer', 'default'),
    guardReceipt('uploader', UPLOADER_ID),
  ]) {
    await receipts.record(receipt);
  }
});

async function legacyVod(): Promise<{ id: string; topic: string }> {
  const stream = await database.pool.query<{ id: string; topic: string }>(
    `INSERT INTO streams (
       user_id, topic, owner, title, description, tags, media_type,
       scheduled_start_time, publish_key, status, manifest_index,
       duration_seconds, ended_at, published_at
     ) VALUES ($1, $2, $3, 'Legacy VOD', 'Adoption fixture', '{}',
               'video', NOW(), 'abababababababababababababababab', 'vod',
               12, 62.5, NOW(), NOW())
     RETURNING id, topic`,
    [userId, randomUUID(), OWNER],
  );
  for (const rung of capability.profiles[0].renditions) {
    await database.pool.query(
      `INSERT INTO stream_renditions (
         stream_id, name, width, height, topic, bandwidth, avg_bandwidth,
         manifest_index, duration_seconds
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 62.5)`,
      [
        stream.rows[0].id,
        rung.name,
        rung.width,
        rung.height,
        managedRungTopicFor(stream.rows[0].topic, rung.name),
        rung.bandwidth + 123,
        rung.avgBandwidth + 45,
        rung.name === '360p' ? 10 : 11,
      ],
    );
  }
  return stream.rows[0];
}

function readyRequest(
  operation: Awaited<ReturnType<LegacyAdoptionRepository['create']>>,
): Extract<LegacyAdoptionPreparationRequest, { status: 'ready' }> {
  return {
    lifecycleVersion: 1,
    uploaderId: UPLOADER_ID,
    expectedRevision: operation.revision,
    candidateDigest: operation.candidateDigest,
    status: 'ready',
    completedRecording: {
      runNumber: 1,
      checkpointReference: randomUUID(),
      master: {
        ...operation.candidate.master,
        reference: 'a'.repeat(64),
      },
      expectedRenditions: operation.candidate.renditions.map(({ name }) => name),
      renditions: operation.candidate.renditions.map((rendition, index) => ({
        ...rendition,
        reference: String(index + 1).repeat(64),
      })),
    },
    validation: {
      version: 1,
      mediaReadable: true,
      pendingWrites: 0,
      tracks: operation.candidate.renditions
        .map(({ topic, width, height }) => ({
          topic,
          formatFingerprint: {
            version: 1 as const,
            container: 'mpegts' as const,
            tracks: [
              {
                kind: 'video' as const,
                codec: 'h264',
                profile: 'High',
                level: 40,
                width,
                height,
                pixelFormat: 'yuv420p',
                chromaLocation: 'left',
                bitsPerRawSample: 8,
              },
              {
                kind: 'audio' as const,
                codec: 'aac',
                profile: 'LC',
                sampleRate: 48_000,
                channels: 2,
                channelLayout: 'stereo',
              },
            ],
          },
        }))
        .sort((left, right) => left.topic.localeCompare(right.topic)),
    },
  };
}

describe('legacy VOD adoption', () => {
  it('freezes, verifies and atomically enrolls the exact completed recording', async () => {
    const stream = await legacyVod();
    const preview = await adoptions.preview(stream.id, userId);
    const request = {
      requestId: randomUUID(),
      expectedCandidateDigest: preview.candidateDigest,
    };
    const operation = await adoptions.create(stream.id, userId, request);
    assert.equal(operation.status, 'pending');
    assert.equal((await adoptions.listPending(UPLOADER_ID)).length, 1);
    assert.equal(
      (await adoptions.create(stream.id, userId, request)).operationId,
      operation.operationId,
    );

    const preparation = readyRequest(operation);
    const committed = await adoptions.prepare(
      stream.id,
      operation.operationId,
      preparation,
    );
    assert.equal(committed.status, 'committed');
    assert.deepEqual(committed.validation, preparation.validation);
    assert.deepEqual(committed.completedRecording, preparation.completedRecording);
    assert.equal(
      (await adoptions.create(stream.id, userId, request)).status,
      'committed',
    );
    assert.equal(
      (
        await adoptions.prepare(
          stream.id,
          operation.operationId,
          preparation,
        )
      ).status,
      'committed',
    );
    const changedFormat = structuredClone(preparation);
    const firstTrack = changedFormat.validation.tracks[0]
      .formatFingerprint.tracks[0];
    assert.equal(firstTrack.kind, 'video');
    if (firstTrack.kind === 'video') firstTrack.width += 1;
    await assert.rejects(
      adoptions.prepare(stream.id, operation.operationId, changedFormat),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict &&
        error.code === 'event_conflict',
    );

    const stored = await database.pool.query<{
      lifecycle_version: number;
      current_run_number: number;
      completed_run_number: number;
      state: string;
      permission: string;
      master_reference: string;
    }>(
      `SELECT stream.lifecycle_version, stream.current_run_number,
              stream.completed_run_number, run.state, run.permission,
              recording.master_reference
         FROM streams stream
         JOIN stream_runs run ON run.stream_id = stream.id AND run.run_number = 1
         JOIN stream_run_recordings recording
           ON recording.stream_id = stream.id AND recording.run_number = 1
        WHERE stream.id = $1`,
      [stream.id],
    );
    assert.deepEqual(stored.rows[0], {
      lifecycle_version: 1,
      current_run_number: 1,
      completed_run_number: 1,
      state: 'vod',
      permission: 'closed',
      master_reference: 'a'.repeat(64),
    });
    const rungMetadata = await database.pool.query<{
      name: string;
      recorded_bandwidth: number;
      expected_bandwidth: number;
    }>(
      `SELECT recording.name, recording.bandwidth AS recorded_bandwidth,
              expected.bandwidth AS expected_bandwidth
         FROM stream_run_recording_renditions recording
         JOIN stream_run_expected_renditions expected
           USING (stream_id, run_number, name)
        WHERE recording.stream_id = $1 ORDER BY recording.name`,
      [stream.id],
    );
    assert.deepEqual(rungMetadata.rows, [
      { name: '360p', recorded_bandwidth: 800_123, expected_bandwidth: 800_000 },
      {
        name: '720p',
        recorded_bandwidth: 2_800_123,
        expected_bandwidth: 2_800_000,
      },
    ]);
    const continuation = await new ContinuationRepository(database.pool).create(
      stream.id,
      userId,
      { requestId: randomUUID(), expectedRevision: 1 },
    );
    assert.equal(continuation.status, 'pending');
    assert.deepEqual(
      continuation.retainedRecording?.renditions.map(
        ({ name, bandwidth }) => ({ name, bandwidth }),
      ),
      [
        { name: '360p', bandwidth: 800_123 },
        { name: '720p', bandwidth: 2_800_123 },
      ],
    );
  });

  it('refuses a changed legacy VOD at final compare-and-set and preserves it', async () => {
    const stream = await legacyVod();
    const preview = await adoptions.preview(stream.id, userId);
    const operation = await adoptions.create(stream.id, userId, {
      requestId: randomUUID(),
      expectedCandidateDigest: preview.candidateDigest,
    });
    await database.pool.query(
      'UPDATE streams SET manifest_index = manifest_index + 1 WHERE id = $1',
      [stream.id],
    );
    await assert.rejects(
      adoptions.prepare(
        stream.id,
        operation.operationId,
        readyRequest(operation),
      ),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict &&
        error.code === 'candidate_changed',
    );
    const stored = await database.pool.query<{
      lifecycle_version: number | null;
      manifest_index: number;
    }>('SELECT lifecycle_version, manifest_index FROM streams WHERE id = $1', [
      stream.id,
    ]);
    assert.deepEqual(stored.rows[0], {
      lifecycle_version: null,
      manifest_index: 13,
    });
  });

  it('keeps cancellation terminal when a delayed ready acknowledgement arrives', async () => {
    const stream = await legacyVod();
    const preview = await adoptions.preview(stream.id, userId);
    const operation = await adoptions.create(stream.id, userId, {
      requestId: randomUUID(),
      expectedCandidateDigest: preview.candidateDigest,
    });
    assert.equal(
      (await adoptions.cancel(stream.id, operation.operationId, userId)).status,
      'cancelled',
    );
    await assert.rejects(
      adoptions.prepare(
        stream.id,
        operation.operationId,
        readyRequest(operation),
      ),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'closed',
    );
    const legacy = await database.pool.query<{ lifecycle_version: number | null }>(
      'SELECT lifecycle_version FROM streams WHERE id = $1',
      [stream.id],
    );
    assert.equal(legacy.rows[0].lifecycle_version, null);
  });

  it('serializes prepare and cancel in both lock orders without reopening a terminal result', async () => {
    for (const first of ['prepare', 'cancel'] as const) {
      const stream = await legacyVod();
      const preview = await adoptions.preview(stream.id, userId);
      const operation = await adoptions.create(stream.id, userId, {
        requestId: randomUUID(),
        expectedCandidateDigest: preview.candidateDigest,
      });
      const preparation = readyRequest(operation);
      const barrier = await database.pool.connect();
      try {
        await barrier.query('BEGIN');
        await barrier.query('SELECT id FROM streams WHERE id = $1 FOR UPDATE', [
          stream.id,
        ]);
        const prepareOutcome = () =>
          adoptions.prepare(stream.id, operation.operationId, preparation).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        const cancelOutcome = () =>
          adoptions.cancel(stream.id, operation.operationId, userId).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        const firstResult = first === 'prepare' ? prepareOutcome() : cancelOutcome();
        await waitForLockWaiters(1);
        const secondResult = first === 'prepare' ? cancelOutcome() : prepareOutcome();
        await waitForLockWaiters(2);
        await barrier.query('COMMIT');
        const [one, two] = await Promise.all([firstResult, secondResult]);
        const winner = 'value' in one ? one.value : undefined;
        const loser = 'error' in two ? two.error : undefined;
        assert.equal(
          winner?.status,
          first === 'prepare' ? 'committed' : 'cancelled',
        );
        assert.ok(loser instanceof ManagedLifecycleConflict);
        assert.equal(loser.code, 'closed');
      } finally {
        await barrier.query('ROLLBACK');
        barrier.release();
      }
    }
  });

  it('makes an old legacy write queued behind adoption observe the managed guard', async () => {
    const stream = await legacyVod();
    const preview = await adoptions.preview(stream.id, userId);
    const operation = await adoptions.create(stream.id, userId, {
      requestId: randomUUID(),
      expectedCandidateDigest: preview.candidateDigest,
    });
    const barrier = await database.pool.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query('SELECT id FROM streams WHERE id = $1 FOR UPDATE', [
        stream.id,
      ]);
      const prepared = adoptions.prepare(
        stream.id,
        operation.operationId,
        readyRequest(operation),
      );
      await waitForLockWaiters(1);
      const staleWrite = database.pool
        .query('UPDATE streams SET manifest_index = 99 WHERE id = $1', [stream.id])
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
      await waitForLockWaiters(2, false);
      await barrier.query('COMMIT');
      assert.equal((await prepared).status, 'committed');
      const stale = await staleWrite;
      assert.ok(stale.error instanceof Error);
      assert.match(stale.error.message, /managed completed recording/);
    } finally {
      await barrier.query('ROLLBACK');
      barrier.release();
    }
    const stored = await database.pool.query<{
      manifest_index: number;
      lifecycle_version: number;
    }>('SELECT manifest_index, lifecycle_version FROM streams WHERE id = $1', [
      stream.id,
    ]);
    assert.deepEqual(stored.rows[0], { manifest_index: 12, lifecycle_version: 1 });
  });
});
