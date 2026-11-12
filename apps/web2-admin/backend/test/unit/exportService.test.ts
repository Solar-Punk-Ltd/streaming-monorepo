import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ExportService, type ExportServiceOptions } from '../../src/domain/export/ExportService.js';
import type { CatalogueTarget } from '../../src/domain/FeedGateway.js';
import type { StreamRenditionRow, StreamRow } from '../../src/types/index.js';
import {
  FakeJoiner,
  FakeRenditions,
  FakeSource,
  FakeStreams,
  InMemoryExportStore,
  playlistOf,
  ref,
} from './support/exportFakes.js';
import { InMemoryAuditLog, streamRow, TEST_OPERATOR } from './support/fakes.js';

const OTHER_OPERATOR = {
  kind: 'operator',
  userId: '00000000-0000-4000-8000-000000000002',
  username: 'other-operator',
} as const;

const NODE: CatalogueTarget = { beeApiUrl: 'http://catalogue-node.test:1633', batchId: 'b'.repeat(64) };

const RUNG_1080 = '9a7b6c5d-1111-5222-8333-444455556666';
const RUNG_720 = '9a7b6c5d-1111-5222-8333-777788889999';

let dir: string;
let streams: FakeStreams;
let renditions: FakeRenditions;
let store: InMemoryExportStore;
let source: FakeSource;
let joiner: FakeJoiner;
let audit: InMemoryAuditLog;
let free: number;
let total: number;
let target: CatalogueTarget | null;
let service: ExportService;

function makeService(over: Partial<ExportServiceOptions> = {}): ExportService {
  return new ExportService(store, streams, renditions, { forRead: async () => ({ target }) }, source, joiner, audit, {
    dir,
    parallelReads: 3,
    retryDelaysMs: [1],
    statusCheckMs: 0,
    progressSaveMs: 0,
    keepFreeFraction: 0,
    disk: { space: async () => ({ free, total }) },
    ...over,
  });
}

/** A recorded stream with a 1080p and a 720p rung, each five segments long. */
function recordedLadder(): StreamRow {
  const stream = streamRow({
    status: 'vod',
    manifest_index: 3,
    duration_seconds: 10,
    live_since: new Date('2026-11-05T09:30:00.000Z'),
    title: 'Opening keynote',
  });
  streams.rows.set(stream.id, stream);
  const rung = (name: string, topic: string, height: number, avg: number): StreamRenditionRow => ({
    stream_id: stream.id,
    name,
    width: Math.round((height * 16) / 9),
    height,
    topic,
    bandwidth: avg * 2,
    avg_bandwidth: avg,
    manifest_index: 4,
    duration_seconds: 10,
    updated_at: new Date(),
  });
  renditions.rows.set(stream.id, [rung('720p', RUNG_720, 720, 2_000_000), rung('1080p', RUNG_1080, 1080, 4_000_000)]);
  const refs = [1, 2, 3, 4, 5].map(ref);
  source.playlist(RUNG_1080, 4, playlistOf(refs));
  refs.forEach((reference) => source.segment(reference));
  return stream;
}

async function folderNames(): Promise<string[]> {
  return (await readdir(dir)).sort();
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'export-service-test-'));
  streams = new FakeStreams();
  renditions = new FakeRenditions();
  store = new InMemoryExportStore(streams);
  source = new FakeSource();
  joiner = new FakeJoiner();
  audit = new InMemoryAuditLog();
  free = 100e9;
  total = 1e12;
  target = NODE;
  service = makeService();
});

afterEach(async () => {
  await service.shutdown();
  await rm(dir, { recursive: true, force: true });
});

describe('ExportService', () => {
  it('exports every segment of the chosen quality into one MP4 named by title, day and quality', async () => {
    const stream = recordedLadder();

    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    assert.equal(started.state, 'reading');
    assert.equal(started.startedByYou, true);
    await service.settled();

    const done = await service.current(TEST_OPERATOR.userId);
    assert.equal(done?.state, 'done');
    assert.equal(done?.fileName, 'opening-keynote-2026-11-05-1080p.mp4');
    assert.equal(done?.partial, false);
    assert.equal(done?.segmentsRead, 5);
    assert.deepEqual(done?.actions, ['dismiss', 'clear']);
    // One run, in the playlist's order, and nothing left but the MP4.
    assert.equal(joiner.joins.length, 1);
    assert.deepEqual(
      joiner.joins[0]!.map((run) => run.files.map((file) => path.basename(file, '.ts'))),
      [[1, 2, 3, 4, 5].map(ref)],
    );
    assert.deepEqual(await readdir(path.join(dir, done!.id)), ['export.mp4']);
    const file = await service.file(done!.id);
    assert.equal(file.fileName, 'opening-keynote-2026-11-05-1080p.mp4');
    assert.equal((await stat(file.path)).size, done?.sizeBytes);
    assert.deepEqual(
      audit.entries.map((entry) => entry.action),
      ['export.start', 'export.done'],
    );
  });

  it('offers the qualities highest first, estimated from bitrate and length, and says why none can start', async () => {
    const stream = recordedLadder();

    const options = await service.optionsFor(stream.id, TEST_OPERATOR.userId);
    assert.deepEqual(
      options.qualities.map((quality) => [quality.rendition, quality.estimatedBytes, quality.unavailable]),
      [
        ['1080p', 5_000_000, null],
        ['720p', 2_500_000, null],
      ],
    );
    assert.equal(options.date, '2026-11-05');
    assert.equal(options.refusal, null);

    joiner.problem = 'ffmpeg is missing';
    assert.equal((await makeService().optionsFor(stream.id, null)).refusal?.problem, 'no_ffmpeg');
    joiner.problem = null;
    target = null;
    assert.equal((await makeService().optionsFor(stream.id, null)).refusal?.problem, 'no_node');
    target = NODE;
    streams.rows.set(stream.id, { ...stream, status: 'live' });
    assert.equal((await makeService().optionsFor(stream.id, null)).refusal?.problem, 'not_recording');
  });

  it('refuses a second export, of any stream, while one holds the slot', async () => {
    const first = recordedLadder();
    const second = recordedLadder();
    let open!: () => void;
    source.gate = new Promise((resolve) => (open = resolve));

    await service.start(TEST_OPERATOR, first.id, '1080p');
    await assert.rejects(service.start(OTHER_OPERATOR, second.id, '720p'), { problem: 'busy' });
    const options = await service.optionsFor(second.id, OTHER_OPERATOR.userId);
    assert.equal(options.refusal?.problem, 'busy');
    assert.equal(options.current?.startedByYou, false);
    open();
    await service.settled();
  });

  it('pauses with the count when segments cannot be read, and tries only those again on resume', async () => {
    const stream = recordedLadder();
    source.failing.add(ref(3));

    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    const paused = await service.current(TEST_OPERATOR.userId);
    assert.equal(paused?.state, 'paused');
    assert.equal(paused?.pauseReason, 'unreadable');
    assert.match(paused?.pauseMessage ?? '', /^1 of 5 segments could not be read from Swarm\./);
    assert.deepEqual(paused?.actions, ['resume', 'save', 'cancel']);

    source.failing.clear();
    await service.act(TEST_OPERATOR, paused!.id, 'resume');
    await service.settled();
    assert.equal((await service.current(null))?.state, 'done');
    // Every segment read once: the four from the first pass were not read again.
    assert.deepEqual([...source.reads.values()], [1, 1, 1, 1, 1]);
  });

  it('saves what was read as a partial MP4, cut where a segment is missing', async () => {
    const stream = recordedLadder();
    source.failing.add(ref(2));

    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    const paused = await service.current(TEST_OPERATOR.userId);
    await service.act(OTHER_OPERATOR, paused!.id, 'save');
    await service.settled();

    const done = await service.current(TEST_OPERATOR.userId);
    assert.equal(done?.state, 'done');
    assert.equal(done?.partial, true);
    assert.equal(done?.fileName, 'opening-keynote-2026-11-05-1080p-partial.mp4');
    assert.equal(joiner.joins[0]!.length, 2);
    assert.deepEqual(
      audit.entries.map((entry) => entry.action),
      ['export.start', 'export.paused', 'export.save', 'export.done'],
    );
  });

  it('pauses when the stream goes live, waits, then carries on with the new recording', async () => {
    const stream = recordedLadder();
    source.afterRead = (count) => {
      if (count === 2) streams.rows.set(stream.id, { ...streams.rows.get(stream.id)!, status: 'live' });
    };
    service = makeService({ parallelReads: 1 });

    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    const paused = await service.current(TEST_OPERATOR.userId);
    assert.equal(paused?.pauseReason, 'live');
    assert.deepEqual(paused?.actions, ['save', 'wait', 'cancel']);

    await service.act(TEST_OPERATOR, paused!.id, 'wait');
    assert.equal((await service.current(null))?.state, 'waiting');

    // The broadcast ends again: a new playlist carries the first session and the second.
    source.afterRead = null;
    const second = [6, 7].map(ref);
    second.forEach((reference) => source.segment(reference));
    source.playlist(RUNG_1080, 9, playlistOf([...[1, 2, 3, 4, 5].map(ref), ...second], [5]));
    streams.rows.set(stream.id, { ...streams.rows.get(stream.id)!, status: 'vod', manifest_index: 8 });
    renditions.rows.set(
      stream.id,
      renditions.rows.get(stream.id)!.map((rung) => ({ ...rung, manifest_index: 9 })),
    );
    await service.tick();
    await service.settled();

    const done = await service.current(null);
    assert.equal(done?.state, 'done');
    assert.equal(done?.segmentsRead, 7);
    assert.equal(done?.partial, false);
    assert.equal(source.reads.get(ref(1)), 1);
    assert.equal(source.reads.get(ref(7)), 1);
    // The seam between the sessions is a cut between two runs.
    assert.equal(joiner.joins.at(-1)!.length, 2);
  });

  it('stops its own join when the stream goes live, and finishes the one a user chose to save', async () => {
    const stream = recordedLadder();
    // The stream goes live while ffmpeg runs, which runs until something stops it.
    joiner.during = async (signal) => {
      streams.rows.set(stream.id, { ...streams.rows.get(stream.id)!, status: 'live' });
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    const paused = await service.current(TEST_OPERATOR.userId);
    assert.equal(paused?.state, 'paused');
    assert.equal(paused?.pauseReason, 'live');
    assert.equal(paused?.segmentsRead, 5);
    assert.equal(joiner.stopped, 1);
    // No file is kept as if the recording had finished, and every segment read stays for later.
    const kept = await readdir(path.join(dir, paused!.id));
    assert.ok(!kept.includes('export.mp4') && !kept.includes('export.tmp.mp4'));
    assert.equal((await readdir(path.join(dir, paused!.id, 'segments'))).length, 5);

    // Save what was read is the user's answer to exactly that, so it finishes while the stream is still live.
    joiner.during = null;
    await service.act(TEST_OPERATOR, paused!.id, 'save');
    await service.settled();
    assert.equal((await service.current(null))?.state, 'done');
  });

  it('keeps no file when the stream went live just as ffmpeg finished', async () => {
    const stream = recordedLadder();
    joiner.during = async () => {
      streams.rows.set(stream.id, { ...streams.rows.get(stream.id)!, status: 'live' });
    };

    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    const paused = await service.current(null);
    assert.equal(paused?.pauseReason, 'live');
    assert.equal(joiner.stopped, 0);
    const kept = await readdir(path.join(dir, paused!.id));
    assert.ok(!kept.includes('export.mp4') && !kept.includes('export.tmp.mp4'));
  });

  it('pauses at boot a join the last process left, when the stream has gone live since', async () => {
    const stream = recordedLadder();
    joiner.during = (signal) =>
      new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    await service.start(TEST_OPERATOR, stream.id, '1080p');
    while ((await store.get())?.state !== 'joining') await new Promise((resolve) => setTimeout(resolve, 5));
    await service.shutdown();
    assert.equal((await store.get())?.state, 'joining');

    joiner.during = null;
    streams.rows.set(stream.id, { ...streams.rows.get(stream.id)!, status: 'live' });
    service = makeService();
    await service.boot();
    await service.settled();
    assert.equal((await service.current(null))?.pauseReason, 'live');
  });

  it('stops reading on Pause, and carries on where it stopped on Resume', async () => {
    const stream = recordedLadder();
    let open!: () => void;
    source.gate = new Promise((resolve) => (open = resolve));

    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    const paused = await service.act(OTHER_OPERATOR, started.id, 'pause');
    assert.equal(paused?.pauseReason, 'user');
    assert.equal(paused?.pauseMessage, 'Paused by other-operator.');
    open();
    await service.settled();
    assert.equal((await service.current(null))?.state, 'paused');

    source.gate = null;
    await service.act(TEST_OPERATOR, started.id, 'resume');
    await service.settled();
    assert.equal((await service.current(null))?.state, 'done');
  });

  it('deletes the export and everything it read on Cancel', async () => {
    const stream = recordedLadder();
    source.failing.add(ref(5));
    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    assert.deepEqual(await folderNames(), [started.id]);

    assert.equal(await service.act(TEST_OPERATOR, started.id, 'cancel'), null);
    assert.equal(await service.current(null), null);
    assert.deepEqual(await folderNames(), []);
    assert.equal(audit.withAction('export.cancel').length, 1);
  });

  it('replaces the kept export when another starts, and deletes its file', async () => {
    const stream = recordedLadder();
    const first = await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();

    source.playlist(RUNG_720, 4, playlistOf([1, 2].map(ref)));
    const second = await service.start(OTHER_OPERATOR, stream.id, '720p');
    await service.settled();

    assert.notEqual(second.id, first.id);
    assert.deepEqual(await folderNames(), [second.id]);
    assert.equal((await service.current(null))?.fileName, 'opening-keynote-2026-11-05-720p.mp4');
    await assert.rejects(service.file(first.id), { name: 'ExportNotFoundError' });
  });

  it('keeps a tenth of the disk free, and refuses a start that would need it', async () => {
    const stream = recordedLadder();
    // The default share: 2 MB of a 20 MB disk stays free, so 11 MB free leaves 9 MB for an export of about 10 MB.
    service = makeService({ keepFreeFraction: undefined });
    total = 20_000_000;
    free = 11_000_000;

    await assert.rejects(service.start(TEST_OPERATOR, stream.id, '1080p'), {
      problem: 'disk',
      message:
        'The server has 11 MB free and keeps 2 MB of it free, 10% of its disk. This export needs about 10 MB while it runs: the segments and the MP4.',
    });
    assert.equal(await service.current(null), null);

    free = 12_000_000;
    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    assert.equal((await service.current(null))?.state, 'done');
  });

  it('pauses when the free disk falls under the share it keeps, and resumes once there is room', async () => {
    const stream = recordedLadder();
    total = 100_000_000;
    free = 50_000_000;
    service = makeService({ keepFreeFraction: 0.1, parallelReads: 1 });
    source.afterRead = (count) => {
      if (count === 2) free = 5_000_000;
    };

    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    const paused = await service.current(null);
    assert.equal(paused?.pauseReason, 'disk');
    assert.match(paused?.pauseMessage ?? '', /keeps 10 MB free, 10% of its disk/);
    assert.deepEqual(paused?.actions, ['resume', 'cancel']);

    source.afterRead = null;
    free = 50_000_000;
    await service.act(TEST_OPERATOR, paused!.id, 'resume');
    await service.settled();
    assert.equal((await service.current(null))?.state, 'done');
  });

  it('stops the join when the free disk falls under the share it keeps, and joins once there is room', async () => {
    const stream = recordedLadder();
    total = 100_000_000;
    free = 50_000_000;
    service = makeService({ keepFreeFraction: 0.1 });
    // Another workload takes the room while ffmpeg runs, which runs until something stops it.
    joiner.during = async (signal) => {
      free = 5_000_000;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    const paused = await service.current(null);
    assert.equal(paused?.pauseReason, 'disk');
    assert.match(paused?.pauseMessage ?? '', /so joining stopped/);
    assert.equal(joiner.stopped, 1);
    assert.equal((await readdir(path.join(dir, paused!.id, 'segments'))).length, 5);

    joiner.during = null;
    free = 50_000_000;
    await service.act(TEST_OPERATOR, paused!.id, 'resume');
    await service.settled();
    assert.equal((await service.current(null))?.state, 'done');
  });

  it('pauses on the disk, not as a problem, when ffmpeg runs out of room', async () => {
    const stream = recordedLadder();
    joiner.during = async () => {
      throw new Error('ffmpeg exited with code 1: av_interleaved_write_frame(): No space left on device');
    };

    await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    const paused = await service.current(null);
    assert.equal(paused?.pauseReason, 'disk');
    assert.deepEqual(paused?.actions, ['resume', 'cancel']);
  });

  it('names a single-quality recording by the height of its video, estimated from its first segment', async () => {
    const stream = streamRow({
      status: 'vod',
      manifest_index: 2,
      duration_seconds: 6,
      live_since: new Date('2026-11-06T08:00:00.000Z'),
      title: 'Ünïcode & Friends: Day 2!',
    });
    streams.rows.set(stream.id, stream);
    const refs = [11, 12, 13].map(ref);
    source.playlist(stream.topic, 2, playlistOf(refs));
    refs.forEach((reference) => source.segment(reference, 'x'.repeat(100)));

    const options = await service.optionsFor(stream.id, null);
    assert.deepEqual(
      options.qualities.map((quality) => [quality.rendition, quality.label, quality.estimatedBytes]),
      [['source', 'Source', 300]],
    );
    await service.start(TEST_OPERATOR, stream.id, 'source');
    await service.settled();
    const done = await service.current(null);
    assert.equal(done?.quality, '720p');
    assert.equal(done?.fileName, 'unicode-friends-day-2-2026-11-06-720p.mp4');
  });

  it('closes the widget of a finished export for the user who closes it only', async () => {
    const stream = recordedLadder();
    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();

    const closed = await service.act(TEST_OPERATOR, started.id, 'dismiss');
    assert.equal(closed?.dismissed, true);
    // Closing the widget keeps the file, so it can still be cleared.
    assert.deepEqual(closed?.actions, ['clear']);
    const other = await service.current(OTHER_OPERATOR.userId);
    assert.equal(other?.dismissed, false);
    assert.deepEqual(other?.actions, ['dismiss', 'clear']);
  });

  it('clears the kept file for everyone, so the same quality can be exported again, and never a running one', async () => {
    const stream = recordedLadder();
    const first = await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();

    assert.equal(await service.act(TEST_OPERATOR, first.id, 'clear'), null);
    assert.equal(await service.current(OTHER_OPERATOR.userId), null);
    assert.deepEqual(await folderNames(), []);
    assert.ok(audit.entries.some((entry) => entry.action === 'export.clear'));

    // The same quality starts again, and while it runs it can be cancelled but not cleared.
    let open!: () => void;
    source.gate = new Promise((resolve) => (open = resolve));
    const again = await service.start(TEST_OPERATOR, stream.id, '1080p');
    await assert.rejects(service.act(TEST_OPERATOR, again.id, 'clear'), { problem: 'not_now' });
    open();
    source.gate = null;
    await service.settled();
    assert.equal((await service.current(null))?.state, 'done');
  });

  it('refuses an action the export is not in a state for', async () => {
    const stream = recordedLadder();
    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();

    await assert.rejects(service.act(TEST_OPERATOR, started.id, 'pause'), { problem: 'not_now' });
    await assert.rejects(service.act(TEST_OPERATOR, '11111111-2222-4333-8444-555555555555', 'pause'), {
      name: 'ExportNotFoundError',
    });
  });

  it('deletes, at boot, the folders of exports that are gone and nothing else', async () => {
    const gone = '11111111-2222-4333-8444-555555555555';
    await mkdir(path.join(dir, gone, 'segments'), { recursive: true });
    await mkdir(path.join(dir, 'not-an-export'));

    await service.boot();

    assert.deepEqual(await folderNames(), ['not-an-export']);
  });

  it('clears away, at its next look, the files of an export deleted with its stream', async () => {
    const stream = recordedLadder();
    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    assert.deepEqual(await folderNames(), [started.id]);

    // Deleting the stream deletes the export's row in the database; its file stays until the watcher looks.
    streams.rows.delete(stream.id);
    await store.remove(started.id);
    await service.tick();
    assert.deepEqual(await folderNames(), []);
  });

  it('stops the job of an export deleted with its stream while it reads, then clears its files away', async () => {
    const stream = recordedLadder();
    let open!: () => void;
    source.gate = new Promise((resolve) => (open = resolve));
    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    while ((await folderNames()).length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    streams.rows.delete(stream.id);
    await store.remove(started.id);
    const looked = service.tick();
    open();
    await looked;
    await service.settled();
    assert.deepEqual(await folderNames(), []);
  });

  it('counts the folders a start deletes as free room, a deleted export’s leftovers included', async () => {
    const stream = recordedLadder();
    // As in the test above: 2 MB of a 20 MB disk stay free, and the export needs about 10 MB.
    service = makeService({ keepFreeFraction: undefined });
    total = 20_000_000;
    free = 11_000_000;
    // 2 MB left by an export whose stream was deleted before the watcher looked: the start deletes them, so they count.
    const leftover = path.join(dir, '11111111-2222-4333-8444-555555555555');
    await mkdir(leftover);
    await writeFile(path.join(leftover, 'export.mp4'), Buffer.alloc(2_000_000));

    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    await service.settled();
    assert.equal((await service.current(null))?.state, 'done');
    assert.deepEqual(await folderNames(), [started.id]);
  });

  it('carries on at boot with an export the last process left reading', async () => {
    const stream = recordedLadder();
    let open!: () => void;
    source.gate = new Promise((resolve) => (open = resolve));
    const started = await service.start(TEST_OPERATOR, stream.id, '1080p');
    const stopped = service.shutdown();
    open();
    await stopped;
    assert.equal((await store.get())?.state, 'reading');

    source.gate = null;
    service = makeService();
    await service.boot();
    await service.settled();
    assert.equal((await service.current(null))?.id, started.id);
    assert.equal((await service.current(null))?.state, 'done');
  });
});
