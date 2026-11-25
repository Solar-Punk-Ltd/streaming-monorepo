/**
 * ArchiveRepository against the real database (migrations 025 to 029), with the place it shares with the export: one
 * archive at a time, an archive and an export never both holding the place, a user's pause and a purchase confirm
 * giving it up, moves that apply only from the state they name, the resume ledger, a quality's copy replaced when it
 * is made again, one purchase under way at a time, the listing switch, and the end of its stamp each catalogue stamp
 * record gives a copy as it arrives.
 *
 * It creates its own users and streams on the suite's throwaway database and removes them in `after`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { CatalogueArchiveBatch } from '@streaming-monorepo/contracts';

import { ArchiveRepository, type NewArchiveJob } from '../../src/domain/archive/ArchiveRepository.js';
import { Database } from '../../src/domain/Database.js';
import { ExportRepository } from '../../src/domain/export/ExportRepository.js';
import { CatalogueStampRepository } from '../../src/domain/StageRepository.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';
import { archiveBatch } from '../unit/support/archiveFakes.js';
import { catalogueStampRecord } from '../unit/support/stageFakes.js';

import { releaseStack, requireStack, stack } from './helpers.js';

const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';
const BATCH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

let database: Database;
let archives: ArchiveRepository;
let exportsStore: ExportRepository;
let streams: StreamRepository;
let userId: string;

async function stream(title: string): Promise<string> {
  const row = await streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: OWNER,
    title,
    description: 'An itest stream for the archive repository.',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
    stage_id: null,
  });
  return row.id;
}

function newJob(streamId: string, over: Partial<NewArchiveJob> = {}): NewArchiveJob {
  return {
    id: randomUUID(),
    streamId,
    batchId: BATCH,
    buyNew: false,
    startedByUserId: userId,
    startedBy: 'itest',
    items: [
      { rendition: '720p', feedOwner: OWNER, feedTopic: randomUUID(), manifestIndex: 5 },
      { rendition: '360p', feedOwner: OWNER, feedTopic: randomUUID(), manifestIndex: 5 },
    ],
    ...over,
  };
}

async function startExport(streamId: string): Promise<string | null> {
  const created = await exportsStore.create({
    id: randomUUID(),
    streamId,
    rendition: '720p',
    quality: '720p',
    feedOwner: OWNER,
    feedTopic: randomUUID(),
    manifestIndex: 5,
    estimatedBytes: null,
    durationSeconds: null,
    startedByUserId: userId,
    startedBy: 'itest',
  });
  return created?.row.id ?? null;
}

async function clear(): Promise<void> {
  await database.pool.query('DELETE FROM archive_jobs');
  await database.pool.query('DELETE FROM archive_stamp_purchases');
  await database.pool.query('DELETE FROM stream_archives');
  await database.pool.query('DELETE FROM archive_rate');
  await database.pool.query('DELETE FROM stream_exports');
  await database.pool.query('DELETE FROM catalogue_stamp');
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  archives = new ArchiveRepository(database.pool);
  exportsStore = new ExportRepository(database.pool);
  streams = new StreamRepository(database.pool);
  const row = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb') RETURNING id`,
    [`itest-${randomUUID().slice(0, 8)}`],
  );
  userId = row.rows[0]!.id;
});

beforeEach(clear);

after(async () => {
  if (database) {
    await clear();
    await database.pool.query('DELETE FROM streams WHERE user_id = $1', [userId]);
    await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await database.close();
  }
  await releaseStack();
});

describe('ArchiveRepository', () => {
  it('holds one archive at a time, two starts at once leaving one, and replaces a done one', async () => {
    const streamId = await stream('itest archive');
    const [first, second] = await Promise.all([
      archives.createJob(newJob(streamId)),
      archives.createJob(newJob(streamId)),
    ]);
    const made = [first, second].filter((created) => 'row' in created);
    assert.equal(made.length, 1);
    assert.deepEqual(
      [first, second].find((created) => 'refused' in created),
      { refused: 'archive' },
    );
    const job = (made[0] as { row: { id: string } }).row;
    assert.equal((await archives.items(job.id)).length, 2);

    await archives.transition(job.id, ['measuring'], { state: 'copying' });
    await archives.transition(job.id, ['copying'], { state: 'verifying' });
    const done = await archives.transition(job.id, ['verifying'], { state: 'done' });
    assert.ok(done?.finished_at);
    const next = await archives.createJob(newJob(streamId));
    assert.ok('row' in next, 'a done archive gives way to the next');
    assert.equal((await database.pool.query('SELECT 1 FROM archive_jobs')).rowCount, 1);
  });

  it('never lets an archive and an export hold the place together', async () => {
    const streamId = await stream('itest place');
    assert.ok(await startExport(streamId));
    assert.deepEqual(await archives.createJob(newJob(streamId)), { refused: 'export' });

    await database.pool.query(
      `UPDATE stream_exports SET state = 'done', finished_at = NOW(), file_name = 'x.mp4', size_bytes = 1`,
    );
    const created = await archives.createJob(newJob(streamId));
    assert.ok('row' in created, 'a kept export file holds no place');
    assert.equal(await startExport(streamId), null, 'an archive measuring holds the place');

    await archives.transition(created.row.id, ['measuring'], { state: 'copying' });
    assert.equal(await startExport(streamId), null, 'an archive copying holds the place');
    await archives.transition(created.row.id, ['copying'], {
      state: 'paused',
      pauseReason: 'batch',
      pauseMessage: 'The archive stamp is full.',
    });
    assert.equal(await startExport(streamId), null, 'a pause that needs a decision keeps the place');
  });

  it('gives the place up while a purchase waits and on a user pause, and takes it again only when it is free', async () => {
    const streamId = await stream('itest give up');
    const created = await archives.createJob(newJob(streamId, { batchId: null, buyNew: true }));
    assert.ok('row' in created);
    const id = created.row.id;
    await archives.transition(id, ['measuring'], { state: 'awaiting_purchase', chunksTotal: 1000 });
    assert.ok(await startExport(streamId), 'an archive waiting for a purchase confirm gives the place up');
    assert.deepEqual(await archives.transitionTakingPlace(id, ['awaiting_purchase'], { state: 'buying' }), {
      refused: 'export',
    });
    await database.pool.query('DELETE FROM stream_exports');
    const buying = await archives.transitionTakingPlace(id, ['awaiting_purchase'], { state: 'buying' });
    assert.ok(buying && !('refused' in buying) && buying.state === 'buying');

    await archives.transition(id, ['buying'], { state: 'copying', batchId: BATCH, buyNew: false });
    await archives.transition(id, ['copying'], { state: 'paused', pauseReason: 'user', pauseMessage: 'Paused.' });
    assert.ok(await startExport(streamId), 'a user pause gives the place up');
    assert.deepEqual(await archives.transitionTakingPlace(id, ['paused'], { state: 'copying' }), {
      refused: 'export',
    });
  });

  it('moves only from the states named, with a reason while paused and only then', async () => {
    const streamId = await stream('itest moves');
    const created = await archives.createJob(newJob(streamId));
    assert.ok('row' in created);
    const id = created.row.id;
    assert.equal(await archives.transition(id, ['copying'], { state: 'verifying' }), null);
    const paused = await archives.transition(id, ['measuring'], {
      state: 'paused',
      pauseReason: 'unreadable',
      pauseMessage: 'Two segments could not be read.',
    });
    assert.equal(paused?.pause_reason, 'unreadable');
    assert.ok(paused?.paused_at);
    const resumed = await archives.transition(id, ['paused'], { state: 'copying' });
    assert.equal(resumed?.pause_reason, null);
    assert.equal(resumed?.pause_message, null);
    await assert.rejects(
      () => archives.transition(id, ['copying'], { state: 'copying', batchId: null }),
      /archive_jobs_target|archive_jobs_copy_needs_stamp/,
      'a job copies onto a stamp',
    );
  });

  it('keeps the resume ledger with the counters, and forgets it when a quality starts over', async () => {
    const streamId = await stream('itest ledger');
    const created = await archives.createJob(newJob(streamId));
    assert.ok('row' in created);
    const id = created.row.id;
    const reference = 'c'.repeat(64);
    await archives.updateItem(id, '720p', { state: 'copying', tagUid: 17, chunksTotal: 900 });
    await archives.recordSegment(
      id,
      '720p',
      { reference, chunks: 300, bytes: 1_200_000, parityMissing: 1 },
      { segmentsDone: 1, chunksCopied: 300, postsUnderTag: 302, parityMissing: 1 },
    );
    await archives.recordSegment(
      id,
      '720p',
      { reference, chunks: 300, bytes: 1_200_000, parityMissing: 0 },
      { segmentsDone: 1, chunksCopied: 300, postsUnderTag: 604, parityMissing: 0 },
    );
    assert.deepEqual([...(await archives.segmentsDone(id, '720p'))], [reference]);
    const item = (await archives.items(id)).find((row) => row.rendition === '720p')!;
    assert.equal(item.posts_under_tag, 604, 'a segment copied again counts its posts again');
    await archives.updateItem(id, '720p', { chunksSynced: 590, chunksSeen: 14 });
    const read = (await archives.items(id)).find((row) => row.rendition === '720p')!;
    assert.deepEqual([read.chunks_synced, read.chunks_seen], [590, 14]);
    assert.equal(item.tag_uid, 17);
    assert.equal(item.chunks_total, 900);
    await archives.clearSegments(id, '720p');
    assert.equal((await archives.segmentsDone(id, '720p')).size, 0);
  });

  it("writes a quality's copy as partial, completes it, and keeps a copy for each stamp it is made onto", async () => {
    const streamId = await stream('itest copies');
    const copy = {
      stream_id: streamId,
      rendition: '720p',
      batch_id: BATCH,
      feed_owner: OWNER,
      feed_topic: randomUUID(),
      manifest_index: 5,
      parity_missing: 0,
      segments: 0,
      chunks: 0,
      bytes: 0,
      chunks_rebuilt: 0,
      bucket_sum_before: 10,
      bucket_sum_after: null,
      bzz_spent_estimate_plur: null,
    };
    const on = async (batchId: string) =>
      (await archives.archivesOf([streamId])).find((row) => row.rendition === '720p' && row.batch_id === batchId);
    await archives.startArchive(copy);
    await archives.saveArchive(streamId, '720p', BATCH, { chunks: 900, bytes: 3_600_000, bucket_sum_after: 910 });
    await archives.completeArchive(streamId, '720p', BATCH, userId, 'itest');
    let row = await on(BATCH);
    assert.equal(row?.state, 'complete');
    assert.equal(row?.chunks, 900);
    assert.equal(row?.completed_by, 'itest');

    // A further copy onto another stamp is a row of its own, and the first stays complete while it runs and after.
    await archives.startArchive({ ...copy, batch_id: OTHER });
    assert.equal((await archives.archivesOf([streamId])).length, 2);
    assert.equal((await on(OTHER))?.state, 'partial');
    assert.equal((await on(BATCH))?.state, 'complete');
    await archives.saveArchive(streamId, '720p', OTHER, { chunks: 450 });
    await archives.completeArchive(streamId, '720p', OTHER, null, 'itest two');
    assert.deepEqual([(await on(OTHER))?.chunks, (await on(OTHER))?.completed_by], [450, 'itest two']);
    assert.deepEqual([(await on(BATCH))?.chunks, (await on(BATCH))?.completed_by], [900, 'itest']);

    // Made again onto a stamp, after the stream recorded again, the copy takes that stamp's row alone.
    await archives.startArchive({ ...copy, manifest_index: 9 });
    assert.equal((await archives.archivesOf([streamId])).length, 2);
    row = await on(BATCH);
    assert.equal(row?.state, 'partial');
    assert.equal(row?.manifest_index, 9);
    assert.equal(row?.completed_at, null);
    assert.equal(row?.chunks, 0);
    assert.equal((await on(OTHER))?.state, 'complete');
  });

  it("records the stream's image under a stamp, one for each stream and stamp, the later image taking the row", async () => {
    const streamId = await stream('itest thumbnails');
    const other = await stream('itest thumbnails two');
    const image = {
      stream_id: streamId,
      batch_id: BATCH,
      thumbnail_ref: 'f'.repeat(64),
      stamped_by_user_id: userId,
      stamped_by: 'itest',
    };
    assert.deepEqual(await archives.thumbnailsOf([streamId]), []);
    await archives.recordThumbnail(image);
    await archives.recordThumbnail({ ...image, batch_id: OTHER });
    await archives.recordThumbnail({ ...image, stream_id: other, stamped_by_user_id: null });
    const own = await archives.thumbnailsOf([streamId]);
    assert.deepEqual(own.map((row) => row.batch_id).sort(), [BATCH, OTHER]);
    assert.ok(own.every((row) => row.thumbnail_ref === 'f'.repeat(64) && row.stamped_at instanceof Date));

    await archives.recordThumbnail({ ...image, thumbnail_ref: 'e'.repeat(64), stamped_by: 'itest two' });
    const again = (await archives.thumbnailsOf([streamId])).find((row) => row.batch_id === BATCH);
    assert.deepEqual([again?.thumbnail_ref, again?.stamped_by], ['e'.repeat(64), 'itest two']);
    assert.equal((await archives.thumbnailsOf([streamId])).length, 2);
    assert.ok((await archives.thumbnailsOf(null)).some((row) => row.stream_id === other));

    await database.pool.query('DELETE FROM streams WHERE id = $1', [other]);
    assert.equal((await archives.thumbnailsOf([other])).length, 0, 'deleting the stream deletes its rows');
  });

  it("gives a copy its stamp's end as each catalogue stamp record arrives, from the latest reading only", async () => {
    const catalogue = new CatalogueStampRepository(database.pool);
    const streamId = await stream('itest stamp ends');
    const copy = {
      stream_id: streamId,
      rendition: '720p',
      batch_id: BATCH,
      feed_owner: OWNER,
      feed_topic: randomUUID(),
      manifest_index: 5,
      parity_missing: 0,
      segments: 0,
      chunks: 0,
      bytes: 0,
      chunks_rebuilt: 0,
      bucket_sum_before: null,
      bucket_sum_after: null,
      bzz_spent_estimate_plur: null,
    };
    await archives.startArchive(copy);
    await archives.startArchive({ ...copy, rendition: '360p', batch_id: OTHER });
    const endOf = async (rendition: string, batchId = rendition === '720p' ? BATCH : OTHER) =>
      (await archives.archivesOf([streamId]))
        .find((row) => row.rendition === rendition && row.batch_id === batchId)
        ?.stamp_expires_at?.toISOString() ?? null;
    const arrive = (time: string, ...batches: CatalogueArchiveBatch[]) =>
      catalogue.upsert(catalogueStampRecord({ observedAt: `2030-01-01T${time}.000Z`, archiveBatches: batches }));
    assert.equal(await endOf('720p'), null, 'no end before a record lists the stamp');

    await arrive('10:00:00', archiveBatch(BATCH, { ttlSeconds: 10 * 86_400 }));
    assert.equal(await endOf('720p'), '2030-01-11T10:00:00.000Z');
    assert.equal(await endOf('360p'), null, 'a copy on a stamp the record does not list keeps what it had');

    assert.equal(await arrive('09:00:00', archiveBatch(BATCH, { ttlSeconds: 86_400 })), null, 'kept out');
    assert.equal(await endOf('720p'), '2030-01-11T10:00:00.000Z', 'an older record changes no copy');

    await arrive('11:00:00', archiveBatch(BATCH, { ttlSeconds: 2 * 86_400 }));
    assert.equal(await endOf('720p'), '2030-01-03T11:00:00.000Z', 'a later reading wins, sooner after a dilution');

    await arrive('12:00:00', archiveBatch(OTHER, { ttlSeconds: 86_400 }));
    assert.equal(await endOf('720p'), '2030-01-03T11:00:00.000Z', 'kept once the record lists the stamp no longer');
    assert.equal(await endOf('360p'), '2030-01-02T12:00:00.000Z');

    await arrive('13:00:00', archiveBatch(OTHER, { state: 'expired', ttlSeconds: 0 }));
    assert.equal(await endOf('360p'), '2030-01-01T13:00:00.000Z', 'an expired stamp ends at its reading');

    await archives.startArchive({ ...copy, manifest_index: 9 });
    assert.equal(await endOf('720p'), '2030-01-03T11:00:00.000Z', 'made again on the same stamp, the end stays');
    await archives.startArchive({ ...copy, batch_id: OTHER });
    assert.equal(await endOf('720p', OTHER), null, 'a copy onto another stamp waits for a record to give its end');
    assert.equal(await endOf('720p'), '2030-01-03T11:00:00.000Z', 'and the copy on the first stamp keeps its own');
    await arrive('14:00:00', archiveBatch(OTHER, { ttlSeconds: 86_400 }));
    assert.equal(await endOf('720p', OTHER), '2030-01-02T14:00:00.000Z', 'every copy on a stamp takes its end');
    assert.equal(await endOf('360p'), '2030-01-02T14:00:00.000Z');
  });

  it('keeps one purchase under way at a time, and marks one sent or never received', async () => {
    const purchase = {
      depth: 20,
      days: 30,
      amountPerChunkPlur: '12441600000',
      costPlur: '13045726248960000',
      label: 'archive one',
      startedByUserId: userId,
      startedBy: 'itest',
    };
    const first = await archives.createPurchase({ id: randomUUID(), ...purchase });
    assert.ok(first);
    assert.equal(await archives.createPurchase({ id: randomUUID(), ...purchase }), null);
    const sent = await archives.updatePurchase(first.id, { relayed: true });
    assert.ok(sent?.relayed_at);
    const again = await archives.updatePurchase(first.id, { relayed: true });
    assert.equal(again?.relayed_at?.getTime(), sent.relayed_at.getTime(), 'the first moment is kept');
    assert.equal((await archives.updatePurchase(first.id, { relayed: false }))?.relayed_at, null);
    const usable = await archives.updatePurchase(first.id, { state: 'usable', batchId: 'd'.repeat(64) });
    assert.equal(usable?.state, 'usable');
    assert.ok(await archives.createPurchase({ id: randomUUID(), ...purchase }), 'the next once it is settled');
    assert.equal((await archives.listPurchases(10))[0]?.state, 'buying', 'the one under way first');
  });

  it('turns the listing switch, keeps the last rate, and closes a finished widget for one user', async () => {
    const streamId = await stream('itest switch');
    assert.equal(await archives.setArchivedOnly(streamId, true), true);
    assert.equal((await streams.findById(streamId))?.archived_only, true);
    await archives.saveRate(150.5);
    await archives.saveRate(140);
    assert.equal(await archives.lastRate(), 140);

    const created = await archives.createJob(newJob(streamId));
    assert.ok('row' in created);
    assert.equal(await archives.dismiss(created.row.id, userId), false, 'only a finished archive');
    await archives.transition(created.row.id, ['measuring'], { state: 'copying' });
    await archives.transition(created.row.id, ['copying'], { state: 'verifying' });
    await archives.transition(created.row.id, ['verifying'], { state: 'done' });
    assert.equal(await archives.dismiss(created.row.id, userId), true);
    assert.equal((await archives.viewJob(userId))?.dismissed, true);
    assert.equal((await archives.viewJob(null))?.dismissed, false);
  });
});
