import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { UploaderCapabilities } from '@streaming-monorepo/web2-admin-common';
import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { ManagedEnrollmentUnavailableError } from '../../src/domain/errors/index.js';
import { LadderService } from '../../src/domain/LadderService.js';
import { ManagedEnrollmentService } from '../../src/domain/ManagedEnrollmentService.js';
import { ManagedEnrollmentReadiness } from '../../src/domain/ManagedEnrollmentReadiness.js';
import { ManagedLifecycleConflict } from '../../src/domain/managedLifecycle.js';
import { managedRungTopicFor } from '../../src/domain/managedRungTopic.js';
import type { PublishService } from '../../src/domain/PublishService.js';
import { StreamRenditionRepository } from '../../src/domain/StreamRenditionRepository.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';
import { StreamStateService } from '../../src/domain/StreamStateService.js';
import { UploaderCapabilityRepository } from '../../src/domain/UploaderCapabilityRepository.js';

const { Pool } = pg;
const UPLOADER_ID = 'srs-uploader-a';
const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';
const capability: UploaderCapabilities = {
  lifecycleVersion: 1,
  capabilities: {
    durableCheckpointStore: 1,
    legacyRecordingAdoption: 1,
  },
  profiles: [
    {
      mediaType: 'video',
      renditions: [
        {
          name: '720p',
          width: 1280,
          height: 720,
          bandwidth: 2_800_000,
          avgBandwidth: 2_500_000,
        },
        {
          name: '360p',
          width: 640,
          height: 360,
          bandwidth: 800_000,
          avgBandwidth: 700_000,
        },
      ],
    },
  ],
};

let adminPool: pg.Pool;
let database: Database;
let capabilities: UploaderCapabilityRepository;
let enrollment: ManagedEnrollmentService;
let schema: string;
let userId: string;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const unreachablePublisher = {
  republishWithState: () =>
    assert.fail('a refused legacy report must not publish'),
} as unknown as PublishService;

async function waitForEnrollmentWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FOR UPDATE OF stream%'`,
    );
    if (Number(result.rows[0]?.count) >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`expected ${count} enrollment row-lock waiters`);
}

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');
  schema = `managed_enrollment_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  database = new Database(isolatedUrl.toString());
  await database.migrate();
  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ('managed-enrollment', 'scrypt$16384$8$1$aaaa$bbbb')
     RETURNING id`,
  );
  userId = user.rows[0].id;
  capabilities = new UploaderCapabilityRepository(database.pool, UPLOADER_ID);
  const readiness = new ManagedEnrollmentReadiness(capabilities);
  enrollment = new ManagedEnrollmentService(
    database.pool,
    readiness,
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
  await database.pool.query('DELETE FROM streams');
  await database.pool.query('TRUNCATE uploader_capability_receipts');
});

async function createLegacy(status = 'draft'): Promise<{ id: string; topic: string }> {
  const result = await database.pool.query<{ id: string; topic: string }>(
    `INSERT INTO streams (
       user_id, topic, owner, title, description, tags, media_type,
       scheduled_start_time, publish_key, status
     ) VALUES ($1, $2, $3, 'Enrollment', 'Enrollment fixture', '{}',
               'video', NOW(), 'abababababababababababababababab', $4)
     RETURNING id, topic`,
    [userId, randomUUID(), OWNER, status],
  );
  return result.rows[0];
}

async function makeReady(): Promise<void> {
  await capabilities.record(UPLOADER_ID, capability);
}

function isRefusedAsNotFresh(error: unknown): boolean {
  assert.ok(error instanceof ManagedEnrollmentUnavailableError);
  assert.equal(error.reason, 'uploader_capability_not_fresh');
  return true;
}

describe('managed stream enrollment', () => {
  it('freezes a fresh capability ladder into an idle legacy placeholder', async () => {
    const stream = await createLegacy();
    await makeReady();

    assert.equal(
      await enrollment.enrollEligiblePlaceholder(stream.id, userId),
      'enrolled',
    );

    const stored = await database.pool.query<{
      lifecycle_version: number;
      lifecycle_revision: number;
      current_run_number: number;
      enrollment_profile_digest: string;
      state: string;
      permission: string;
      assigned_uploader_id: string;
    }>(
      `SELECT stream.lifecycle_version, stream.lifecycle_revision,
              stream.current_run_number, stream.enrollment_profile_digest,
              run.state, run.permission, run.assigned_uploader_id
         FROM streams stream
         JOIN stream_runs run ON run.stream_id = stream.id
          AND run.run_number = stream.current_run_number
        WHERE stream.id = $1`,
      [stream.id],
    );
    assert.deepEqual(stored.rows[0], {
      lifecycle_version: 1,
      lifecycle_revision: 1,
      current_run_number: 1,
      enrollment_profile_digest: stored.rows[0].enrollment_profile_digest,
      state: 'ready',
      permission: 'open',
      assigned_uploader_id: UPLOADER_ID,
    });
    assert.match(stored.rows[0].enrollment_profile_digest, /^[0-9a-f]{64}$/);

    const expected = await database.pool.query<{
      name: string;
      topic: string;
    }>(
      `SELECT name, topic FROM stream_run_expected_renditions
        WHERE stream_id = $1 AND run_number = 1 ORDER BY name`,
      [stream.id],
    );
    assert.deepEqual(expected.rows, [
      { name: '360p', topic: managedRungTopicFor(stream.topic, '360p') },
      { name: '720p', topic: managedRungTopicFor(stream.topic, '720p') },
    ]);

    const streams = new StreamRepository(database.pool);
    assert.equal(
      (await streams.claimForPublish(stream.id, userId, ['draft']))?.status,
      'publishing',
    );
    assert.equal(
      (await streams.finishPublish(stream.id, userId, 1, null))?.status,
      'published',
    );
    assert.equal(
      (await streams.claimForPublish(stream.id, userId, ['published']))?.status,
      'publishing',
    );
    assert.equal(
      (await streams.finishUnpublish(stream.id, userId))?.status,
      'draft',
    );
  });

  it('fails closed without a fresh capability record, says why, and leaves active legacy rows alone', async () => {
    const idle = await createLegacy();
    await assert.rejects(
      enrollment.enrollEligiblePlaceholder(idle.id, userId),
      isRefusedAsNotFresh,
    );

    await makeReady();
    await database.pool.query(
      `UPDATE uploader_capability_receipts
          SET received_at = clock_timestamp() - interval '31 seconds'
        WHERE uploader_id = $1`,
      [UPLOADER_ID],
    );
    await assert.rejects(
      enrollment.enrollEligiblePlaceholder(idle.id, userId),
      isRefusedAsNotFresh,
    );
    const refused = await database.pool.query<{ lifecycle_version: number | null }>(
      'SELECT lifecycle_version FROM streams WHERE id = $1',
      [idle.id],
    );
    assert.equal(refused.rows[0].lifecycle_version, null);

    const active = await createLegacy('live');
    assert.equal(
      await enrollment.enrollEligiblePlaceholder(active.id, userId),
      'legacy',
    );
    const stored = await database.pool.query<{ lifecycle_version: number | null }>(
      'SELECT lifecycle_version FROM streams WHERE id = $1',
      [active.id],
    );
    assert.equal(stored.rows[0].lifecycle_version, null);
  });

  it('serializes concurrent enrollment and freezes capability read after the stream lock', async () => {
    const stream = await createLegacy();
    await makeReady();
    const barrier = await database.pool.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query('SELECT id FROM streams WHERE id = $1 FOR UPDATE', [
        stream.id,
      ]);
      const pending = Promise.all([
        enrollment.enrollEligiblePlaceholder(stream.id, userId),
        enrollment.enrollEligiblePlaceholder(stream.id, userId),
      ]);
      await waitForEnrollmentWaiters(2);
      await capabilities.record(UPLOADER_ID, {
        ...capability,
        profiles: [
          {
            mediaType: 'video',
            renditions: [
              {
                name: '1080p',
                width: 1920,
                height: 1080,
                bandwidth: 5_800_000,
                avgBandwidth: 5_200_000,
              },
            ],
          },
        ],
      });
      await barrier.query('COMMIT');

      assert.deepEqual((await pending).sort(), ['enrolled', 'managed']);
    } finally {
      await barrier.query('ROLLBACK');
      barrier.release();
    }

    const runs = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM stream_runs WHERE stream_id = $1',
      [stream.id],
    );
    assert.equal(runs.rows[0].count, '1');
    const expected = await database.pool.query<{ name: string }>(
      `SELECT name FROM stream_run_expected_renditions
        WHERE stream_id = $1 ORDER BY name`,
      [stream.id],
    );
    assert.deepEqual(expected.rows, [{ name: '1080p' }]);
  });

  it('refuses a legacy state write that resumes after enrollment commits', async () => {
    const stream = await createLegacy('published');
    await makeReady();
    const streams = new StreamRepository(database.pool);
    const read = deferred();
    const resume = deferred();
    let pauseNextRead = true;
    const state = new StreamStateService(
      {
        findByTopic: streams.findByTopic.bind(streams),
        findByIdUnscoped: async (id) => {
          const row = await streams.findByIdUnscoped(id);
          if (pauseNextRead) {
            pauseNextRead = false;
            read.resolve();
            await resume.promise;
          }
          return row;
        },
        markLive: streams.markLive.bind(streams),
        markVod: streams.markVod.bind(streams),
      },
      unreachablePublisher,
    );

    const report = state.report(stream.id, { state: 'live' });
    await read.promise;
    assert.equal(
      await enrollment.enrollEligiblePlaceholder(stream.id, userId),
      'enrolled',
    );
    resume.resolve();

    await assert.rejects(
      report,
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict &&
        error.code === 'managed_route_required',
    );
    const stored = await streams.findByIdUnscoped(stream.id);
    assert.equal(stored?.status, 'published');
  });

  it('refuses a legacy rung write that resumes after enrollment commits', async () => {
    const stream = await createLegacy('published');
    await makeReady();
    const streams = new StreamRepository(database.pool);
    const renditions = new StreamRenditionRepository(database.pool);
    const read = deferred();
    const resume = deferred();
    let pauseNextRead = true;
    const ladder = new LadderService(
      {
        findByIdUnscoped: async (id) => {
          const row = await streams.findByIdUnscoped(id);
          if (pauseNextRead) {
            pauseNextRead = false;
            read.resolve();
            await resume.promise;
          }
          return row;
        },
      },
      renditions,
      unreachablePublisher,
    );

    const report = ladder.report(stream.id, {
      name: '360p',
      width: 640,
      height: 360,
      topic: managedRungTopicFor(stream.topic, '360p'),
      bandwidth: 800_000,
      avgBandwidth: 700_000,
    });
    await read.promise;
    assert.equal(
      await enrollment.enrollEligiblePlaceholder(stream.id, userId),
      'enrolled',
    );
    resume.resolve();

    await assert.rejects(
      report,
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict &&
        error.code === 'managed_route_required',
    );
    assert.deepEqual(await renditions.listByStream(stream.id), []);
  });
});
