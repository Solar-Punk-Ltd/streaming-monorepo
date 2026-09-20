import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { ManagedRenditionReport } from '@streaming-monorepo/web2-admin-common';
import pg from 'pg';

import { Database } from '../../src/domain/Database.js';
import { ManagedLifecycleRepository } from '../../src/domain/ManagedLifecycleRepository.js';
import { ManagedLifecycleConflict } from '../../src/domain/managedLifecycle.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';
import { newPublishKey } from '../../src/domain/StreamService.js';

const { Pool } = pg;
const UPLOADER_ID = 'srs-uploader-a';
const CLAIM_ID = '22222222-2222-4222-8222-222222222222';
const RUN_LOCK = 'FOR UPDATE OF stream, run';

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

function gatedPool(pool: pg.Pool): {
  pool: pg.Pool;
  locked: Promise<void>;
  release(): void;
} {
  const locked = deferred();
  const release = deferred();
  let intercepted = false;
  return {
    pool: {
      async connect(): Promise<pg.PoolClient> {
        const client = await pool.connect();
        return {
          query: (async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (!intercepted && text.includes(RUN_LOCK)) {
              intercepted = true;
              locked.resolve();
              await release.promise;
            }
            return result;
          }) as pg.PoolClient['query'],
          release: client.release.bind(client),
        } as unknown as pg.PoolClient;
      },
    } as pg.Pool,
    locked: locked.promise,
    release: () => release.resolve(),
  };
}

let adminPool: pg.Pool;
let database: Database;
let lifecycle: ManagedLifecycleRepository;
let streams: StreamRepository;
let schema: string;
let ownerId: string;
let streamId: string;
let topic: string;

before(async () => {
  const sourceUrl = process.env.DATABASE_URL;
  assert.ok(sourceUrl, 'DATABASE_URL must name the isolated test Postgres');
  schema = `managed_renditions_${randomUUID().replaceAll('-', '')}`;
  adminPool = new Pool({ connectionString: sourceUrl, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  database = new Database(isolatedUrl.toString());
  await database.migrate();
  lifecycle = new ManagedLifecycleRepository(database.pool);
  streams = new StreamRepository(database.pool);
  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ('managed-renditions', 'hash') RETURNING id`,
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

beforeEach(async () => {
  await database.pool.query('DELETE FROM streams');
  const stream = await streams.insert({
    user_id: ownerId,
    topic: randomUUID(),
    owner: 'fixture-owner',
    title: 'managed ladder',
    description: 'run-scoped rendition fixture',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
  });
  streamId = stream.id;
  topic = stream.topic;
  await database.pool.query(
    `UPDATE streams SET lifecycle_version = 1, lifecycle_revision = 2,
                        current_run_number = 1 WHERE id = $1`,
    [streamId],
  );
  await database.pool.query(
    `INSERT INTO stream_runs (
       stream_id, run_number, state, permission, assigned_uploader_id,
       claim_id, claim_request_id, claim_request_digest, revision
     ) VALUES ($1, 1, 'claimed', 'claimed', $2, $3, $4, 'claim-digest', 2)`,
    [streamId, UPLOADER_ID, CLAIM_ID, randomUUID()],
  );
  for (const rung of [
    ['360p', 640, 360, 800_000, 700_000],
    ['720p', 1280, 720, 2_800_000, 2_500_000],
  ] as const) {
    await database.pool.query(
      `INSERT INTO stream_run_expected_renditions (
         stream_id, run_number, name, topic, width, height, bandwidth,
         avg_bandwidth
       ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
      [
        streamId,
        rung[0],
        rungTopic(rung[0]),
        rung[1],
        rung[2],
        rung[3],
        rung[4],
      ],
    );
  }
});

function rungTopic(name: string): string {
  return name === '360p'
    ? '33333333-3333-4333-8333-333333333333'
    : '77777777-7777-4777-8777-777777777777';
}

function report(
  name: '360p' | '720p',
  sequence: number,
  final = false,
): ManagedRenditionReport {
  const is360 = name === '360p';
  return {
    lifecycleVersion: 1,
    uploaderId: UPLOADER_ID,
    claimId: CLAIM_ID,
    renditionSequence: sequence,
    observedAt: '2026-09-20T10:00:00.000Z',
    rendition: {
      name,
      topic: rungTopic(name),
      width: is360 ? 640 : 1280,
      height: is360 ? 360 : 720,
      bandwidth: is360 ? 800_000 : 2_800_000,
      avgBandwidth: is360 ? 700_000 : 2_500_000,
      ...(final ? { index: sequence + 10, duration: is360 ? 61 : 62.5 } : {}),
    },
  };
}

describe('managed run-scoped rendition reports', () => {
  it('orders each rung independently and completes only the frozen ladder', async () => {
    assert.equal(
      (await lifecycle.reportRendition(streamId, 1, report('720p', 1)))
        .ladder.finished,
      false,
    );
    await lifecycle.reportRendition(streamId, 1, report('360p', 1, true));
    const finished = await lifecycle.reportRendition(
      streamId,
      1,
      report('720p', 2, true),
    );
    assert.equal(finished.renditionRevision, 3);
    assert.deepEqual(finished.renditions.map(({ name }) => name), [
      '360p',
      '720p',
    ]);
    assert.deepEqual(finished.ladder, {
      finished: true,
      flippedToFinished: true,
      duration: 62.5,
    });

    const retry = await lifecycle.reportRendition(
      streamId,
      1,
      report('720p', 2, true),
    );
    assert.equal(retry.renditionRevision, 3);
    assert.equal(retry.ladder.flippedToFinished, true);
    await assert.rejects(
      lifecycle.reportRendition(streamId, 1, report('720p', 1)),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'stale_event',
    );
  });

  it('rejects the wrong frozen rung metadata and same-sequence conflicts', async () => {
    await assert.rejects(
      lifecycle.reportRendition(streamId, 1, {
        ...report('360p', 1),
        rendition: { ...report('360p', 1).rendition, width: 641 },
      }),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict &&
        error.code === 'assignment_mismatch',
    );
    await lifecycle.reportRendition(streamId, 1, report('360p', 1));
    await assert.rejects(
      lifecycle.reportRendition(streamId, 1, {
        ...report('360p', 1),
        observedAt: '2026-09-20T10:00:01.000Z',
      }),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'event_conflict',
    );
  });

  it('serializes overlapping rung reports into one aggregate revision order', async () => {
    const gate = gatedPool(database.pool);
    const gated = new ManagedLifecycleRepository(gate.pool);
    const first = gated.reportRendition(streamId, 1, report('720p', 1));
    await gate.locked;
    const second = lifecycle.reportRendition(streamId, 1, report('360p', 1));
    gate.release();
    const results = await Promise.all([first, second]);

    assert.deepEqual(
      results.map(({ renditionRevision }) => renditionRevision),
      [1, 2],
    );
    assert.deepEqual(results[1].renditions.map(({ name }) => name), [
      '360p',
      '720p',
    ]);
  });

  it('accepts only final draining reports after close and only exact retries after VOD', async () => {
    await database.pool.query(
      `UPDATE stream_runs SET state = 'closed', permission = 'closed',
                              close_reason = 'reconnect_timeout'
        WHERE stream_id = $1 AND run_number = 1`,
      [streamId],
    );
    await assert.rejects(
      lifecycle.reportRendition(streamId, 1, report('360p', 1)),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'closed',
    );
    const final = report('360p', 1, true);
    await lifecycle.reportRendition(streamId, 1, final);
    await lifecycle.reportRendition(streamId, 1, report('720p', 1, true));
    const completedRecording = {
      runNumber: 1,
      checkpointReference: randomUUID(),
      master: {
        topic,
        index: 12,
        reference: 'a'.repeat(64),
        duration: 62.5,
      },
      expectedRenditions: ['360p', '720p'],
      renditions: [
        {
          ...final.rendition,
          index: 11,
          duration: 61,
          reference: 'b'.repeat(64),
        },
        {
          ...report('720p', 1, true).rendition,
          index: 11,
          duration: 62.5,
          reference: 'c'.repeat(64),
        },
      ],
    };
    await assert.rejects(
      lifecycle.report(streamId, 1, {
        lifecycleVersion: 1,
        runNumber: 1,
        uploaderId: UPLOADER_ID,
        claimId: CLAIM_ID,
        eventSequence: 1,
        observedAt: '2026-09-20T10:00:01.000Z',
        state: 'vod',
        completedRecording: {
          ...completedRecording,
          renditions: [
            { ...completedRecording.renditions[0], index: 99 },
            completedRecording.renditions[1],
          ],
        },
      }),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict &&
        error.code === 'event_conflict',
    );
    await lifecycle.report(streamId, 1, {
      lifecycleVersion: 1,
      runNumber: 1,
      uploaderId: UPLOADER_ID,
      claimId: CLAIM_ID,
      eventSequence: 1,
      observedAt: '2026-09-20T10:00:01.000Z',
      state: 'vod',
      completedRecording,
    });
    assert.equal(
      (await lifecycle.reportRendition(streamId, 1, final)).renditionRevision,
      2,
    );
    await assert.rejects(
      lifecycle.reportRendition(streamId, 1, report('360p', 2, true)),
      (error: unknown) =>
        error instanceof ManagedLifecycleConflict && error.code === 'closed',
    );
  });
});
