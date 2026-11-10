/**
 * ExportRepository against the real database (migration 023): what the in-memory store of the unit tests cannot stand
 * in for. One export at a time, held by a unique column, so two starts at once leave one export; a done export replaced
 * by the next start, its dismissals with it; moves that apply only from the state they name; the pause reason set
 * while paused and only then; and a deleted stream taking its export with it.
 *
 * It creates its own users and streams on the suite's throwaway database and removes them in `after`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { ExportRepository, type NewExport } from '../../src/domain/export/ExportRepository.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';

import { releaseStack, requireStack, stack } from './helpers.js';

const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';

let database: Database;
let exportsStore: ExportRepository;
let streams: StreamRepository;
let userId: string;
let otherUserId: string;

async function user(): Promise<string> {
  const row = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb') RETURNING id`,
    [`itest-${randomUUID().slice(0, 8)}`],
  );
  return row.rows[0]!.id;
}

async function stream(title: string): Promise<string> {
  const row = await streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: OWNER,
    title,
    description: '',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
    stage_id: null,
  });
  return row.id;
}

function newExport(streamId: string): NewExport {
  return {
    id: randomUUID(),
    streamId,
    rendition: '1080p',
    quality: '1080p',
    feedOwner: OWNER,
    feedTopic: randomUUID(),
    manifestIndex: 12,
    estimatedBytes: 2_000_000_000,
    durationSeconds: 3600,
    startedByUserId: userId,
    startedBy: 'itest',
  };
}

function progressOf(segments: number) {
  return {
    segmentsTotal: 100,
    segmentsRead: segments,
    segmentsMissing: 0,
    bytesRead: segments * 1_000,
    durationSeconds: 200,
  };
}

async function finish(id: string): Promise<void> {
  await exportsStore.transition(id, ['reading'], { state: 'joining' });
  const done = await exportsStore.transition(id, ['joining'], {
    state: 'done',
    fileName: 'itest-2026-11-05-1080p.mp4',
    sizeBytes: 1234,
    partial: false,
  });
  assert.equal(done?.state, 'done');
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  exportsStore = new ExportRepository(database.pool);
  streams = new StreamRepository(database.pool);
  userId = await user();
  otherUserId = await user();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM stream_exports');
});

after(async () => {
  if (database) {
    await database.pool.query('DELETE FROM stream_exports');
    await database.pool.query('DELETE FROM streams WHERE user_id = $1', [userId]);
    await database.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
    await database.close();
  }
  await releaseStack();
});

describe('ExportRepository', () => {
  it('holds one export at a time, and two starts at once leave one', async () => {
    const streamId = await stream('itest export');
    const [first, second] = await Promise.all([
      exportsStore.create(newExport(streamId)),
      exportsStore.create(newExport(streamId)),
    ]);
    assert.equal([first, second].filter((created) => created !== null).length, 1);
    assert.equal((await database.pool.query('SELECT 1 FROM stream_exports')).rowCount, 1);
    assert.equal(await exportsStore.create(newExport(streamId)), null);
  });

  it('replaces a done export on the next start, and its dismissals go with it', async () => {
    const streamId = await stream('itest replace');
    const first = (await exportsStore.create(newExport(streamId)))!;
    await finish(first.row.id);
    assert.equal(await exportsStore.dismiss(first.row.id, userId), true);

    const second = await exportsStore.create(newExport(streamId));
    assert.deepEqual(second?.replaced, [first.row.id]);
    const left = await database.pool.query('SELECT 1 FROM stream_export_dismissals WHERE export_id = $1', [
      first.row.id,
    ]);
    assert.equal(left.rowCount, 0);
  });

  it('moves only from the state it names, with the reason while paused and only then', async () => {
    const streamId = await stream('itest moves');
    const { row } = (await exportsStore.create(newExport(streamId)))!;

    assert.equal(await exportsStore.transition(row.id, ['paused'], { state: 'reading' }), null);
    const paused = await exportsStore.transition(row.id, ['reading'], {
      state: 'paused',
      pauseReason: 'unreadable',
      pauseMessage: '3 of 100 segments could not be read from Swarm.',
    });
    assert.equal(paused?.pause_reason, 'unreadable');
    assert.ok(paused?.paused_at instanceof Date);
    assert.equal(await exportsStore.progress(row.id, 'reading', progressOf(5)), false);

    const resumed = await exportsStore.transition(row.id, ['paused'], { state: 'reading' });
    assert.equal(resumed?.pause_reason, null);
    assert.equal(resumed?.paused_at, null);
    assert.equal(await exportsStore.progress(row.id, 'reading', progressOf(5)), true);
    assert.equal((await exportsStore.get())?.bytes_read, 5_000);

    await assert.rejects(
      database.pool.query(`UPDATE stream_exports SET state = 'paused' WHERE id = $1`, [row.id]),
      /stream_exports_paused_with_reason/,
    );
  });

  it('shows each user their own dismissal, and only a done export can be dismissed', async () => {
    const streamId = await stream('itest views');
    const { row } = (await exportsStore.create(newExport(streamId)))!;
    assert.equal(await exportsStore.dismiss(row.id, userId), false);
    await finish(row.id);

    assert.equal(await exportsStore.dismiss(row.id, userId), true);
    assert.equal((await exportsStore.view(userId))?.dismissed, true);
    assert.equal((await exportsStore.view(otherUserId))?.dismissed, false);
    assert.equal((await exportsStore.view(null))?.stream_title, 'itest views');
  });

  it('goes with its stream when the stream is deleted', async () => {
    const streamId = await stream('itest cascade');
    await exportsStore.create(newExport(streamId));
    await database.pool.query('DELETE FROM streams WHERE id = $1', [streamId]);
    assert.equal(await exportsStore.get(), null);
  });
});
