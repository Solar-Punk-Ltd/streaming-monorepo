/**
 * One glued recording when the broadcast before it on the same topic was ended by the **stall reaper**.
 *
 * ## Why this path and not the re-announce one
 *
 * `sharedFeedDrain.test.ts` and `AdminStreamSession.test.ts` already hold the handover where an
 * engine **re-announces**: `startStream` finds a live session under the id, retires it and spawns its
 * replacement in the same turn. That is the polite case, and it is not the one production mostly
 * takes. An engine that dies sends no `on_unpublish` and makes no second announce, so nothing at all
 * tells this service the broadcast is over, and the only thing that ends it is `scheduleStallReap`
 * firing after `orphanReapMs` of silence. Whatever comes next on that topic comes after the reaper's
 * own `stopStream`:
 *
 * - it is the **reaper** that hands the outgoing session's write completion to `trackSharedFeedWrites`,
 *   so the gate a successor waits on is registered from a timer handler rather than from an announce,
 * - a successor that announces after the drain has finished is an **ordinary fresh start**,
 * - a successor that announces while that drain is still running is the takeover branch again, but
 *   over a session the reaper gave up on,
 * - and what either of them glues is the recording the reaper uploaded, named by the reference the
 *   finalize left in the recording store for that topic.
 *
 * ## What each case pins
 *
 * 1. The reaper really is what ends A: nothing here calls `stopStream`, and `streams_reaped_total`
 *    counts the decision. Its ending is a closing window, then a recording, then that recording's
 *    reference remembered for the topic.
 * 2. B continues the numbering A left, with the seam declared on B's own first segment, so a viewer
 *    following the topic is handed a media sequence that moves forwards.
 * 3. B's recording is A's recording verbatim, one `#EXT-X-DISCONTINUITY`, then B's own media, and the
 *    length reported for it is the whole broadcast rather than B's share.
 * 4. The same, for a **ladder rung**, whose topic is derived rather than declared.
 * 5. And the race: B announced while the reaper's recording upload is still in flight scans nothing,
 *    downloads nothing and writes no window until that finalize is done, then glues that recording.
 *
 * Then the two the store adds: a restart of this process between A and B, through the store's file,
 * and a download that does not succeed, which starts B unglued rather than holding the broadcast.
 *
 * Every clock that ends a broadcast here is a `FakeClock` stepped by the case. The windows run on real
 * time at the test window length. Nothing asserts how long anything took, see the e2e rule in `AGENTS.md`.
 */

import { parseLiveWindowPayload } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import {
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStateReport,
  STATE_REPORT_ACCEPTED,
} from '../src/libs/AdminApiClient.js';
import { Logger } from '../src/libs/Logger.js';
import { RecordingStore } from '../src/libs/RecordingStore.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_AUDIO } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { fakeRecordingReference, makeTestOrchestrator } from './helpers/fakes.js';
import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

/** The silence a broadcast may go quiet for before the reaper ends it. Short, since the clock is fake. */
const REAP_MS = 60_000;

/** A ceiling on a hung wait, not a measurement. The same constant and reason as in `StreamReaper.test.ts`. */
const SETTLE_CEILING_MS = 4_000;

/** Long enough for a held window to have escaped, short enough that a case meant to reach it stays cheap. */
const QUIET_WINDOW_MS = 100;

/** What each test segment declares, so the arithmetic in an assertion is legible. */
const SEGMENT_SECONDS = 2;

const DECLARATION: AdminSession = { id: 'admin-stream-id', topic: 'declared-topic-0001' };
const SINGLE_STREAM_ID = 'audio/declared-stream';
const RUNG_NAME = '360p';
const RUNG_STREAM_ID = `audio/ladder-stream_${RUNG_NAME}`;

const DISCONTINUITY_TAG = '#EXT-X-DISCONTINUITY';
const ENDLIST_TAG = '#EXT-X-ENDLIST';
const MEDIA_SEQUENCE_TAG = '#EXT-X-MEDIA-SEQUENCE';

/** The media the first broadcast publishes, and the second. Labelled so a playlist names its source. */
const A_SEGMENTS = ['a0', 'a1', 'a2'];
const B_SEGMENTS = ['b0', 'b1'];

/** One live window the uploader wrote, its identifier in hex and its playlist. */
interface WindowWrite {
  identifier: string;
  playlist: string;
}

/**
 * What Swarm holds, shared by every harness built over it, so a second process started over the same
 * one finds what the first wrote: window chunks by identifier and recordings by reference.
 */
interface FakeSwarm {
  chunks: Map<string, Uint8Array>;
  recordings: Map<string, string>;
}

function emptySwarm(): FakeSwarm {
  return { chunks: new Map(), recordings: new Map() };
}

/** One promise a test controls without exposing its resolver before construction. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A store that remembers what the finalize told it, so a case can say which reference it was handed. */
class RememberingStore extends RecordingStore {
  public readonly remembered: [string, string][] = [];

  public override remember(topic: string, reference: string): void {
    this.remembered.push([topic, reference]);
    super.remember(topic, reference);
  }
}

interface GlueHarnessOptions {
  blockRecording?: boolean;
  ladder?: boolean;
  swarm?: FakeSwarm;
  recordingStore?: RecordingStore;
  /** Asked before each recording download. An error is thrown instead of the download. */
  downloadFails?: () => Error | null;
}

interface GlueHarness {
  orchestrator: StreamOrchestrator;
  clock: FakeClock;
  streamId: string;
  /** Every window written, in order, across every topic. */
  windows: WindowWrite[];
  /** Every recording uploaded, in order. */
  recordings: string[];
  /** Every recording reference a session asked to download, in order. */
  downloads: string[];
  /** How many window reads any session's opening scan made. */
  scanReads: () => number;
  /** Every length the admin was told a finished recording plays for, in order. */
  reportedRecordingSeconds: number[];
  start: () => void;
  /** Hand one segment to the orchestrator and wait for its bytes to reach the fake bee. */
  segment: (label: string, index: number) => Promise<void>;
  /** Wait for a written window that names this segment. */
  written: (label: string) => Promise<void>;
  /** Advance past the reap window and wait for the reaper to have decided. Nothing calls `stopStream`. */
  reap: () => Promise<void>;
  /** Whether the held recording upload has been entered, so a case knows the gate is really armed. */
  recordingUploadStarted: () => boolean;
  /** Let the held recording upload complete. Safe to call when nothing is held. */
  releaseRecording: () => void;
}

/**
 * A declared stream in admin mode, optionally as one rung of a ladder, over a fake Swarm that keeps
 * every window chunk at its identifier and every recording at its reference, so a successor finds
 * exactly what its predecessor wrote and nothing that a different topic wrote.
 */
function glueHarness(options: GlueHarnessOptions = {}): GlueHarness {
  const clock = new FakeClock();
  const swarm = options.swarm ?? emptySwarm();
  const windows: WindowWrite[] = [];
  const recordings: string[] = [];
  const downloads: string[] = [];
  const uploadedSegments: string[] = [];
  const reportedRecordingSeconds: number[] = [];
  const heldRecording = deferred();
  const streamId = options.ladder ? RUNG_STREAM_ID : SINGLE_STREAM_ID;
  let blockRecording = options.blockRecording === true;
  let recordingUploadStarted = false;
  let scanReads = 0;

  const adminApi = {
    describe: () => 'http://admin.test',
    reportState: async (_id: string, report: AdminStateReport) => {
      if (report.state === ADMIN_STATE_VOD) {
        reportedRecordingSeconds.push(report.duration);
      }
      return STATE_REPORT_ACCEPTED;
    },
  } as unknown as AdminApiClient;

  const orchestrator = makeTestOrchestrator(
    {
      adminApi,
      clock,
      orphanReapMs: REAP_MS,
      ...(options.recordingStore ? { recordingStore: options.recordingStore } : {}),
      ...(options.ladder ? { ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC) } : {}),
    },
    {
      uploadData: async (_stamp, data) => {
        const label = Buffer.from(data).toString('utf8');
        uploadedSegments.push(label);
        return { reference: { toHex: () => `segment-${label}` } };
      },
      uploadWindow: async (identifier, payload) => {
        windows.push({ identifier, playlist: parseLiveWindowPayload(payload)?.playlist ?? '' });
        swarm.chunks.set(identifier, payload);
        return { reference: { toHex: () => 'window' } };
      },
      windowAt: (identifier) => {
        scanReads += 1;
        return swarm.chunks.get(identifier) ?? null;
      },
      uploadRecording: async (playlist) => {
        if (blockRecording) {
          blockRecording = false;
          recordingUploadStarted = true;
          await heldRecording.promise;
        }
        recordings.push(playlist);
        const reference = fakeRecordingReference(playlist);
        swarm.recordings.set(reference, playlist);
        return { reference: { toHex: () => reference } };
      },
      downloadRecording: async (reference) => {
        downloads.push(reference);
        const failure = options.downloadFails?.();
        if (failure) {
          throw failure;
        }
        const playlist = swarm.recordings.get(reference);
        if (playlist === undefined) {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }
        return playlist;
      },
    },
  );

  return {
    orchestrator,
    clock,
    streamId,
    windows,
    recordings,
    downloads,
    scanReads: () => scanReads,
    reportedRecordingSeconds,
    start: () => {
      assert.equal(
        orchestrator.startStream(streamId, MEDIA_TYPE_AUDIO, undefined, DECLARATION),
        true,
        'the declared session must be admitted',
      );
    },
    segment: async (label, index) => {
      assert.deepEqual(orchestrator.handleSegment(streamId, index, SEGMENT_SECONDS, Buffer.from(label)), {
        accepted: true,
      });
      await waitFor(() => uploadedSegments.includes(label), SETTLE_CEILING_MS);
    },
    written: async (label) => {
      await waitFor(() => windowsNaming(windows, label).length > 0, SETTLE_CEILING_MS);
    },
    reap: async () => {
      const decidedBefore = orchestrator.getMetricsSnapshot().streamsReapedTotal;
      // The engine dies here. Nothing calls stopStream, because nothing knows.
      await clock.advance(REAP_MS + 1);
      await waitFor(() => orchestrator.getMetricsSnapshot().streamsReapedTotal > decidedBefore, SETTLE_CEILING_MS);
    },
    recordingUploadStarted: () => recordingUploadStarted,
    releaseRecording: heldRecording.resolve,
  };
}

function windowsNaming(windows: readonly WindowWrite[], label: string): WindowWrite[] {
  return windows.filter((write) => write.playlist.includes(`segment-${label}`));
}

/** The closing windows, which end a playlist. */
function closingWindows(windows: readonly WindowWrite[]): WindowWrite[] {
  return windows.filter((write) => write.playlist.includes(ENDLIST_TAG));
}

/**
 * Whole `#EXT-X-DISCONTINUITY` lines, which is not what a substring count answers: the header tag
 * `#EXT-X-DISCONTINUITY-SEQUENCE` starts with the same characters.
 */
function seamCount(playlist: string): number {
  return playlist.split('\n').filter((line) => line.trim() === DISCONTINUITY_TAG).length;
}

function mediaSequenceOf(playlist: string): number {
  const declared = new RegExp(`^${MEDIA_SEQUENCE_TAG}:(\\d+)$`, 'm').exec(playlist);
  assert.ok(declared, `every playlist this service publishes declares ${MEDIA_SEQUENCE_TAG}`);
  return Number(declared[1]);
}

/** How many entries a playlist lists, counted the way `continuesFrom` counts them: one `#EXTINF` each. */
function entryCount(playlist: string): number {
  return playlist.split('\n').filter((line) => line.startsWith('#EXTINF:')).length;
}

/**
 * A recording's media, as text: everything between the blank line that ends its header block and its
 * `#EXT-X-ENDLIST`.
 *
 * Read out of the playlist by hand rather than through `inheritedTimeline`, so that the expectation a
 * case checks is not built by the same function the behaviour under test used to build it.
 */
function recordedMediaOf(recording: string): string {
  const headersEnd = recording.indexOf('\n\n');
  const endList = recording.indexOf(ENDLIST_TAG);
  assert.ok(headersEnd !== -1, 'a playlist separates its header block from its media with a blank line');
  assert.ok(endList > headersEnd, 'a recording ends its playlist');
  return recording.slice(headersEnd + 2, endList);
}

function segmentUris(playlist: string): string[] {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('segment-'));
}

/** The second recording carries the first verbatim, then one seam, then its own media, in order. */
function assertGlued(first: string, second: string): void {
  assert.ok(
    second.includes(`${recordedMediaOf(first)}${DISCONTINUITY_TAG}\n`),
    'the earlier recording′s entries go in verbatim, and the seam directly after them',
  );
  assert.equal(seamCount(second), 1, 'one join between the two broadcasts, never two');
  assert.equal(
    entryCount(second),
    A_SEGMENTS.length + B_SEGMENTS.length,
    'every segment of both broadcasts is named, and none of them twice',
  );
  assert.equal(
    mediaSequenceOf(second),
    mediaSequenceOf(first),
    'the recording starts where the broadcast started, not where this session joined it',
  );
  assert.deepEqual(
    segmentUris(second),
    [...A_SEGMENTS, ...B_SEGMENTS].map((label) => `segment-${label}`),
    'in the order the broadcast played',
  );
  assert.ok(second.trimEnd().endsWith(ENDLIST_TAG), 'and it is a finished playlist');
}

/** Run with the shared logger's lines captured, restoring whatever was configured before. */
async function withCapturedLog<T>(run: (lines: string[]) => Promise<T>): Promise<T> {
  const lines: string[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({ sink: (_level, line) => void lines.push(line) });
  try {
    return await run(lines);
  } finally {
    logger.configure(previous);
  }
}

interface ReapedScenario {
  harness: GlueHarness;
  /** The closing window the reaper wrote for the first broadcast. */
  aClosing: WindowWrite;
  /** The recording the reaper uploaded for the first broadcast. */
  aRecording: string;
  /** The first window the second broadcast wrote, which a viewer is handed next. */
  bFirstLive: WindowWrite;
}

/** A broadcast fed and then abandoned, and ended by the reaper. Nothing calls `stopStream`. */
async function reapedFirstBroadcast(harness: GlueHarness): Promise<void> {
  harness.start();
  for (const [index, label] of A_SEGMENTS.entries()) {
    await harness.segment(label, index);
  }
  await harness.written(A_SEGMENTS[A_SEGMENTS.length - 1]);

  await harness.reap();
  await waitFor(() => harness.recordings.length === 1, SETTLE_CEILING_MS);
  // The drain is over only once the id has left the live maps, and that is also when the shared-topic
  // entry the successor would have waited on has been cleared. Waiting for it keeps the successor an
  // ordinary fresh start rather than a sometimes-gated one.
  await waitFor(() => harness.orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);
}

/** The second broadcast on the same declared or derived topic, fed until its last segment is in a window. */
async function secondBroadcast(harness: GlueHarness): Promise<void> {
  harness.start();
  for (const [index, label] of B_SEGMENTS.entries()) {
    await harness.segment(label, index);
  }
  await harness.written(B_SEGMENTS[B_SEGMENTS.length - 1]);
}

async function reapedThenSucceeded(harness: GlueHarness): Promise<ReapedScenario> {
  await reapedFirstBroadcast(harness);
  await secondBroadcast(harness);
  return {
    harness,
    aClosing: closingWindows(harness.windows)[0],
    aRecording: harness.recordings[0],
    bFirstLive: windowsNaming(harness.windows, B_SEGMENTS[0])[0],
  };
}

/** Stop the second broadcast and hand back its recording. */
async function finishSecond(harness: GlueHarness): Promise<string> {
  await harness.orchestrator.stopStream(harness.streamId);
  await waitFor(() => harness.recordings.length === 2, SETTLE_CEILING_MS);
  return harness.recordings[1];
}

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('a broadcast the stall reaper ended, and the one that follows it on the same topic', () => {
  it('ends the first broadcast from the reaper alone, and remembers its recording for the topic', async () => {
    const store = new RememberingStore();
    const harness = glueHarness({ recordingStore: store });

    harness.start();
    await harness.segment(A_SEGMENTS[0], 0);
    await harness.written(A_SEGMENTS[0]);
    assert.equal(harness.orchestrator.getActiveStreamCount(), 1, 'the broadcast is live before the engine dies');

    await harness.reap();
    await waitFor(() => harness.recordings.length === 1, SETTLE_CEILING_MS);
    await waitFor(() => store.remembered.length === 1, SETTLE_CEILING_MS);

    const snapshot = harness.orchestrator.getMetricsSnapshot();
    assert.equal(snapshot.streamsReapedTotal, 1, 'the reaper is what decided this broadcast was over');
    assert.equal(snapshot.streamsFinalizedTotal, 1, 'and its finalize uploaded the recording');
    assert.equal(closingWindows(harness.windows).length, 1, 'one closing window ends the live playlist');
    assert.equal(
      store.remembered[0][1],
      fakeRecordingReference(harness.recordings[0]),
      'the reference remembered is the recording this finalize uploaded',
    );
  });

  it('numbers the successor′s first window on from what the reaper left, and seams it', async () => {
    const { aClosing, aRecording, bFirstLive } = await reapedThenSucceeded(glueHarness());

    assert.equal(
      mediaSequenceOf(bFirstLive.playlist),
      mediaSequenceOf(aClosing.playlist) + entryCount(aClosing.playlist),
      'a media sequence that moved backwards is what hls.js reports as a fatal parsing error',
    );
    assert.equal(
      mediaSequenceOf(bFirstLive.playlist),
      mediaSequenceOf(aRecording) + entryCount(aRecording),
      'and the window and the recording agree where the broadcast had got to',
    );
    assert.equal(seamCount(bFirstLive.playlist), 1, 'the join between the two broadcasts is declared once');

    // And it is declared on the successor′s own first segment rather than anywhere else in the window.
    const lines = bFirstLive.playlist.split('\n').map((line) => line.trim());
    const seamAt = lines.indexOf(DISCONTINUITY_TAG);
    assert.equal(
      lines.slice(seamAt).find((line) => line.startsWith('segment-')),
      `segment-${B_SEGMENTS[0]}`,
      'the break belongs in front of the first media this session produced',
    );
  });

  it('finalizes the successor as one recording carrying both broadcasts', async () => {
    const { harness, aRecording } = await reapedThenSucceeded(glueHarness());

    const bRecording = await finishSecond(harness);

    assertGlued(aRecording, bRecording);
    assert.deepEqual(harness.downloads, [fakeRecordingReference(aRecording)], 'glued by the reference it was left');
  });

  it('reports the whole broadcast′s length for the glued recording', async () => {
    const { harness } = await reapedThenSucceeded(glueHarness());

    await finishSecond(harness);
    await waitFor(() => harness.reportedRecordingSeconds.length === 2, SETTLE_CEILING_MS);

    const [reaped, glued] = harness.reportedRecordingSeconds;
    assert.equal(reaped, A_SEGMENTS.length * SEGMENT_SECONDS, 'the reaper reported the broadcast it ended');
    assert.equal(
      glued,
      reaped + B_SEGMENTS.length * SEGMENT_SECONDS,
      'and the glued recording is reported as both, since that is what a viewer is handed',
    );
  });

  /**
   * The same handover on the arm production actually takes now: the encoder disconnected, its
   * `on_unpublish` reported that and ended nothing, and nothing came back inside the window.
   *
   * ⛔ **A disconnect must reach the reaper's own path rather than a shorter one.** It ends nothing
   * itself, so what finalizes the broadcast is the same timer that finalizes one whose engine died,
   * and the glue on the far side of it has to be identical, since a viewer cannot tell the two apart.
   */
  it('glues onto a recording the reaper uploaded after the encoder disconnected', async () => {
    const harness = glueHarness();

    harness.start();
    for (const [index, label] of A_SEGMENTS.entries()) {
      await harness.segment(label, index);
    }
    await harness.written(A_SEGMENTS[A_SEGMENTS.length - 1]);

    harness.orchestrator.noteDisconnect(SINGLE_STREAM_ID);
    await waitAndConfirmNothingHappened(() => harness.recordings.length === 0, QUIET_WINDOW_MS);

    await harness.reap();
    await waitFor(() => harness.recordings.length === 1, SETTLE_CEILING_MS);
    await waitFor(() => harness.orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

    // The encoder comes back, too late. That is a new broadcast, and it opens with the one before it.
    await secondBroadcast(harness);
    const bFirstLive = windowsNaming(harness.windows, B_SEGMENTS[0])[0];
    assert.equal(seamCount(bFirstLive.playlist), 1, 'with the join declared once');

    assertGlued(harness.recordings[0], await finishSecond(harness));
  });

  /**
   * ⛔ A rung′s topic is derived from its ladder group and its rung name rather than declared, so it
   * is stable across the two sessions for a different reason from the single declared stream above,
   * and the reaper releases the ladder on its way out, so the successor derives the topic again from
   * the declaration rather than finding it remembered. Same glue, different route to one topic.
   */
  it('glues a ladder rung whose topic is derived rather than declared', async () => {
    const { harness, aClosing, aRecording, bFirstLive } = await reapedThenSucceeded(glueHarness({ ladder: true }));

    assert.equal(
      mediaSequenceOf(bFirstLive.playlist),
      mediaSequenceOf(aClosing.playlist) + entryCount(aClosing.playlist),
      'the rung came back onto the topic it was already writing, which is what deriving the topic buys',
    );
    assert.equal(seamCount(bFirstLive.playlist), 1, 'with the restart declared as a break');

    assertGlued(aRecording, await finishSecond(harness));
  });

  /**
   * ⛔⛔ The race, on the reaper′s drain rather than on a re-announce′s.
   *
   * The reaper started the drain first, from a timer handler with no announce anywhere near it, and
   * the announce arrives into a drain that is already running: the id is still in `activeStreams` for
   * the length of that drain, so `startStream` takes its takeover branch. That is an ordinary
   * production sequence, SRS reconnecting a publisher after the reaper has fired but while Bee is still
   * taking the recording.
   *
   * The successor must write no window and, more sharply, must **neither scan the topic nor ask for a
   * recording** while the finalize runs: the recording store does not name A's recording yet, so a
   * successor that looked would open with no prefix, or with an older one.
   */
  it('holds a successor announced while the reaper′s recording upload is still in flight', async () => {
    const harness = glueHarness({ blockRecording: true });
    try {
      harness.start();
      await harness.segment(A_SEGMENTS[0], 0);
      await harness.written(A_SEGMENTS[0]);

      await harness.reap();
      await waitFor(harness.recordingUploadStarted, SETTLE_CEILING_MS);
      const readsBefore = harness.scanReads();

      harness.start();
      await harness.segment(B_SEGMENTS[0], 0);

      await waitAndConfirmNothingHappened(
        () =>
          harness.scanReads() === readsBefore &&
          harness.downloads.length === 0 &&
          windowsNaming(harness.windows, B_SEGMENTS[0]).length === 0,
        QUIET_WINDOW_MS,
      );
    } finally {
      harness.releaseRecording();
    }
  });

  it('lets the held successor glue the reaper′s recording once that finalize is done', async () => {
    const harness = glueHarness({ blockRecording: true });
    try {
      harness.start();
      for (const [index, label] of A_SEGMENTS.entries()) {
        await harness.segment(label, index);
      }
      await harness.written(A_SEGMENTS[A_SEGMENTS.length - 1]);

      await harness.reap();
      await waitFor(harness.recordingUploadStarted, SETTLE_CEILING_MS);

      harness.start();
      await harness.segment(B_SEGMENTS[0], 0);

      harness.releaseRecording();
      await waitFor(() => harness.recordings.length === 1, SETTLE_CEILING_MS);
      await harness.segment(B_SEGMENTS[1], 1);
      await harness.written(B_SEGMENTS[1]);

      const aRecording = harness.recordings[0];
      const bFirstLive = windowsNaming(harness.windows, B_SEGMENTS[0])[0];
      assert.equal(
        mediaSequenceOf(bFirstLive.playlist),
        mediaSequenceOf(aRecording) + entryCount(aRecording),
        'so its numbering carries on from where the first broadcast ended',
      );
      assert.equal(seamCount(bFirstLive.playlist), 1);

      assertGlued(aRecording, await finishSecond(harness));
    } finally {
      harness.releaseRecording();
    }
  });
});

describe('the recording a topic ended with, across a restart and a failed download', () => {
  it('glues across a restart of this process, through the store′s file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-restart-'));
    tempRoots.push(root);
    const storeFile = path.join(root, 'recordings', 'by-topic.json');
    const swarm = emptySwarm();

    const before = glueHarness({ swarm, recordingStore: new RecordingStore(storeFile) });
    await reapedFirstBroadcast(before);
    await before.orchestrator.cleanup();

    // A new process: nothing in memory, the same Swarm and the same state directory.
    const restarted = glueHarness({ swarm, recordingStore: new RecordingStore(storeFile) });
    await secondBroadcast(restarted);

    await restarted.orchestrator.stopStream(restarted.streamId);
    await waitFor(() => restarted.recordings.length === 1, SETTLE_CEILING_MS);

    assertGlued(before.recordings[0], restarted.recordings[0]);
  });

  it('reports a store that cannot save as state failing to persist, so the loss shows before a restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-unwritable-'));
    tempRoots.push(root);
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const harness = glueHarness({ recordingStore: new RecordingStore(path.join(blocker, 'by-topic.json')) });
    assert.equal(harness.orchestrator.getMsSinceStatePersistFailed(), null);

    await withCapturedLog(async () => reapedFirstBroadcast(harness));

    assert.notEqual(harness.orchestrator.getMsSinceStatePersistFailed(), null);
  });

  it('retries a download that failed, and glues once it lands', async () => {
    let failuresLeft = 1;
    const harness = glueHarness({
      downloadFails: () => (failuresLeft-- > 0 ? new Error('socket hang up') : null),
    });
    const { aRecording } = await reapedThenSucceeded(harness);

    assertGlued(aRecording, await finishSecond(harness));
    assert.equal(harness.downloads.length, 2, 'one failed attempt, then the one that landed');
  });

  it('starts unglued when the recording cannot be had, says so, and never holds the broadcast', async () => {
    await withCapturedLog(async (lines) => {
      const harness = glueHarness({
        downloadFails: () => Object.assign(new Error('Bad Request'), { status: 400 }),
      });
      const { aClosing, bFirstLive } = await reapedThenSucceeded(harness);

      assert.equal(
        mediaSequenceOf(bFirstLive.playlist),
        mediaSequenceOf(aClosing.playlist) + entryCount(aClosing.playlist),
        'the numbering still carries on, since it comes from the window and not the recording',
      );
      assert.equal(harness.orchestrator.getMetricsSnapshot().recordingsUngluedTotal, 1);
      assert.equal(lines.filter((line) => line.includes('opens its recording without')).length, 1);

      const bRecording = await finishSecond(harness);
      assert.deepEqual(
        segmentUris(bRecording),
        B_SEGMENTS.map((label) => `segment-${label}`),
        'its recording is its own media alone',
      );
    });
  });
});
