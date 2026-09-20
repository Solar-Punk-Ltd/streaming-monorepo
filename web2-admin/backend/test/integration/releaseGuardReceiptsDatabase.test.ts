import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import type {
  ReleaseGuardActiveArtifact,
  ReleaseGuardReceipt,
  UploaderCapabilities,
} from '@streaming-monorepo/web2-admin-common';
import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { ManagedEnrollmentReadiness } from '../../src/domain/ManagedEnrollmentReadiness.js';
import {
  ReleaseGuardReceiptConflict,
  ReleaseGuardReceiptRepository,
} from '../../src/domain/ReleaseGuardReceiptRepository.js';
import { UploaderCapabilityRepository } from '../../src/domain/UploaderCapabilityRepository.js';

const { Pool } = pg;
const UPLOADER_ID = 'srs-uploader-a';
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
      ],
    },
  ],
};

let adminPool: pg.Pool;
let database: Database;
let receipts: ReleaseGuardReceiptRepository;
let schema: string;

async function waitForAdvisoryWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted`,
    );
    if (Number(result.rows[0]?.count) >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`expected ${count} blocked release guard inserts`);
}

async function withBlockedFirstBindings<T>(
  run: () => Promise<T>,
): Promise<T> {
  const barrier = await database.pool.connect();
  try {
    await barrier.query('BEGIN');
    await barrier.query('SELECT pg_advisory_xact_lock(941008001)');
    await database.pool.query(`
      CREATE OR REPLACE FUNCTION block_release_guard_binding()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(941008001);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER block_release_guard_binding
      BEFORE INSERT ON release_guard_receipts
      FOR EACH ROW EXECUTE FUNCTION block_release_guard_binding();
    `);
    const pending = run();
    await waitForAdvisoryWaiters(2);
    await barrier.query('COMMIT');
    return await pending;
  } finally {
    await barrier.query('ROLLBACK');
    barrier.release();
    await database.pool.query(
      'DROP TRIGGER IF EXISTS block_release_guard_binding ON release_guard_receipts',
    );
    await database.pool.query(
      'DROP FUNCTION IF EXISTS block_release_guard_binding()',
    );
  }
}

function receipt(
  role: ReleaseGuardReceipt['slot']['role'],
  id: string,
  generation = 1,
  installationId = '11111111-1111-4111-8111-111111111111',
): ReleaseGuardReceipt {
  return {
    schemaVersion: 1,
    installationId,
    generation,
    stateDigest: 'a'.repeat(64),
    slot: { role, id },
    minimums: { srsLifecycle: 1 },
    artifact: {
      treeDigest: 'b'.repeat(64),
      images: [
        {
          service: role,
          imageId: `sha256:${'c'.repeat(64)}`,
        },
      ],
    },
  };
}

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');
  schema = `release_guard_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  database = new Database(isolatedUrl.toString());
  await database.migrate();
  receipts = new ReleaseGuardReceiptRepository(database.pool, UPLOADER_ID);
});

after(async () => {
  if (database) await database.close();
  if (adminPool && schema) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

beforeEach(async () => {
  await database.pool.query(
    'TRUNCATE release_guard_receipts, uploader_capability_receipts',
  );
});

describe('release guard receipts', () => {
  it('first-binds each installation and accepts only monotonic exact updates', async () => {
    const first = receipt('manager', 'default');
    assert.deepEqual(await receipts.record(first), first);
    assert.deepEqual(await receipts.record(first), first);

    await assert.rejects(
      receipts.record({ ...first, generation: 1, stateDigest: 'd'.repeat(64) }),
      (error: unknown) =>
        error instanceof ReleaseGuardReceiptConflict &&
        error.code === 'generation_conflict',
    );
    await assert.rejects(
      receipts.record({ ...first, generation: 2, installationId: randomUUID() }),
      (error: unknown) =>
        error instanceof ReleaseGuardReceiptConflict &&
        error.code === 'installation_conflict',
    );

    const second = { ...first, generation: 2, stateDigest: 'e'.repeat(64) };
    assert.deepEqual(await receipts.record(second), second);
    await assert.rejects(
      receipts.record(first),
      (error: unknown) =>
        error instanceof ReleaseGuardReceiptConflict &&
        error.code === 'stale_generation',
    );
  });

  it('requires all four configured slots before exposing a complete set', async () => {
    assert.equal(await receipts.readCompleteSet(), null);
    await receipts.record(receipt('manager', 'default'));
    await receipts.record(receipt('admin', 'default'));
    await receipts.record(receipt('viewer', 'default'));
    await assert.rejects(
      receipts.record(receipt('uploader', 'different-uploader')),
      (error: unknown) =>
        error instanceof ReleaseGuardReceiptConflict &&
        error.code === 'assignment_mismatch',
    );
    await receipts.record(receipt('uploader', UPLOADER_ID));

    const complete = await receipts.readCompleteSet();
    assert.deepEqual(
      complete?.map(({ slot }) => slot),
      [
        { role: 'admin', id: 'default' },
        { role: 'manager', id: 'default' },
        { role: 'uploader', id: UPLOADER_ID },
        { role: 'viewer', id: 'default' },
      ],
    );
  });

  it('reconciles overlapping exact first bindings without a database error', async () => {
    const first = receipt('manager', 'default');
    const results = await withBlockedFirstBindings(() =>
      Promise.all([receipts.record(first), receipts.record(first)]),
    );

    assert.deepEqual(results, [first, first]);
  });

  it('returns an explicit conflict for overlapping first installations', async () => {
    const first = receipt('manager', 'default');
    const competing = {
      ...first,
      installationId: '22222222-2222-4222-8222-222222222222',
    };
    const results = await withBlockedFirstBindings(() =>
      Promise.allSettled([receipts.record(first), receipts.record(competing)]),
    );

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof ReleaseGuardReceiptConflict);
    assert.equal(rejected.reason.code, 'installation_conflict');
  });

  it('checks current admin proof and fresh capability after the caller locks the stream', async () => {
    const adminReceipt = receipt('admin', 'default');
    const activeAdminArtifact: ReleaseGuardActiveArtifact = {
      schemaVersion: 1,
      installationId: adminReceipt.installationId,
      generation: adminReceipt.generation,
      slot: { role: 'admin', id: 'default' },
      artifact: adminReceipt.artifact,
    };
    const capabilities = new UploaderCapabilityRepository(
      database.pool,
      UPLOADER_ID,
    );
    const readiness = new ManagedEnrollmentReadiness(
      receipts,
      capabilities,
      activeAdminArtifact,
    );
    for (const required of [
      receipt('manager', 'default'),
      adminReceipt,
      receipt('viewer', 'default'),
      receipt('uploader', UPLOADER_ID),
    ]) {
      await receipts.record(required);
    }
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      assert.equal(await readiness.readAfterStreamLock(client, 'video'), null);
      await client.query('COMMIT');

      await capabilities.record(UPLOADER_ID, capability);
      await client.query('BEGIN');
      const ready = await readiness.readAfterStreamLock(client, 'video');
      await client.query('COMMIT');
      assert.equal(ready?.profile.mediaType, 'video');
      assert.match(ready?.profileDigest ?? '', /^[0-9a-f]{64}$/);
      assert.equal(ready?.guardReceipts.length, 4);

      await database.pool.query(
        `UPDATE uploader_capability_receipts
            SET received_at = clock_timestamp() - interval '31 seconds'
          WHERE uploader_id = $1`,
        [UPLOADER_ID],
      );
      await client.query('BEGIN');
      assert.equal(await readiness.readAfterStreamLock(client, 'video'), null);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});
