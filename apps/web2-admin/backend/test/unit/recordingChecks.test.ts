/**
 * Checking the recordings and removing the lost ones. Unit test: RecordingCheckService over the stores in memory and
 * a node a test sets. `pnpm test`.
 *
 * Pinned here (docs/architecture/web2-admin.md, "Lost recordings"): every recording the one rule lets a check judge is
 * read, and only what failed is read again, so only a failure in each of three rounds counts, and a part of a ladder
 * that failed alone is partly lost; a check starts, and goes on, only while the catalogue node has 4 peers or more,
 * and stops with no result otherwise; a stream that went live meanwhile is left unjudged; a boot stops a check the last
 * process ran; and a removal asks each recording the rule again and reads it once more, takes the rest off the
 * catalogue in one write, deletes them or, for an export file kept on the server, leaves a draft, audits each, and
 * refuses another list, an old check, and a catalogue that cannot be written.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import type { ArchiveJobSummary, ExportSummary } from '@streaming-monorepo/web2-admin-common';

import { toStream } from '../../src/api/presenters.js';
import { recordingJobsOf } from '../../src/domain/recordings/index.js';
import {
  ADMIN_RESTARTED,
  catalogueNotWritable,
  CHECK_RUNNING,
  CHECK_TOO_OLD,
  KEPT_BY_RULE,
  NO_RECORDING_NOW,
  noCatalogueNode,
  nodeFailedDuringRemoval,
  NONE_LOST,
  NOT_THE_LATEST_CHECK,
  NOT_THE_LIST,
  READS_NOW,
  RecordingCheckService,
  RecordingsRefusedError,
  tooFewPeers,
} from '../../src/domain/recordings/RecordingCheckService.js';
import type { StreamRenditionRow, StreamRow } from '../../src/types/index.js';

import { playlistOf, ref } from './support/exportFakes.js';
import { FakeRenditionStore, FakeStreamStore, InMemoryAuditLog, streamRow, TEST_OPERATOR } from './support/fakes.js';
import {
  FakeLostRecordingsWrite,
  FakeRecordingReads,
  feedKey,
  InMemoryRecordingCheckStore,
} from './support/recordingFakes.js';

const NODE = { beeApiUrl: 'http://node.test', batchId: 'c3'.repeat(32) };
const HOUR = 3_600_000;

let streams: FakeStreamStore;
let renditions: FakeRenditionStore;
let store: InMemoryRecordingCheckStore;
let reads: FakeRecordingReads;
let writer: FakeLostRecordingsWrite;
let audit: InMemoryAuditLog;
let jobs: { open: Set<string>; files: Set<string> };
let catalogue: {
  read: { target: typeof NODE | null } | { skipped: string };
  refusal: { message: string } | null;
};
let now: number;
/** Runs between two rounds, where the check would wait ten minutes. */
let betweenRounds: () => Promise<void> | void;
let nextRef: number;

function service(): RecordingCheckService {
  return new RecordingCheckService(
    {
      store,
      streams,
      renditions,
      jobs: { openJobStreams: async () => new Set(jobs.open), exportFileStreams: async () => new Set(jobs.files) },
      catalogue: { forRead: async () => catalogue.read, status: async () => ({ refusal: catalogue.refusal }) },
      writer,
      reads,
      audit,
    },
    {
      restartWindowMinutes: 30,
      now: () => now,
      roundGapMs: 600_000,
      wait: async () => {
        now += 600_000;
        await betweenRounds();
      },
    },
  );
}

/** The slot a stream's own playlist is at. */
const masterOf = (stream: StreamRow) => ({ owner: stream.owner, topic: stream.topic, index: stream.manifest_index! });

/**
 * A finished recording, out of its restart window: its playlist names one segment, and the node gives both, or, when
 * `gone`, neither.
 */
function recorded(over: Partial<StreamRow> = {}, options: { gone?: boolean } = {}): StreamRow {
  const row = streams.add(
    streamRow({
      status: 'vod',
      manifest_index: 7,
      duration_seconds: 60,
      ended_at: new Date(now - 2 * HOUR),
      finished_at: new Date(now - HOUR),
      ...over,
    }),
  );
  if (!options.gone) give(row);
  return row;
}

/** The node gives a stream's own playlist, and the segment it names. */
function give(stream: StreamRow): void {
  const segment = ref(nextRef++);
  reads.playlists.set(feedKey(masterOf(stream)), playlistOf([segment]));
  reads.segments.add(segment);
}

/** One rung of a ladder, finished at `index`, whose segment the node holds unless `segmentGone`. */
function rung(stream: StreamRow, name: string, height: number, index: number, segmentGone = false): StreamRenditionRow {
  const topic = randomUUID();
  const segment = ref(nextRef++);
  reads.playlists.set(feedKey({ owner: stream.owner, topic, index }), playlistOf([segment]));
  if (!segmentGone) reads.segments.add(segment);
  return {
    stream_id: stream.id,
    name,
    width: Math.round((height * 16) / 9),
    height,
    topic,
    bandwidth: 1_000_000,
    avg_bandwidth: 900_000,
    manifest_index: index,
    duration_seconds: 60,
    updated_at: new Date(now),
  };
}

async function refusedWith(work: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof RecordingsRefusedError, `refused, got ${String(error)}`);
    assert.equal(error.message, message);
    return true;
  });
}

function actions(): string[] {
  return audit.entries.map((entry) => entry.action).filter((action) => action.startsWith('recording.'));
}

beforeEach(() => {
  renditions = new FakeRenditionStore();
  streams = new FakeStreamStore(renditions);
  store = new InMemoryRecordingCheckStore();
  reads = new FakeRecordingReads();
  writer = new FakeLostRecordingsWrite();
  audit = new InMemoryAuditLog();
  jobs = { open: new Set(), files: new Set() };
  catalogue = { read: { target: NODE }, refusal: null };
  now = Date.parse('2026-11-19T12:00:00.000Z');
  betweenRounds = () => undefined;
  nextRef = 1;
});

describe('a check of the recordings', () => {
  it('reads what the rule lets it judge, reads again only what failed, and calls lost a failure in all three rounds', async () => {
    const kept = recorded({ title: 'Kept' });
    const lost = recorded({ title: 'Lost' }, { gone: true });
    const slow = recorded({ title: 'Slow' }, { gone: true });
    const ladder = recorded({ title: 'Ladder' });
    renditions.rows.set(ladder.id, [rung(ladder, '720p', 720, 3), rung(ladder, '360p', 360, 4, true)]);
    recorded({ title: 'Window', finished_at: null, ended_at: new Date(now - 5 * 60_000) });
    const exporting = recorded({ title: 'Exporting' });
    jobs.open.add(exporting.id);
    streams.add(streamRow({ status: 'draft', title: 'Never live' }));
    let rounds = 1;
    betweenRounds = () => {
      rounds += 1;
      // Slow comes back for the second round: a passing failure loses nothing.
      if (rounds === 2) give(slow);
    };
    const checks = service();

    await checks.start(TEST_OPERATOR);
    await checks.settled();

    const { check } = await checks.status();
    assert.equal(check?.state, 'done');
    assert.equal(check?.total, 4);
    assert.equal(check?.unjudged, 2, 'the stream in its restart window and the one being exported');
    assert.deepEqual(
      check?.lost.map((recording) => recording.title),
      ['Lost'],
    );
    assert.deepEqual(
      check?.partlyLost.map((recording) => [recording.title, recording.failedQualities]),
      [['Ladder', ['360p']]],
    );
    assert.equal(reads.readsOf(masterOf(kept)), 1, 'a recording that read is read once');
    assert.equal(reads.readsOf(masterOf(slow)), 2);
    assert.equal(reads.readsOf(masterOf(lost)), 3);
    assert.deepEqual(
      [...store.marks].sort(),
      [
        [ladder.id, 'partly_lost'],
        [lost.id, 'lost'],
      ].sort(),
    );
    assert.deepEqual(actions(), ['recording.check.start', 'recording.check.finish']);
    assert.deepEqual(audit.entries.at(-1)?.details, {
      checkId: check?.id,
      state: 'done',
      lost: 1,
      partlyLost: 1,
      unjudged: 2,
    });
  });

  it('refuses a start while one runs, with no catalogue node, or with too few peers, and the page says why', async () => {
    recorded({ title: 'Lost' }, { gone: true });
    const checks = service();

    reads.peerCount = 3;
    await refusedWith(checks.start(TEST_OPERATOR), tooFewPeers(3, 4));
    assert.equal((await checks.status()).startRefusal, tooFewPeers(3, 4));
    catalogue.read = { skipped: 'the manager has not designated a catalogue batch.' };
    now += 20_000;
    assert.equal(
      (await checks.status()).startRefusal,
      noCatalogueNode('the manager has not designated a catalogue batch.'),
    );
    assert.equal(store.checks.length, 0, 'nothing was started');

    catalogue.read = { target: NODE };
    reads.peerCount = 8;
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    betweenRounds = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    await checks.start(TEST_OPERATOR);
    await waiting;
    await refusedWith(checks.start(TEST_OPERATOR), CHECK_RUNNING);
    betweenRounds = () => undefined;
    release();
    await checks.settled();
  });

  it('stops with no result once the node falls under the peers floor between two rounds', async () => {
    recorded({ title: 'Lost' }, { gone: true });
    betweenRounds = () => {
      reads.peerCount = 1;
    };
    const checks = service();

    await checks.start(TEST_OPERATOR);
    await checks.settled();

    const { check } = await checks.status();
    assert.equal(check?.state, 'stopped');
    assert.equal(check?.stopMessage, `${tooFewPeers(1, 4)} The check stopped with no result.`);
    assert.deepEqual(check?.lost, []);
    assert.equal(store.marks.size, 0, 'no stream was judged');
  });

  it('leaves unjudged a stream that went live while it ran', async () => {
    const lost = recorded({ title: 'Lost' }, { gone: true });
    betweenRounds = () => {
      streams.add({ ...streams.get(lost.id), status: 'live', manifest_index: null });
      store.liveStreams.add(lost.id);
    };
    const checks = service();

    await checks.start(TEST_OPERATOR);
    await checks.settled();

    const { check } = await checks.status();
    assert.equal(check?.state, 'done');
    assert.deepEqual(check?.lost, []);
    assert.equal(check?.unjudged, 1);
    assert.equal(store.marks.size, 0);
  });

  it('is stopped at boot when the last process left it running', async () => {
    await store.create({
      id: randomUUID(),
      startedBy: 'test-operator',
      startedByUserId: null,
      unjudged: 0,
      streams: [],
    });

    await service().boot();

    const latest = await store.latest();
    assert.equal(latest?.state, 'stopped');
    assert.equal(latest?.stopMessage, ADMIN_RESTARTED);
    assert.deepEqual(audit.entries.at(-1)?.details, {
      checkId: latest?.id,
      state: 'stopped',
      message: ADMIN_RESTARTED,
    });
  });
});

describe('the removal of lost recordings', () => {
  const CHECK = randomUUID();

  it('takes them off the catalogue in one write, deletes them, and keeps an export file’s stream as a draft', async () => {
    const gone = recorded({ title: 'Gone' }, { gone: true });
    const filed = recorded({ title: 'Filed' }, { gone: true });
    jobs.files.add(filed.id);
    const back = recorded({ title: 'Back' });
    const window = recorded({ title: 'Window', finished_at: null, ended_at: new Date(now - 60_000) }, { gone: true });
    store.finished(
      CHECK,
      [gone, filed, back, window].map((stream) => ({ streamId: stream.id, title: stream.title, verdict: 'lost' })),
      new Date(now - 60_000),
    );
    store.marks.set(back.id, 'lost');
    writer.onTaken = (id) => void streams.add({ ...streams.get(id), status: 'draft' });
    const checks = service();

    const answer = await checks.removeLost(TEST_OPERATOR, {
      checkId: CHECK,
      streamIds: [window.id, back.id, filed.id, gone.id],
    });

    assert.deepEqual(answer.removed, [{ streamId: gone.id, title: 'Gone' }]);
    assert.deepEqual(answer.unlisted, [{ streamId: filed.id, title: 'Filed' }]);
    assert.deepEqual(
      answer.kept.map((one) => [one.title, one.reason]).sort(),
      [
        ['Back', READS_NOW],
        ['Window', KEPT_BY_RULE.restart_window],
      ].sort(),
    );
    assert.equal(answer.feedIndex, 41);
    assert.deepEqual(
      writer.calls.map((call) => call.streamIds.sort()),
      [[gone.id, filed.id].sort()],
      'one catalogue write, for the two that go',
    );
    assert.equal(streams.rows.has(gone.id), false, 'deleted');
    assert.equal(streams.get(filed.id).status, 'draft', 'kept as a draft, with its export file');
    assert.equal(store.marks.has(back.id), false, 'a read once more that finds it takes the mark off');
    assert.deepEqual(
      audit.entries
        .filter((entry) => entry.action.startsWith('recording.lost'))
        .map((entry) => [entry.action, entry.streamId, entry.details?.feedIndex]),
      [
        ['recording.lost.unlist', filed.id, 41],
        ['recording.lost.delete', gone.id, 41],
      ],
    );

    const { check, removalRefusal } = await checks.status();
    assert.deepEqual(check?.lost, []);
    assert.equal(removalRefusal, NONE_LOST);
  });

  it('refuses, and writes nothing, when the node falls under the peers floor while it reads them once more', async () => {
    const gone = recorded({ title: 'Gone' }, { gone: true });
    const back = recorded({ title: 'Back' });
    store.finished(
      CHECK,
      [gone, back].map((stream) => ({ streamId: stream.id, title: stream.title, verdict: 'lost' })),
      new Date(now - 60_000),
    );
    store.marks.set(back.id, 'lost');
    const read = reads.playlist.bind(reads);
    reads.playlist = (node, feed) => {
      reads.peerCount = 1;
      return read(node, feed);
    };

    await refusedWith(
      service().removeLost(TEST_OPERATOR, { checkId: CHECK, streamIds: [gone.id, back.id] }),
      nodeFailedDuringRemoval(tooFewPeers(1, 4)),
    );

    assert.equal(writer.calls.length, 0, 'nothing left the catalogue');
    assert.ok(streams.rows.has(gone.id), 'nothing was deleted');
    assert.equal(store.marks.get(back.id), 'lost', 'and nothing was recorded of what was read');
    assert.deepEqual(
      (await store.streams(CHECK)).map((row) => row.removal),
      [null, null],
    );
  });

  it('keeps a listed stream that holds no finished recording now', async () => {
    const empty = streams.add(streamRow({ status: 'draft', manifest_index: null, title: 'Empty' }));
    store.finished(CHECK, [{ streamId: empty.id, title: 'Empty', verdict: 'lost' }], new Date(now - 60_000));

    const answer = await service().removeLost(TEST_OPERATOR, { checkId: CHECK, streamIds: [empty.id] });

    assert.deepEqual(answer.kept, [{ streamId: empty.id, title: 'Empty', reason: NO_RECORDING_NOW }]);
    assert.deepEqual(answer.removed, []);
    assert.equal(writer.calls.length, 0);
    assert.ok(streams.rows.has(empty.id), 'not deleted');
  });

  it('refuses another list, a check that is not the latest or too old, and a catalogue that cannot be written', async () => {
    const gone = recorded({ title: 'Gone' }, { gone: true });
    store.finished(CHECK, [{ streamId: gone.id, title: 'Gone', verdict: 'lost' }], new Date(now - 60_000));
    const checks = service();
    const remove = (over: { checkId?: string; streamIds?: string[] } = {}) =>
      checks.removeLost(TEST_OPERATOR, { checkId: CHECK, streamIds: [gone.id], ...over });

    await refusedWith(remove({ streamIds: [] }), NOT_THE_LIST);
    await refusedWith(remove({ streamIds: [gone.id, gone.id] }), NOT_THE_LIST);
    await refusedWith(remove({ checkId: randomUUID() }), NOT_THE_LATEST_CHECK);
    catalogue.refusal = { message: 'The catalogue batch a1a1a1a1… has expired.' };
    await refusedWith(remove(), catalogueNotWritable('The catalogue batch a1a1a1a1… has expired.'));
    catalogue.refusal = null;
    now += 6 * HOUR;
    await refusedWith(remove(), CHECK_TOO_OLD);

    assert.equal(writer.calls.length, 0);
    assert.ok(streams.rows.has(gone.id), 'nothing was removed');
  });
});

describe('a stream’s mark', () => {
  it('is on the stream while the latest check found its recording lost or partly lost, and absent otherwise', () => {
    const checkedAt = new Date('2026-11-19T12:20:00.000Z');
    const marked = toStream(streamRow({ recording_verdict: 'partly_lost', recording_checked_at: checkedAt }));
    assert.equal(marked.recording, 'partly_lost');
    assert.equal(marked.recordingCheckedAt, checkedAt.toISOString());
    const unmarked = toStream(streamRow());
    assert.equal('recording' in unmarked, false);
    assert.equal('recordingCheckedAt' in unmarked, false);
  });
});

describe('the jobs the rule reads', () => {
  it('counts an export under way and an archive that is not done as jobs, and a done export as a kept file', async () => {
    let exporting = { streamId: 'exported', state: 'reading' } as unknown as ExportSummary;
    const archiving = { streamId: 'archived', state: 'paused' } as unknown as ArchiveJobSummary;
    const read = recordingJobsOf({ current: async () => exporting }, { current: async () => archiving });

    assert.deepEqual([...(await read.openJobStreams())].sort(), ['archived', 'exported']);
    assert.deepEqual([...(await read.exportFileStreams())], []);
    exporting = { streamId: 'exported', state: 'done' } as unknown as ExportSummary;
    assert.deepEqual([...(await read.openJobStreams())], ['archived']);
    assert.deepEqual([...(await read.exportFileStreams())], ['exported']);
  });
});
