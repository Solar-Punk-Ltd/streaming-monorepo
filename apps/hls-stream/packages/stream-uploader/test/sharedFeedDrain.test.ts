import { LIVE_PLAYLIST_WINDOW_MS, parseLiveWindowPayload } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminApiClient, STATE_REPORT_ACCEPTED } from '../src/libs/AdminApiClient.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_AUDIO, STOP_FAILURE_DRAIN_TIMEOUT, STREAM_LIFECYCLE_FAILED } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import {
  advanceUntil,
  fakeRecordingReference,
  makeFakeRecoveryStore,
  makeRecoveredState,
  makeTestOrchestrator,
  onTheFakeClock,
  untilSettled,
} from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

const STREAM_ID = 'audio/declared-stream';
const DECLARATION: AdminSession = { id: 'admin-stream-id', topic: 'declared-topic' };
const DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const SETTLE_CEILING_MS = 4_000;
/** Windows of the fake clock a gated successor is watched across, enough for a held window to have escaped. */
const QUIET_WINDOWS = 5;

/** One live window written, its playlist without the written-at line. */
interface WindowWrite {
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

/**
 * One declared topic whose first recording upload stays in flight until the test releases it.
 *
 * Every window chunk is kept at its identifier, so a successor's opening scan finds exactly the
 * windows its predecessor wrote. This models the part the handover gate protects: a successor that
 * wrote while the predecessor was still finalizing would share the predecessor's window addresses,
 * and one that scanned then would read a topic still moving.
 */
function sharedTopicHarness(options: { recovered?: boolean } = {}): {
  orchestrator: StreamOrchestrator;
  clock: FakeClock;
  windows: WindowWrite[];
  uploadedSegments: string[];
  scanReads: () => number;
  releaseFirstRecording: () => void;
  firstRecordingStarted: () => boolean;
  recordingsLanded: () => number;
  start: () => void;
  segment: (label: string, index: number) => Promise<void>;
  /** Step the fake clock a window at a time until `condition` holds. */
  settle: (condition: () => boolean) => Promise<void>;
  /** Step the fake clock across {@link QUIET_WINDOWS} windows, for a case that asserts nothing moved. */
  quiet: () => Promise<void>;
  /** Step the fake clock until `work` has settled, then await it, so a stop never hangs on a window. */
  untilSettled: (work: Promise<void>) => Promise<void>;
} {
  const clock = new FakeClock();
  const firstRecording = deferred();
  const windows: WindowWrite[] = [];
  const uploadedSegments: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const recordings = new Map<string, string>();
  let reads = 0;
  let blockFirstRecording = true;
  let recordingStarted = false;
  let recordingsLanded = 0;

  const adminApi = {
    describe: () => 'http://admin.test',
    reportState: async () => STATE_REPORT_ACCEPTED,
  } as unknown as AdminApiClient;

  const recoveredState = {
    ...makeRecoveredState(STREAM_ID),
    streamRawTopic: DECLARATION.topic,
    mediatype: MEDIA_TYPE_AUDIO,
    adminStreamId: DECLARATION.id,
  };
  const recoveryStore = options.recovered
    ? makeFakeRecoveryStore({
        listActive: () => [STREAM_ID],
        load: () => recoveredState,
      })
    : makeFakeRecoveryStore();

  const orchestrator = makeTestOrchestrator(
    {
      adminApi,
      // The real window length, since every case jumps through the five minute drain deadline at once.
      ...onTheFakeClock(clock, LIVE_PLAYLIST_WINDOW_MS),
      // Advancing through the five minute drain deadline must not reap the live successor.
      orphanReapMs: DRAIN_TIMEOUT_MS * 4,
    },
    {
      uploadData: async (_stamp, data) => {
        const label = Buffer.from(data).toString('utf8');
        uploadedSegments.push(label);
        return { reference: { toHex: () => `segment-${label}` } };
      },
      uploadWindow: async (identifier, payload) => {
        windows.push({ playlist: parseLiveWindowPayload(payload)?.playlist ?? '' });
        stored.set(identifier, payload);
        return { reference: { toHex: () => 'window' } };
      },
      windowAt: (identifier) => {
        reads += 1;
        return stored.get(identifier) ?? null;
      },
      uploadRecording: async (playlist) => {
        if (blockFirstRecording) {
          blockFirstRecording = false;
          recordingStarted = true;
          await firstRecording.promise;
        }
        recordingsLanded += 1;
        const reference = fakeRecordingReference(playlist);
        recordings.set(reference, playlist);
        return { reference: { toHex: () => reference } };
      },
      // An unknown reference answers undefined, which the fake bee turns into a 404.
      downloadRecording: async (reference) => recordings.get(reference) as string,
    },
    recoveryStore,
  );

  return {
    orchestrator,
    clock,
    windows,
    uploadedSegments,
    scanReads: () => reads,
    releaseFirstRecording: firstRecording.resolve,
    firstRecordingStarted: () => recordingStarted,
    recordingsLanded: () => recordingsLanded,
    start: () => {
      assert.equal(
        orchestrator.startStream(STREAM_ID, MEDIA_TYPE_AUDIO, undefined, DECLARATION),
        true,
        'the declared session must be admitted',
      );
    },
    segment: async (label, index) => {
      assert.deepEqual(orchestrator.handleSegment(STREAM_ID, index, 2, Buffer.from(label)), { accepted: true });
      await waitFor(() => uploadedSegments.includes(label), SETTLE_CEILING_MS);
    },
    settle: (condition) => advanceUntil(clock, condition, LIVE_PLAYLIST_WINDOW_MS),
    quiet: () => clock.advance(QUIET_WINDOWS * LIVE_PLAYLIST_WINDOW_MS),
    untilSettled: (work) => untilSettled(clock, work, LIVE_PLAYLIST_WINDOW_MS),
  };
}

type Harness = ReturnType<typeof sharedTopicHarness>;

function windowsNaming(windows: WindowWrite[], segment: string): WindowWrite[] {
  return windows.filter((write) => write.playlist.includes(`segment-${segment}`));
}

function mediaSequenceOf(playlist: string): number {
  return Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist)?.[1]);
}

function entryCount(playlist: string): number {
  return playlist.split('\n').filter((line) => line.startsWith('#EXTINF:')).length;
}

/**
 * Get a predecessor as far as its recording upload and leave it stuck there, with a successor
 * registered under the same id and gated behind it.
 *
 * ⛔ **The stop is what makes two sessions, and it has to come first.** A bare re-announce of a live
 * session resumes it, which is the encoder-reconnect path and has no predecessor to wait for: the
 * gate this file is about exists only while a stop of that id is still finalizing, because that is
 * the only window in which two sessions hold one topic and both want to write on it.
 *
 * ⛔ The stop is handed back **wrapped**, so a caller can settle it after releasing the upload it is
 * blocked on. `Promise<Promise<void>>` collapses, so returning it bare would wait out the whole stop.
 */
async function beginBlockedRecording(harness: Harness): Promise<{ stopping: Promise<void> }> {
  harness.start();
  await harness.segment('a0', 0);
  await harness.settle(() => windowsNaming(harness.windows, 'a0').length > 0);
  // ⛔ The successor is registered in the same turn the stop is, which is the interleaving the
  // deployment produces: `stopStream` registers its drain before its first await, so the announce
  // that follows it takes the replacement branch and is handed the predecessor's write completion.
  const stopping = harness.orchestrator.stopStream(STREAM_ID);
  harness.start();
  // The predecessor's closing window comes before its recording, and it ends only as the clock moves.
  await harness.settle(harness.firstRecordingStarted);
  return { stopping };
}

/**
 * Let the predecessor's recording land, and show the successor then continues from the closing
 * window its predecessor left rather than numbering over it.
 *
 * Where the case first ran out the five minute drain deadline, the closing window is older than the
 * minute a successor's opening scan reads back, so the numbering comes from the predecessor's
 * recording, which ends at the same sequence. That is the path a deployment takes after such a wait.
 */
async function releaseAndWriteSuccessor(
  harness: Harness,
  successorSegment: string,
  successorIndex: number,
): Promise<void> {
  harness.releaseFirstRecording();
  await harness.settle(() => harness.recordingsLanded() > 0);
  await new Promise((resolve) => setImmediate(resolve));
  await harness.segment(successorSegment, successorIndex);
  await harness.settle(() => windowsNaming(harness.windows, successorSegment).length > 0);

  const closing = harness.windows.find((write) => write.playlist.includes('#EXT-X-ENDLIST'));
  const successor = windowsNaming(harness.windows, successorSegment)[0];
  assert.ok(closing, 'the predecessor ended its playlist before its recording');
  assert.equal(
    mediaSequenceOf(successor.playlist),
    mediaSequenceOf(closing.playlist) + entryCount(closing.playlist),
    'the successor must continue the numbering its predecessor′s closing window left',
  );
}

async function releaseOutstandingRecording(harness: Harness): Promise<void> {
  harness.releaseFirstRecording();
  await new Promise((resolve) => setImmediate(resolve));
}

describe('a shared topic waits for every outstanding predecessor write', () => {
  it('keeps a re-announced successor gated after the bounded predecessor stop times out', async () => {
    const harness = sharedTopicHarness();
    const { stopping } = await beginBlockedRecording(harness);
    try {
      await harness.segment('b0', 0);
      const readsBeforeDeadline = harness.scanReads();
      await harness.clock.advance(DRAIN_TIMEOUT_MS + 1);
      await harness.segment('b1', 1);

      await harness.quiet();
      assert.equal(harness.scanReads(), readsBeforeDeadline, 'the successor scanned the topic while gated');
      assert.deepEqual(windowsNaming(harness.windows, 'b0'), [], 'and wrote a window');

      await releaseAndWriteSuccessor(harness, 'b2', 2);
    } finally {
      await releaseOutstandingRecording(harness);
      await harness.untilSettled(stopping);
    }
  });

  it('keeps a fresh session gated when an explicit stop timed out but its recording upload is still running', async () => {
    const harness = sharedTopicHarness();
    try {
      harness.start();
      await harness.segment('a0', 0);
      await harness.settle(() => windowsNaming(harness.windows, 'a0').length > 0);

      const stopped = harness.orchestrator.stopStream(STREAM_ID);
      await harness.settle(harness.firstRecordingStarted);
      await harness.clock.advance(DRAIN_TIMEOUT_MS + 1);
      await harness.untilSettled(stopped);

      const timedOutStatus = harness.orchestrator.getStreamStatus(STREAM_ID);
      assert.equal(timedOutStatus.state, STREAM_LIFECYCLE_FAILED);
      assert.equal(timedOutStatus.reason, STOP_FAILURE_DRAIN_TIMEOUT);

      harness.start();
      const readsBeforeSuccessor = harness.scanReads();
      await harness.segment('b0', 0);

      await harness.quiet();
      assert.equal(harness.scanReads(), readsBeforeSuccessor, 'the successor scanned the topic while gated');
      assert.deepEqual(windowsNaming(harness.windows, 'b0'), [], 'and wrote a window');

      await releaseAndWriteSuccessor(harness, 'b1', 1);
    } finally {
      await releaseOutstandingRecording(harness);
    }
  });

  it('keeps a fresh declared session gated after a recovered admin session times out', async () => {
    const harness = sharedTopicHarness({ recovered: true });
    try {
      assert.deepEqual(await harness.orchestrator.recoverStreams(), [STREAM_ID]);

      const stopped = harness.orchestrator.stopStream(STREAM_ID);
      await harness.settle(harness.firstRecordingStarted);
      await harness.clock.advance(DRAIN_TIMEOUT_MS + 1);
      await harness.untilSettled(stopped);

      const timedOutStatus = harness.orchestrator.getStreamStatus(STREAM_ID);
      assert.equal(timedOutStatus.state, STREAM_LIFECYCLE_FAILED);
      assert.equal(timedOutStatus.reason, STOP_FAILURE_DRAIN_TIMEOUT);

      harness.start();
      const readsBeforeSuccessor = harness.scanReads();
      await harness.segment('b0', 0);

      await harness.quiet();
      assert.equal(harness.scanReads(), readsBeforeSuccessor, 'the successor scanned the topic while gated');
      assert.deepEqual(windowsNaming(harness.windows, 'b0'), [], 'and wrote a window');

      await releaseAndWriteSuccessor(harness, 'b1', 1);
    } finally {
      await releaseOutstandingRecording(harness);
    }
  });

  it('inherits A through a failed B finalize when A, B and C share one topic', async () => {
    const harness = sharedTopicHarness();
    const { stopping } = await beginBlockedRecording(harness);
    try {
      await harness.segment('b0', 0);

      // B's own stop. Its finalize cannot write anything, because it is still gated behind the upload
      // A is blocking, so it fails, which is the whole point: C has to inherit A's pending write
      // through a middle session that never completed one of its own.
      const stoppingB = harness.orchestrator.stopStream(STREAM_ID);
      harness.start();
      // B's finalize gives up on its closing window after the windows it allows, so the clock moves it.
      await harness.untilSettled(stoppingB);
      // ⚠️ At least one rather than exactly one, because A's own stop is in flight throughout.
      await harness.settle(() => harness.orchestrator.getMetricsSnapshot().streamsFailedTotal >= 1);

      const readsBeforeC = harness.scanReads();
      await harness.segment('c0', 0);
      await harness.quiet();
      assert.equal(harness.scanReads(), readsBeforeC, 'C scanned the topic while gated');
      assert.deepEqual(windowsNaming(harness.windows, 'c0'), [], 'and wrote a window');

      await releaseAndWriteSuccessor(harness, 'c1', 1);
    } finally {
      await releaseOutstandingRecording(harness);
      await harness.untilSettled(stopping);
    }
  });
});
