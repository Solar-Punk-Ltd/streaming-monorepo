/**
 * The broadcast after one the **stall reaper** ended, on the same topic.
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
 * - and the newest window either of them finds is the closing window the reaper wrote.
 *
 * ## What each case pins
 *
 * 1. The reaper really is what ends A: nothing here calls `stopStream`, and `streams_reaped_total`
 *    counts the decision. Its ending is a closing window and then a recording.
 * 2. B continues the numbering A's closing window left, with the seam declared on B's own first
 *    segment, so a viewer following the topic is handed a media sequence that moves forwards.
 * 3. B's recording is B's own, since a window carries no recording to inherit.
 * 4. The same, for a **ladder rung**, whose topic is derived rather than declared.
 * 5. And the race: B announced while the reaper's recording upload is still in flight writes no
 *    window and scans nothing until that finalize is done, then continues from A's closing window.
 *
 * Every clock that ends a broadcast here is a `FakeClock` stepped by the case. The windows run on real
 * time at the test window length. Nothing asserts how long anything took, see the e2e rule in `AGENTS.md`.
 */

import { parseLiveWindowPayload } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import {
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStateReport,
  STATE_REPORT_ACCEPTED,
} from '../src/libs/AdminApiClient.js';
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

/** One promise a test controls without exposing its resolver before construction. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface ReapHarness {
  orchestrator: StreamOrchestrator;
  clock: FakeClock;
  streamId: string;
  /** Every window written, in order, across every topic. */
  windows: WindowWrite[];
  /** Every recording uploaded, in order. */
  recordings: string[];
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
 * A declared stream in admin mode, optionally as one rung of a ladder, over a fake bee that keeps every
 * window chunk at its identifier, so a successor's opening scan finds exactly what its predecessor
 * wrote and nothing that a different topic wrote.
 */
function reapHarness(options: { blockRecording?: boolean; ladder?: boolean } = {}): ReapHarness {
  const clock = new FakeClock();
  const windows: WindowWrite[] = [];
  const recordings: string[] = [];
  const stored = new Map<string, Uint8Array>();
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
        stored.set(identifier, payload);
        return { reference: { toHex: () => 'window' } };
      },
      windowAt: (identifier) => {
        scanReads += 1;
        return stored.get(identifier) ?? null;
      },
      uploadRecording: async (playlist) => {
        if (blockRecording) {
          blockRecording = false;
          recordingUploadStarted = true;
          await heldRecording.promise;
        }
        recordings.push(playlist);
        const reference = fakeRecordingReference(playlist);
        return { reference: { toHex: () => reference } };
      },
    },
  );

  return {
    orchestrator,
    clock,
    streamId,
    windows,
    recordings,
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

interface ReapedScenario {
  harness: ReapHarness;
  /** The closing window the reaper wrote for the first broadcast. */
  aClosing: WindowWrite;
  /** The first window the second broadcast wrote, which a viewer is handed next. */
  bFirstLive: WindowWrite;
}

/**
 * The whole path: a broadcast fed and then abandoned, ended by the reaper, and a second broadcast
 * announced afterwards on the same declared or derived topic and fed in its turn.
 *
 * Deliberately no `stopStream` anywhere. The only thing that ends the first broadcast is the timer.
 */
async function reapedThenSucceeded(harness: ReapHarness): Promise<ReapedScenario> {
  harness.start();
  for (const [index, label] of A_SEGMENTS.entries()) {
    await harness.segment(label, index);
  }
  await harness.written(A_SEGMENTS[A_SEGMENTS.length - 1]);

  await harness.reap();
  await waitFor(() => harness.recordings.length === 1, SETTLE_CEILING_MS);
  // The drain is over only once the id has left the live maps, and that is also when the shared-topic
  // entry the successor would have waited on has been cleared. Waiting for it keeps this helper's
  // successor an ordinary fresh start rather than a sometimes-gated one.
  await waitFor(() => harness.orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

  harness.start();
  for (const [index, label] of B_SEGMENTS.entries()) {
    await harness.segment(label, index);
  }
  await harness.written(B_SEGMENTS[B_SEGMENTS.length - 1]);

  return {
    harness,
    aClosing: closingWindows(harness.windows)[0],
    bFirstLive: windowsNaming(harness.windows, B_SEGMENTS[0])[0],
  };
}

describe('a broadcast the stall reaper ended, and the one that follows it on the same topic', () => {
  it('ends the first broadcast from the reaper alone, with a closing window and then a recording', async () => {
    const harness = reapHarness();

    harness.start();
    await harness.segment(A_SEGMENTS[0], 0);
    await harness.written(A_SEGMENTS[0]);
    assert.equal(harness.orchestrator.getActiveStreamCount(), 1, 'the broadcast is live before the engine dies');

    await harness.reap();
    await waitFor(() => harness.recordings.length === 1, SETTLE_CEILING_MS);

    const snapshot = harness.orchestrator.getMetricsSnapshot();
    assert.equal(snapshot.streamsReapedTotal, 1, 'the reaper is what decided this broadcast was over');
    assert.equal(snapshot.streamsFinalizedTotal, 1, 'and its finalize uploaded the recording');
    assert.equal(closingWindows(harness.windows).length, 1, 'one closing window ends the live playlist');
    assert.ok(harness.windows.at(-1)?.playlist.includes(ENDLIST_TAG), 'and nothing is written after it');
  });

  it('numbers the successor′s first window on from the closing window the reaper left, and seams it', async () => {
    const { aClosing, bFirstLive } = await reapedThenSucceeded(reapHarness());

    assert.equal(
      mediaSequenceOf(bFirstLive.playlist),
      mediaSequenceOf(aClosing.playlist) + entryCount(aClosing.playlist),
      'a media sequence that moved backwards is what hls.js reports as a fatal parsing error',
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

  /**
   * ⛔ A window is a live playlist and never a recording, so nothing of the first broadcast reaches the
   * second's recording. Each broadcast's recording is its own, and the length reported is its own.
   */
  it('finalizes the successor as a recording of its own media', async () => {
    const { harness } = await reapedThenSucceeded(reapHarness());

    await harness.orchestrator.stopStream(harness.streamId);
    await waitFor(() => harness.recordings.length === 2, SETTLE_CEILING_MS);

    const bRecording = harness.recordings[1];
    const uris = bRecording
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('segment-'));
    assert.deepEqual(
      uris,
      B_SEGMENTS.map((label) => `segment-${label}`),
    );
    assert.ok(bRecording.trimEnd().endsWith(ENDLIST_TAG), 'and it is a finished playlist');
    assert.deepEqual(harness.reportedRecordingSeconds, [
      A_SEGMENTS.length * SEGMENT_SECONDS,
      B_SEGMENTS.length * SEGMENT_SECONDS,
    ]);
  });

  /**
   * The same handover on the arm production actually takes now: the encoder disconnected, its
   * `on_unpublish` reported that and ended nothing, and nothing came back inside the window.
   *
   * ⛔ **A disconnect must reach the reaper's own path rather than a shorter one.** It ends nothing
   * itself, so what finalizes the broadcast is the same timer that finalizes one whose engine died.
   */
  it('continues from the closing window the reaper wrote after the encoder disconnected', async () => {
    const harness = reapHarness();

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

    // The encoder comes back, too late. That is a new broadcast on the same topic.
    harness.start();
    for (const [index, label] of B_SEGMENTS.entries()) {
      await harness.segment(label, index);
    }
    await harness.written(B_SEGMENTS[B_SEGMENTS.length - 1]);

    const aClosing = closingWindows(harness.windows)[0];
    const bFirstLive = windowsNaming(harness.windows, B_SEGMENTS[0])[0];
    assert.equal(
      mediaSequenceOf(bFirstLive.playlist),
      mediaSequenceOf(aClosing.playlist) + entryCount(aClosing.playlist),
      'the returning broadcast numbered on from the window the reaper left',
    );
    assert.equal(seamCount(bFirstLive.playlist), 1, 'with the join declared once');
  });

  /**
   * ⛔ A rung′s topic is derived from its ladder group and its rung name rather than declared, so it
   * is stable across the two sessions for a different reason from the single declared stream above,
   * and the reaper releases the ladder on its way out, so the successor derives the topic again from
   * the declaration rather than finding it remembered.
   */
  it('continues a ladder rung whose topic is derived rather than declared', async () => {
    const harness = reapHarness({ ladder: true });
    const { aClosing, bFirstLive } = await reapedThenSucceeded(harness);

    assert.equal(
      mediaSequenceOf(bFirstLive.playlist),
      mediaSequenceOf(aClosing.playlist) + entryCount(aClosing.playlist),
      'the rung came back onto the topic it was already writing, which is what deriving the topic buys',
    );
    assert.equal(seamCount(bFirstLive.playlist), 1, 'with the restart declared as a break');
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
   * The successor must write no window and, more sharply, must **not scan the topic at all** while the
   * finalize runs: a scan that happened would prove the gate had been passed.
   */
  it('holds a successor announced while the reaper′s recording upload is still in flight', async () => {
    const harness = reapHarness({ blockRecording: true });
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
        () => harness.scanReads() === readsBefore && windowsNaming(harness.windows, B_SEGMENTS[0]).length === 0,
        QUIET_WINDOW_MS,
      );
    } finally {
      harness.releaseRecording();
    }
  });

  it('lets the held successor continue from the closing window once that finalize is done', async () => {
    const harness = reapHarness({ blockRecording: true });
    try {
      harness.start();
      await harness.segment(A_SEGMENTS[0], 0);
      await harness.written(A_SEGMENTS[0]);

      await harness.reap();
      await waitFor(harness.recordingUploadStarted, SETTLE_CEILING_MS);

      harness.start();
      await harness.segment(B_SEGMENTS[0], 0);

      harness.releaseRecording();
      await waitFor(() => harness.recordings.length === 1, SETTLE_CEILING_MS);
      await harness.written(B_SEGMENTS[0]);

      const aClosing = closingWindows(harness.windows)[0];
      const bFirstLive = windowsNaming(harness.windows, B_SEGMENTS[0])[0];
      assert.equal(
        mediaSequenceOf(bFirstLive.playlist),
        mediaSequenceOf(aClosing.playlist) + entryCount(aClosing.playlist),
        'so its numbering carries on from the window that ended the first broadcast',
      );
      assert.equal(seamCount(bFirstLive.playlist), 1);
    } finally {
      harness.releaseRecording();
    }
  });
});
