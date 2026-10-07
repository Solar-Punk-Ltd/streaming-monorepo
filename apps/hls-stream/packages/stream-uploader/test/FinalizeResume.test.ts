import { Bee, FeedIndex, PrivateKey } from '@ethersphere/bee-js';
import { ladderFinalized, recordingUploaded, updatingStreamToVod } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { Logger } from '../src/libs/Logger.js';
import { inheritedTimeline, ManifestManager } from '../src/libs/ManifestManager.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import {
  LadderMembership,
  MEDIA_TYPE_VIDEO,
  SegmentEntry,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_VOD,
  StreamStatus,
} from '../src/types.js';

import {
  fakeRecordingReference,
  makeFakeBee,
  makeFakeCatalog,
  makeFakeRecoveryStore,
  TEST_ANCHOR,
  TEST_WINDOWS,
  testPublisher,
} from './helpers/fakes.js';

/**
 * ## Scenario H, as a unit: a finalize that comes back after a crash ends with one correct entry
 *
 * `StreamUploader.finalize` writes the closing window, uploads the recording playlist, then writes
 * the catalog, and deletes the recovery entry last of all. A kill anywhere after the recording is
 * uploaded therefore leaves a recording on Swarm under an entry that still says the broadcast is
 * recoverable, and the next boot finalizes again.
 *
 * On feeds that cost a second recording at a higher index, so a recovered finalize had to read the
 * feed head first. On windows nothing has to be read: the recording is addressed by its content, so
 * the recovered session builds the same playlist from the same recovery entry, uploads the same bytes
 * and gets the same reference, and repeats the report. Behaviour B18 of the windows plan.
 */

const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const RUNG_TOPIC = 'rung-topic-1080p';
const LADDER_GROUP = 'group-h';

const SEGMENTS: SegmentEntry[] = [
  { index: 40, duration: 1, ref: 'ref40', discontinuity: false },
  { index: 41, duration: 1, ref: 'ref41', discontinuity: false },
];

/** The recording the crashed process uploaded, as `ManifestManager` builds it from the same entry. */
function recordingOf(segments: SegmentEntry[]): string {
  const manager = new ManifestManager(TEST_ANCHOR);
  manager.restoreState(segments, ['#EXTM3U', '#EXT-X-VERSION:3']);
  return manager.buildVODManifest();
}

const RECORDING = recordingOf(SEGMENTS);
const RECORDING_REFERENCE = fakeRecordingReference(RECORDING);

interface RecoveredUploader {
  uploader: StreamUploader;
  /** Every recording playlist this finalize uploaded. */
  recordings: string[];
  /** Stream ids whose recovery entry was deleted. */
  removed: string[];
  /** Window chunks and feed heads read, which a recovered finalize has no reason to read. */
  reads: () => number;
}

interface RecoveredOptions {
  catalog?: StreamCatalog;
  ladder?: LadderMembership;
  /** The recording this session had inherited before it died, as its recovery entry carried it. */
  inherited?: ReturnType<ManifestManager['inheritedPrefix']>;
}

const STREAM_ID = 'live/stream_1080p';

function makeRecovered(options: RecoveredOptions = {}): RecoveredUploader {
  const recordings: string[] = [];
  const removed: string[] = [];
  let reads = 0;

  const bee = makeFakeBee({
    uploadRecording: async (playlist) => {
      recordings.push(playlist);
      const reference = fakeRecordingReference(playlist);
      return { reference: { toHex: () => reference } };
    },
    windowAt: () => {
      reads++;
      return null;
    },
    feedHead: () => {
      reads++;
      return null;
    },
  });

  const recoveryStore = makeFakeRecoveryStore({
    remove: (streamId: string) => {
      removed.push(streamId);
    },
  });

  const uploader = new StreamUploader({
    anchor: TEST_ANCHOR,
    publisher: testPublisher(bee),
    streamCatalog: options.catalog ?? makeFakeCatalog(),
    recoveryStore,
    streamKey: TEST_STREAM_KEY,
    redundancyLevel: 0,
    streamId: STREAM_ID,
    streamTopic: RUNG_TOPIC,
    mediatype: MEDIA_TYPE_VIDEO,
    ladder: options.ladder,
    restoreState: {
      streamRawTopic: RUNG_TOPIC,
      segments: SEGMENTS,
      hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
      isFirstSegmentReady: true,
      isFirstManifestReady: true,
      inherited: options.inherited ?? undefined,
    },
    ...TEST_WINDOWS,
  });

  return { uploader, recordings, removed, reads: () => reads };
}

/** What a catalog feed write puts into the sequence below, so an ordering can be read off it. */
const CATALOG_WRITE = '<catalog feed write>';

/**
 * Everything that happened while `run` was in flight, appended to `sequence` in order: every log line,
 * and every catalog feed write for a fixture that records them. One array, because the assertion that
 * needs this is about which of the two came first.
 */
async function sequenceDuring(sequence: string[], run: () => Promise<void>): Promise<string[]> {
  const logger = Logger.getInstance();
  const previous = logger.configure({ sink: (_level, line) => sequence.push(line) });
  try {
    await run();
  } finally {
    logger.configure(previous);
  }
  return sequence;
}

/** The log lines written while `run` is in flight, with the previous sink restored afterwards. */
async function logLinesDuring(run: () => Promise<void>): Promise<string[]> {
  return sequenceDuring([], run);
}

const linesHolding = (lines: string[], message: string): number => lines.filter((l) => l.includes(message)).length;

/**
 * A stand-in nothing in these messages can contain, so a composed message splits cleanly into the
 * fixed half a negative assertion should be anchored on.
 */
const MESSAGE_PROBE = 'MESSAGEPROBE';

/**
 * The fixed opening of the flip announce, split back out of its composer rather than written out
 * beside it. A negative assertion on a hardcoded literal is the one that cannot fail.
 */
const VOD_FLIP_ANNOUNCE = updatingStreamToVod(MESSAGE_PROBE).split(MESSAGE_PROBE)[0];

describe('a single-rendition finalize that comes back after a crash', () => {
  it('uploads the same recording again, under the same reference, and lists it', async () => {
    const entries: { state: string; recording?: string; index?: number }[] = [];
    const { uploader, recordings, removed } = makeRecovered({
      catalog: makeFakeCatalog({
        addStream: async (entry: { state: string; recording?: string; index?: number }) => {
          entries.push(entry);
          return true;
        },
      }),
    });

    const lines = await logLinesDuring(() => uploader.notifyStop());

    assert.deepEqual(recordings, [RECORDING], 'the recording is rebuilt byte for byte from the entry the crash left');
    assert.equal(linesHolding(lines, recordingUploaded(STREAM_ID, RECORDING_REFERENCE)), 1);
    assert.equal(entries.length, 1, 'the catalog write is the step the crash cut short and still has to run');
    assert.equal(entries[0].state, 'vod');
    assert.equal(entries[0].recording, RECORDING_REFERENCE, 'naming the recording the crashed process uploaded');
    assert.equal(entries[0].index, undefined);
    assert.deepEqual(removed, [STREAM_ID], 'a finished broadcast must leave no recovery entry');
  });

  /**
   * ⛔ Nothing is asked of Swarm before the recording goes up again. A recovered session already holds
   * its numbering, and the reference answers for the recording, so there is no question left that a
   * read could answer.
   */
  it('reads nothing off Swarm before it finalizes', async () => {
    const { uploader, reads } = makeRecovered();

    await uploader.notifyStop();

    assert.equal(reads(), 0);
  });

  it('defers the finalize when the recording could not be uploaded, and leaves the recovery entry behind', async () => {
    const removed: string[] = [];
    const bee = makeFakeBee({
      uploadRecording: () => Promise.reject({ status: 402, message: 'fake bee refused the recording' }),
    });
    const uploader = new StreamUploader({
      anchor: TEST_ANCHOR,
      publisher: testPublisher(bee),
      streamCatalog: makeFakeCatalog(),
      recoveryStore: makeFakeRecoveryStore({ remove: (id: string) => removed.push(id) }),
      streamKey: TEST_STREAM_KEY,
      redundancyLevel: 0,
      streamId: STREAM_ID,
      streamTopic: RUNG_TOPIC,
      mediatype: MEDIA_TYPE_VIDEO,
      restoreState: {
        streamRawTopic: RUNG_TOPIC,
        segments: SEGMENTS,
        hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
        isFirstSegmentReady: true,
        isFirstManifestReady: true,
      },
      ...TEST_WINDOWS,
    });

    await assert.rejects(() => uploader.notifyStop(), /Failed to upload the recording/);

    assert.deepEqual(removed, [], 'the entry is the only record the broadcast was live, so a deferral keeps it');
  });
});

/** One write the catalog feed took, as a reader would parse it back. */
interface CatalogWrite {
  index: FeedIndex;
  payload: string;
}

/**
 * A catalog feed that hands back whatever was last written to it, which is what a reboot reads.
 *
 * @param onWrite called as each write lands, so a test can place the write among the log lines around
 * it. Only the ordering test supplies one.
 */
function catalogFeedBee(writes: CatalogWrite[], onWrite: () => void = () => {}): Bee {
  const latest = () => (writes.length === 0 ? [] : JSON.parse(writes[writes.length - 1].payload));
  return {
    feed: {
      makeReader: () => ({
        downloadPayload: async (opts?: { index?: FeedIndex }) =>
          opts?.index
            ? { payload: { toJSON: latest } }
            : { feedIndex: FeedIndex.fromBigInt(BigInt(writes.length)), payload: { toJSON: latest } },
      }),
      makeWriter: () => ({
        uploadPayload: async (_stamp: string, payload: unknown, opts: { index: FeedIndex }) => {
          writes.push({ index: opts.index, payload: String(payload) });
          onWrite();
          return { reference: { toHex: () => 'ref' } };
        },
      }),
    },
    connectivity: {
      isConnected: async () => true,
    },
  } as unknown as Bee;
}

function makeCatalog(bee: Bee): StreamCatalog {
  const publisher = { rung: SINGLE_PUBLISHER, url: 'http://fake-bee:1633', stamp: 'stamp', bee };
  const publishers = { coordinator: () => publisher, forRung: () => publisher } as unknown as BeePublisherPool;
  return new StreamCatalog(publishers, TEST_STREAM_KEY, 'catalog-topic');
}

const heldEntry = (writes: CatalogWrite[]) =>
  (
    JSON.parse(writes[writes.length - 1].payload) as Array<{
      state: StreamStatus;
      recording?: string;
      renditions?: { name: string; recording?: string }[];
    }>
  )[0];

const LADDER: LadderMembership = {
  group: LADDER_GROUP,
  rung: { name: '1080p', width: 1920, height: 1080, configuredKbps: 5000 },
};

/**
 * ⚠️ The owner the recovered uploader will announce as, derived from the same key. Written out as a
 * literal instead, the pre-crash entries belong to a different owner, `buildLadderEntry` finds no
 * previous entry and every announce reads as the first flip. That is the fixture failing, not the
 * guard, and it looks identical to the defect.
 */
const STREAM_OWNER = new PrivateKey(TEST_STREAM_KEY).publicKey().address().toHex();

const LADDER_IDENTITY = { title: 'title', owner: STREAM_OWNER, group: LADDER_GROUP, mediatype: MEDIA_TYPE_VIDEO };

const rungOf360p = { name: '360p', width: 640, height: 360, topic: 'rung-topic-360p' };
const rungOf1080p = { name: '1080p', width: 1920, height: 1080, topic: RUNG_TOPIC };

const live360p = { ...rungOf360p, bandwidth: 800_000, avgBandwidth: 700_000 };
const live1080p = { ...rungOf1080p, bandwidth: 5_000_000, avgBandwidth: 4_500_000 };

/** 360p's recording, built rather than written out. */
const RECORDING_360P = 'ab'.repeat(32);

/**
 * The catalog feed as the crash left it, walked through the sequence a real broadcast takes: every
 * rung announces itself live at session start, and each contributes its recording when it finalizes.
 *
 * ⚠️ The order is load-bearing rather than decorative. Announcing a finished rung first would flip the
 * whole entry to VOD on that one announce, because a ladder is finished when every rung it has
 * announced carries a recording, and one rung is every rung.
 *
 * @param finished whether 1080p already contributed its recording before the crash, which is the
 * whole difference between a feed left saying `vod` and one left honestly saying `live`.
 */
async function ladderInTheFeed(catalog: StreamCatalog, finished: boolean): Promise<void> {
  await catalog.upsertRendition(LADDER_IDENTITY, live360p);
  await catalog.upsertRendition(LADDER_IDENTITY, live1080p);
  await catalog.upsertRendition(LADDER_IDENTITY, { ...live360p, recording: RECORDING_360P, duration: 2 });
  if (finished) {
    await catalog.upsertRendition(LADDER_IDENTITY, { ...live1080p, recording: RECORDING_REFERENCE, duration: 2 });
  }
}

describe('a recovered ladder rung whose entry outlived the recording', () => {
  /**
   * ⛔⛔⛔ The measured case, end to end. Ladder flipped, uploader killed, one rung's entry survived,
   * reboot recovered it and the recovery timer finalized it again. The flip must still be announced
   * exactly once for the broadcast, and the entry must name the one recording that rung made.
   */
  it('names the same recording again and does not announce a second flip', async () => {
    const writes: CatalogWrite[] = [];
    const bee = catalogFeedBee(writes);
    const live = makeCatalog(bee);
    await live.init();

    const before = await logLinesDuring(() => ladderInTheFeed(live, true));
    assert.equal(linesHolding(before, ladderFinalized(LADDER_GROUP)), 1, 'the broadcast flipped once before the kill');
    assert.equal(heldEntry(writes).state, 'vod');

    // The reboot: a fresh catalog over the same feed, and the surviving rung rebuilt from its entry.
    const rebooted = makeCatalog(bee);
    await rebooted.init();
    const { uploader, removed } = makeRecovered({ catalog: rebooted, ladder: LADDER });

    const after = await logLinesDuring(() => uploader.notifyStop());

    assert.equal(
      linesHolding(after, ladderFinalized(LADDER_GROUP)),
      0,
      'a rung re-finalizing over a catalog that already says vod is not a second flip',
    );
    const finished = heldEntry(writes);
    assert.equal(finished.state, 'vod');
    assert.equal(finished.renditions?.length, 2, 'the recording must keep every rung it announced');
    assert.equal(
      finished.renditions?.find((rendition) => rendition.name === '1080p')?.recording,
      RECORDING_REFERENCE,
      'the rung names the recording it made before the crash, not a second one',
    );
    assert.deepEqual(removed, [STREAM_ID]);
  });

  /**
   * The other side of the same window: the kill landed after the recording went up and **before** the
   * catalog write, so the entry the reboot reads honestly still says live. The resume still owes that
   * write, so this is where the one flip of the broadcast is announced.
   */
  it('announces the flip once when the crash beat the catalog write', async () => {
    const writes: CatalogWrite[] = [];
    const bee = catalogFeedBee(writes);
    const live = makeCatalog(bee);
    await live.init();

    const before = await logLinesDuring(() => ladderInTheFeed(live, false));
    assert.equal(linesHolding(before, ladderFinalized(LADDER_GROUP)), 0, 'a rung still live is not a finished ladder');
    assert.equal(heldEntry(writes).state, 'live', 'the catalog write the crash cut short never landed');

    const rebooted = makeCatalog(bee);
    await rebooted.init();
    const { uploader } = makeRecovered({ catalog: rebooted, ladder: LADDER });

    const after = await logLinesDuring(() => uploader.notifyStop());

    assert.equal(linesHolding(after, ladderFinalized(LADDER_GROUP)), 1, 'the flip the crash cut short still happens');
    assert.equal(heldEntry(writes).state, 'vod');
    assert.equal(heldEntry(writes).recording, RECORDING_360P, 'the entry names its lowest rung′s recording');
  });
});

/**
 * The catalog entry a single-rendition stream publishes for itself, in whichever state a fixture
 * needs it left in. The owner and topic must be the uploader's own or `withoutTopic` finds no
 * previous entry, every announce reads as a first flip, and the fixture fails in the exact shape of
 * the defect.
 */
function singleEntry(state: StreamStatus, finished: { recording?: string; duration?: number } = {}) {
  return {
    title: 'title',
    owner: STREAM_OWNER,
    topic: RUNG_TOPIC,
    state,
    mediatype: MEDIA_TYPE_VIDEO,
    timestamp: Date.now(),
    ...finished,
  };
}

/**
 * ## The same two crash windows on the shape that has no ladder
 *
 * `Updating stream in list to VOD` is written after `addStream` and only when the entry really
 * flipped, so a crash between them cannot leave the log claiming a finished broadcast over an entry
 * that still said live, and a resumed finalize over a catalog that already said vod does not announce
 * a second flip. `vodFinalizeCount` in the e2e harness counts exactly this line.
 */
describe('a recovered single-rendition stream whose entry outlived the recording', () => {
  it('rewrites the entry without announcing a second flip when the catalog already says vod', async () => {
    const writes: CatalogWrite[] = [];
    const bee = catalogFeedBee(writes);
    const live = makeCatalog(bee);
    await live.init();

    const before = await logLinesDuring(async () => {
      await live.addStream(singleEntry(STREAM_STATUS_LIVE));
      await live.addStream(singleEntry(STREAM_STATUS_VOD, { recording: RECORDING_REFERENCE, duration: 2 }));
    });
    assert.equal(linesHolding(before, VOD_FLIP_ANNOUNCE), 0, 'the catalog does not write this line, the uploader does');
    assert.equal(heldEntry(writes).state, 'vod', 'the broadcast had already finished when the kill landed');

    const rebooted = makeCatalog(bee);
    await rebooted.init();
    const { uploader, removed } = makeRecovered({ catalog: rebooted });

    const after = await logLinesDuring(() => uploader.notifyStop());

    assert.equal(
      linesHolding(after, VOD_FLIP_ANNOUNCE),
      0,
      'a finalize re-running over a catalog that already says vod is not a second flip',
    );
    assert.equal(heldEntry(writes).state, 'vod');
    assert.equal(heldEntry(writes).recording, RECORDING_REFERENCE, 'still the one recording');
    assert.deepEqual(removed, [STREAM_ID]);
  });

  /**
   * The other side of the window: the kill landed after the recording went up and before the catalog
   * write, so the entry the reboot reads honestly still says live and the one flip of the broadcast is
   * announced here.
   */
  it('announces the flip once when the crash beat the catalog write', async () => {
    const writes: CatalogWrite[] = [];
    const bee = catalogFeedBee(writes);
    const live = makeCatalog(bee);
    await live.init();
    await live.addStream(singleEntry(STREAM_STATUS_LIVE));
    assert.equal(heldEntry(writes).state, 'live', 'the catalog write the crash cut short never landed');

    const rebooted = makeCatalog(bee);
    await rebooted.init();
    const { uploader } = makeRecovered({ catalog: rebooted });

    const after = await logLinesDuring(() => uploader.notifyStop());

    assert.equal(linesHolding(after, VOD_FLIP_ANNOUNCE), 1, 'the flip the crash cut short still happens, once');
    const finished = heldEntry(writes);
    assert.equal(finished.state, 'vod');
    assert.equal(finished.recording, RECORDING_REFERENCE, 'the entry names the recording the crashed process uploaded');
  });

  /**
   * ⛔⛔⛔ After the write, never before it. The announce going out while the feed write and everything
   * it could fail on still lay ahead of it would leave, after a crash in that gap, a log saying a
   * broadcast had ended over a catalog that said it had not.
   */
  it('writes the catalog before it announces the flip', async () => {
    const writes: CatalogWrite[] = [];
    const sequence: string[] = [];
    const bee = catalogFeedBee(writes, () => sequence.push(CATALOG_WRITE));
    const live = makeCatalog(bee);
    await live.init();
    await live.addStream(singleEntry(STREAM_STATUS_LIVE));

    const rebooted = makeCatalog(bee);
    await rebooted.init();
    const { uploader } = makeRecovered({ catalog: rebooted });

    // Cleared so the seeding write above is not the one the ordering is read against.
    sequence.length = 0;
    await sequenceDuring(sequence, () => uploader.notifyStop());

    const wroteAt = sequence.indexOf(CATALOG_WRITE);
    const announcedAt = sequence.findIndex((event) => event.includes(VOD_FLIP_ANNOUNCE));
    assert.notEqual(wroteAt, -1, 'the finalize never wrote the catalog at all');
    assert.notEqual(announcedAt, -1, 'the finalize never announced the flip at all');
    assert.ok(wroteAt < announcedAt, `the flip was announced before the write landed: ${sequence.join(' | ')}`);
  });
});

/**
 * ## A crash must not un-glue a recording a session on feeds had glued
 *
 * A session on feeds read the playlist at its feed head once and opened its recording with it, and
 * carried that prefix in its recovery entry. A session on windows inherits nothing, but an entry a
 * session on feeds wrote before the upgrade may still be recovered, and its recording must still open
 * with what it inherited.
 */
describe('a glued recording surviving a crash', () => {
  const PREVIOUS_REF = 'a'.repeat(64);
  const PREVIOUS_RECORDING = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '',
    '#EXT-X-PROGRAM-DATE-TIME:2026-09-21T10:05:21.849Z',
    '#EXTINF:2,',
    PREVIOUS_REF,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

  /** What a session on feeds put on the manager, as the recovery entry would have carried it. */
  function prefixOf(): NonNullable<ReturnType<ManifestManager['inheritedPrefix']>> {
    const manager = new ManifestManager(TEST_ANCHOR);
    const parsed = inheritedTimeline(PREVIOUS_RECORDING);
    assert.ok(parsed, 'the fixture head must be readable');
    manager.inherit(parsed!);
    return manager.inheritedPrefix()!;
  }

  function recordingAfter(inherited?: ReturnType<ManifestManager['inheritedPrefix']>): string {
    const manager = new ManifestManager(TEST_ANCHOR);
    manager.restoreState(SEGMENTS, ['#EXTM3U', '#EXT-X-VERSION:3'], inherited ?? undefined);
    manager.continueFrom(1);
    return manager.buildVODManifest();
  }

  it('rebuilds the same glued recording from the entry the crash left behind', () => {
    const recording = recordingAfter(prefixOf());

    assert.match(recording, /#EXT-X-MEDIA-SEQUENCE:0/, 'the whole broadcast′s numbering, not this session′s');
    assert.ok(recording.includes(PREVIOUS_REF), 'the session before the crash is still at the front');
    assert.ok(recording.includes('ref40') && recording.includes('ref41'));
    assert.equal(recording.split('#EXT-X-DISCONTINUITY\n').length - 1, 1, 'one seam');
  });

  it('would have recorded this session alone had the entry not carried it', () => {
    const recording = recordingAfter(undefined);

    assert.ok(!recording.includes(PREVIOUS_REF));
    assert.match(recording, /#EXT-X-MEDIA-SEQUENCE:1/);
  });

  it('uploads the glued recording once', async () => {
    const { uploader, recordings } = makeRecovered({ inherited: prefixOf() });

    await uploader.notifyStop();

    assert.equal(recordings.length, 1);
    assert.ok(recordings[0].includes('#EXT-X-PLAYLIST-TYPE:VOD'));
    assert.ok(recordings[0].includes(PREVIOUS_REF), 'the recovered recording is still glued');
  });
});
