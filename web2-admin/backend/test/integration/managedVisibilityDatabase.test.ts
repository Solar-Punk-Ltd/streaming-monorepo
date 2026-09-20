import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { FeedWriteRepository } from '../../src/domain/FeedWriteRepository.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { StreamRenditionRepository } from '../../src/domain/StreamRenditionRepository.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';
import { newPublishKey } from '../../src/domain/StreamService.js';

const { Pool } = pg;
const feed: FeedIdentity = {
  owner: '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
  topic: 'managed-visibility',
  topicHex: 'd'.repeat(64),
};

let adminPool: pg.Pool;
let database: Database;
let streams: StreamRepository;
let service: PublishService;
let gateway: FakeFeedGateway;
let schema: string;
let ownerId: string;

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');
  schema = `managed_visibility_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  database = new Database(isolatedUrl.toString());
  await database.migrate();
  streams = new StreamRepository(database.pool);
  gateway = new FakeFeedGateway();
  service = new PublishService(
    streams,
    new StreamRenditionRepository(database.pool),
    new FeedWriteRepository(database.pool),
    gateway,
    feed,
  );
  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ('managed-visibility', 'hash') RETURNING id`,
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

describe('managed catalogue visibility', () => {
  it('unpublishes and republishes a closed VOD without changing retained facts', async () => {
    const stream = await streams.insert({
      user_id: ownerId,
      topic: randomUUID(),
      owner: feed.owner,
      title: 'retained replay',
      description: 'visibility fixture',
      tags: [],
      media_type: 'video',
      scheduled_start_time: null,
      publish_key: newPublishKey(),
    });
    await database.pool.query(
      `UPDATE streams SET lifecycle_version = 1, lifecycle_revision = 5,
                          current_run_number = 1, status = 'published',
                          published_at = NOW()
        WHERE id = $1`,
      [stream.id],
    );
    await database.pool.query(
      `INSERT INTO stream_runs (
         stream_id, run_number, state, permission, assigned_uploader_id,
         claim_id, claim_request_id, claim_request_digest, revision,
         last_event_sequence, last_event_digest, last_observed_at,
         last_received_at, close_reason
       ) VALUES ($1, 1, 'closed', 'closed', 'srs-uploader-a', $2, $3,
                 'claim-digest', 4, 1, 'closed-digest', NOW(), NOW(),
                 'reconnect_timeout')`,
      [stream.id, randomUUID(), randomUUID()],
    );
    const checkpointReference = randomUUID();
    await database.pool.query(
      `INSERT INTO stream_run_recordings (
         stream_id, run_number, checkpoint_reference, master_topic,
         master_index, master_reference, duration_seconds
       ) VALUES ($1, 1, $2, $3, 12, repeat('a', 64), 62.5)`,
      [stream.id, checkpointReference, stream.topic],
    );
    await database.pool.query(
      `UPDATE stream_runs SET state = 'vod', revision = 5,
                              last_event_sequence = 2,
                              last_event_digest = 'vod-digest'
        WHERE stream_id = $1 AND run_number = 1`,
      [stream.id],
    );
    await database.pool.query(
      `UPDATE streams SET status = 'vod', completed_run_number = 1,
                          manifest_index = 12, duration_seconds = 62.5
        WHERE id = $1`,
      [stream.id],
    );
    await service.republishManagedState(stream.id);

    const hidden = await service.unpublish(stream.id, ownerId);
    assert.equal(hidden.stream.status, 'vod');
    assert.equal(hidden.stream.current_run_number, 1);
    assert.equal(hidden.stream.completed_run_number, 1);
    assert.equal(hidden.stream.manifest_index, 12);
    assert.equal(hidden.stream.published_at, null);
    assert.deepEqual(gateway.writes.at(-1)?.entries, []);
    assert.equal(await service.republishManagedState(stream.id), null);
    assert.deepEqual(await streams.listOnFeed(), []);

    const restored = await service.publish(stream.id, ownerId);
    assert.equal(restored.stream.status, 'vod');
    assert.equal(restored.stream.completed_run_number, 1);
    assert.ok(restored.stream.published_at);
    assert.equal(gateway.writes.at(-1)?.entries.length, 1);
    const recording = await database.pool.query<{
      checkpoint_reference: string;
    }>(
      `SELECT checkpoint_reference FROM stream_run_recordings
        WHERE stream_id = $1 AND run_number = 1`,
      [stream.id],
    );
    assert.equal(recording.rows[0].checkpoint_reference, checkpointReference);
  });
});
