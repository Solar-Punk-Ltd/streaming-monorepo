import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import type { UploaderCapabilities } from '@streaming-monorepo/web2-admin-common';
import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { UploaderCapabilityRepository } from '../../src/domain/UploaderCapabilityRepository.js';
import { ManagedLifecycleConflict } from '../../src/domain/managedLifecycle.js';

const { Pool } = pg;
const UPLOADER_ID = 'fixture-srs-uploader';
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
    { mediaType: 'audio', renditions: [] },
  ],
};

let adminPool: pg.Pool;
let database: Database;
let capabilities: UploaderCapabilityRepository;
let schema: string;

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');
  schema = `uploader_capabilities_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  database = new Database(isolatedUrl.toString());
  await database.migrate();
  capabilities = new UploaderCapabilityRepository(database.pool, UPLOADER_ID);
});

after(async () => {
  if (database) await database.close();
  if (adminPool && schema) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

describe('uploader capability receipts', () => {
  it('records server receipt time and gates enrollment after thirty seconds', async () => {
    const receipt = await capabilities.record(UPLOADER_ID, capability);
    assert.equal(receipt.uploaderId, UPLOADER_ID);
    assert.equal(receipt.lifecycleVersion, 1);
    assert.equal(receipt.profileDigests.length, 2);

    const video = await capabilities.freshProfile('video');
    assert.equal(video?.profile.mediaType, 'video');
    assert.match(video?.digest ?? '', /^[0-9a-f]{64}$/);

    await database.pool.query(
      `UPDATE uploader_capability_receipts
          SET received_at = clock_timestamp() - interval '31 seconds'
        WHERE uploader_id = $1`,
      [UPLOADER_ID],
    );
    assert.equal(await capabilities.freshProfile('video'), null);
  });

  it('binds every receipt to the configured uploader identity', async () => {
    await assert.rejects(
      capabilities.record('different-uploader', capability),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict &&
        error.code === 'assignment_mismatch',
    );
  });
});
