import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { FeedWriteRepository } from '../../src/domain/FeedWriteRepository.js';
import { PublishService } from '../../src/domain/PublishService.js';
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

function gatedCataloguePool(pool: pg.Pool): {
  pool: pg.Pool;
  streamRead: Promise<void>;
  release(): void;
} {
  const streamRead = deferred();
  const release = deferred();
  let intercepted = false;
  return {
    pool: {
      async connect(): Promise<pg.PoolClient> {
        const client = await pool.connect();
        return {
          query: (async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (
              !intercepted &&
              text.includes('FROM streams WHERE id = $1')
            ) {
              intercepted = true;
              streamRead.resolve();
              await release.promise;
            }
            return result;
          }) as pg.PoolClient['query'],
          release: client.release.bind(client),
        } as unknown as pg.PoolClient;
      },
    } as pg.Pool,
    streamRead: streamRead.promise,
    release: () => release.resolve(),
  };
}

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
    const renditionTopic = randomUUID();
    await database.pool.query(
      `INSERT INTO stream_run_expected_renditions (
         stream_id, run_number, name, topic, width, height, bandwidth,
         avg_bandwidth
       ) VALUES ($1, 1, '720p', $2, 1280, 720, 2800000, 2500000)`,
      [stream.id, renditionTopic],
    );
    await database.pool.query(
      `INSERT INTO stream_run_recordings (
         stream_id, run_number, checkpoint_reference, master_topic,
         master_index, master_reference, duration_seconds
       ) VALUES ($1, 1, $2, $3, 12, repeat('a', 64), 62.5)`,
      [stream.id, checkpointReference, stream.topic],
    );
    await database.pool.query(
      `INSERT INTO stream_run_recording_renditions (
         stream_id, run_number, name, topic, manifest_index, reference,
         duration_seconds, width, height, bandwidth, avg_bandwidth
       ) VALUES ($1, 1, '720p', $2, 14, repeat('b', 64), 62.5,
                 1280, 720, 2800000, 2500000)`,
      [stream.id, renditionTopic],
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
    const restoredEntry = gateway.writes.at(-1)?.entries[0] as {
      completedRecording?: {
        renditions: Array<{ name: string; reference: string }>;
      };
    };
    assert.deepEqual(restoredEntry.completedRecording?.renditions, [
      { name: '720p', reference: 'b'.repeat(64), topic: renditionTopic,
        index: 14, duration: 62.5, width: 1280, height: 720,
        bandwidth: 2_800_000, avgBandwidth: 2_500_000 },
    ]);
    const recording = await database.pool.query<{
      checkpoint_reference: string;
      rendition_reference: string;
    }>(
      `SELECT recording.checkpoint_reference,
              rendition.reference AS rendition_reference
         FROM stream_run_recordings recording
         JOIN stream_run_recording_renditions rendition
           USING (stream_id, run_number)
        WHERE recording.stream_id = $1 AND recording.run_number = 1`,
      [stream.id],
    );
    assert.equal(recording.rows[0].checkpoint_reference, checkpointReference);
    assert.equal(recording.rows[0].rendition_reference, 'b'.repeat(64));
  });

  it('reads a managed row, lifecycle and ladder from one database snapshot', async () => {
    const stream = await streams.insert({
      user_id: ownerId,
      topic: randomUUID(),
      owner: feed.owner,
      title: 'coherent snapshot',
      description: 'run replacement fixture',
      tags: [],
      media_type: 'video',
      scheduled_start_time: null,
      publish_key: newPublishKey(),
    });
    const runOneTopic = randomUUID();
    await database.pool.query(
      `UPDATE streams SET lifecycle_version = 1, lifecycle_revision = 2,
                          current_run_number = 1, published_at = NOW()
        WHERE id = $1`,
      [stream.id],
    );
    await database.pool.query(
      `INSERT INTO stream_runs (
         stream_id, run_number, state, permission, assigned_uploader_id,
         claim_id, claim_request_id, claim_request_digest, revision
       ) VALUES ($1, 1, 'live', 'claimed', 'srs-uploader-a', $2, $3,
                 repeat('a', 64), 2)`,
      [stream.id, randomUUID(), randomUUID()],
    );
    await database.pool.query(
      `INSERT INTO stream_run_expected_renditions (
         stream_id, run_number, name, topic, width, height, bandwidth,
         avg_bandwidth
       ) VALUES ($1, 1, '360p', $2, 640, 360, 800000, 700000)`,
      [stream.id, runOneTopic],
    );
    await database.pool.query(
      `INSERT INTO stream_run_renditions (
         stream_id, run_number, name, topic, width, height, bandwidth,
         avg_bandwidth, last_sequence, last_digest, last_observed_at,
         rendition_revision
       ) VALUES ($1, 1, '360p', $2, 640, 360, 800000, 700000, 1,
                 repeat('b', 64), NOW(), 1)`,
      [stream.id, runOneTopic],
    );
    await database.pool.query(
      `UPDATE streams SET status = 'live' WHERE id = $1`,
      [stream.id],
    );

    const gate = gatedCataloguePool(database.pool);
    const gatedStreams = new StreamRepository(gate.pool);
    const pending = gatedStreams.catalogueSnapshot(stream.id);
    await gate.streamRead;

    const runTwoTopic = randomUUID();
    const transition = await database.pool.connect();
    try {
      await transition.query('BEGIN');
      await transition.query(
        `INSERT INTO stream_runs (
           stream_id, run_number, state, permission, assigned_uploader_id,
           claim_id, claim_request_id, claim_request_digest, revision
         ) VALUES ($1, 2, 'live', 'claimed', 'srs-uploader-a', $2, $3,
                   repeat('c', 64), 3)`,
        [stream.id, randomUUID(), randomUUID()],
      );
      await transition.query(
        `INSERT INTO stream_run_expected_renditions (
           stream_id, run_number, name, topic, width, height, bandwidth,
           avg_bandwidth
         ) VALUES ($1, 2, '720p', $2, 1280, 720, 2800000, 2500000)`,
        [stream.id, runTwoTopic],
      );
      await transition.query(
        `INSERT INTO stream_run_renditions (
           stream_id, run_number, name, topic, width, height, bandwidth,
           avg_bandwidth, last_sequence, last_digest, last_observed_at,
           rendition_revision
         ) VALUES ($1, 2, '720p', $2, 1280, 720, 2800000, 2500000, 1,
                   repeat('d', 64), NOW(), 1)`,
        [stream.id, runTwoTopic],
      );
      await transition.query(
        `UPDATE streams
            SET lifecycle_revision = 3, current_run_number = 2
          WHERE id = $1`,
        [stream.id],
      );
      await transition.query('COMMIT');
    } finally {
      await transition.query('ROLLBACK');
      transition.release();
      gate.release();
    }

    const snapshot = await pending;
    assert.equal(snapshot?.stream.current_run_number, 1);
    assert.equal(snapshot?.managedState?.lifecycle.runNumber, 1);
    assert.deepEqual(snapshot?.renditions.map(({ name }) => name), ['360p']);

    const current = await streams.catalogueSnapshot(stream.id);
    assert.equal(current?.stream.current_run_number, 2);
    assert.equal(current?.managedState?.lifecycle.runNumber, 2);
    assert.deepEqual(current?.renditions.map(({ name }) => name), ['720p']);
  });
});
