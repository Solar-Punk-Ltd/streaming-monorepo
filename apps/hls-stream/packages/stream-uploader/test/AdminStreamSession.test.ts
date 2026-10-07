/**
 * What admin mode changes about a broadcast once the gate has admitted it: whose topic it writes its
 * live windows on, where its numbering on that topic continues from, and who is told that it went live
 * and became a recording.
 *
 * ## The four properties, and why each one is here
 *
 * 1. **The topic belongs to the declaration.** A standalone single-rendition session mints a fresh
 *    `crypto.randomUUID()` topic, so nothing was ever written on it. A declared stream keeps one topic
 *    for its whole life, which is what makes it reachable before it has ever published, and what makes
 *    a second session on it something to be careful with.
 * 2. **So the numbering continues from the topic's newest window.** A viewer who was following the last
 *    broadcast is handed this session's first window as the next update of the playlist they are
 *    playing, and a media sequence that moved backwards is what hls.js reports as a parsing error. The
 *    newest window is the only thing that knows: this process may never have seen the earlier session.
 * 3. **Nothing is written to the stream catalog, and the admin is told instead.** The admin owns the
 *    list of streams here, so a second writer would publish entries nothing reconciles. The two
 *    reports land at exactly the two moments the catalog's own entries would have, carrying exactly
 *    what those entries would have carried.
 * 4. **And a replacement session waits for the one it replaced.** A re-announce leaves the retired
 *    session writing its own closing windows on this same topic, and two writers on one window address
 *    are as bad as two on one feed index.
 */

import { encodeLiveWindowPayload, ladderFinalized, parseLiveWindowPayload } from '@swarm-hls-stream/shared';
import { BeeResponseError } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_STATE_LIVE,
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStateReport,
  STATE_REPORT_ACCEPTED,
  STATE_REPORT_FAILED,
  StateReportOutcome,
} from '../src/libs/AdminApiClient.js';
import { LadderRegistry, RenditionAnnouncement } from '../src/libs/LadderRegistry.js';
import { Logger } from '../src/libs/Logger.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO, Rendition, StreamState } from '../src/types.js';

import {
  fakeRecordingReference,
  makeFakeBee,
  makeFakeCatalog,
  makeFakeRecoveryStore,
  makeTestOrchestrator,
  TEST_ANCHOR,
  TEST_LIVE_WINDOW_MS,
  TEST_WINDOWS,
  testPublisher,
} from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const STREAM_ID = 'video/demo';
const DECLARED_TOPIC = 'declared-topic-0001';
const ADMIN_STREAM_ID = 'str_01HZY';
const SETTLE_CEILING_MS = 4_000;

/** The closing window a previous broadcast on this topic left: six entries behind it and one in it. */
const PREVIOUS_ON_THIS_TOPIC = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:6',
  '',
  '#EXT-X-PROGRAM-DATE-TIME:2026-09-21T10:05:21.849Z',
  '#EXTINF:2,',
  'd'.repeat(64),
  '#EXT-X-ENDLIST',
  '',
].join('\n');

/** A window chunk holding that playlist, as a reader of the topic finds it. */
const PREVIOUS_WINDOW = encodeLiveWindowPayload(PREVIOUS_ON_THIS_TOPIC, 1_000);

/** A read failure that is not Bee saying the chunk is absent, which says nothing about the topic. */
const windowReadRefused = () => new BeeResponseError('GET', '/chunks', 'refused', undefined, 400, 'Bad Request');

/** Bee's answer for a window nobody wrote. */
const windowAbsent = () => new BeeResponseError('GET', '/chunks', 'Not Found', undefined, 404, 'Not Found');

/** One live window this session wrote, its playlist without the written-at line. */
interface WindowWrite {
  identifier: string;
  playlist: string;
}

interface Session {
  uploader: StreamUploader;
  /** Every live window this session wrote, in order. */
  windows: WindowWrite[];
  /** Every recording playlist this session uploaded. */
  recordings: string[];
  /** Every catalog entry written. In admin mode this must stay empty. */
  catalogEntries: unknown[];
  /** Every state report delivered to the admin, in order. */
  reports: AdminStateReport[];
  /** Every state the recovery entry was saved in. */
  saved: StreamState[];
}

interface SessionOptions {
  /**
   * What a window of this topic holds when the opening scan asks, or throws. Absent answers 404 for
   * every window, which is a topic nothing has written recently.
   */
  windowAt?: () => Uint8Array | null;
  /** Answer for each report in turn, so a failure can be driven. Defaults to accepting every one. */
  reportOutcome?: (report: AdminStateReport) => StateReportOutcome;
  /** Built without `admin`, which is the standalone deployment this service has always been. */
  standalone?: boolean;
  /** The finalize of the session this one replaced, when this session is a re-announce's replacement. */
  predecessorDrained?: Promise<void>;
}

function playlistOf(payload: Uint8Array): string {
  return parseLiveWindowPayload(payload)?.playlist ?? '';
}

/**
 * A fresh session on a declared topic.
 *
 * The admin client is a stand-in rather than a real one over an injected fetch, because what these
 * cases are about is which reports the uploader decides to make and in what order.
 * `AdminApiClient.test.ts` is where the call itself is driven.
 */
function newSession(options: SessionOptions = {}): Session {
  const windows: WindowWrite[] = [];
  const recordings: string[] = [];
  const catalogEntries: unknown[] = [];
  const reports: AdminStateReport[] = [];
  const saved: StreamState[] = [];

  const bee = makeFakeBee({
    uploadWindow: async (identifier, payload) => {
      windows.push({ identifier, playlist: playlistOf(payload) });
      return { reference: { toHex: () => 'window' } };
    },
    windowAt: () => (options.windowAt ? options.windowAt() : null),
    uploadRecording: async (playlist) => {
      recordings.push(playlist);
      const reference = fakeRecordingReference(playlist);
      return { reference: { toHex: () => reference } };
    },
  });

  const client = {
    describe: () => 'http://admin.test:9877',
    reportState: async (_id: string, report: AdminStateReport) => {
      reports.push(report);
      return options.reportOutcome?.(report) ?? STATE_REPORT_ACCEPTED;
    },
  } as unknown as AdminApiClient;

  const uploader = new StreamUploader({
    anchor: TEST_ANCHOR,
    publisher: testPublisher(bee),
    streamCatalog: makeFakeCatalog({
      addStream: async (entry: unknown) => {
        catalogEntries.push(entry);
        return true;
      },
    }),
    recoveryStore: makeFakeRecoveryStore({
      save: (_id: string, state: StreamState) => {
        saved.push(state);
      },
    }),
    streamKey: TEST_STREAM_KEY,
    redundancyLevel: 0,
    streamId: STREAM_ID,
    streamTopic: DECLARED_TOPIC,
    mediatype: MEDIA_TYPE_VIDEO,
    admin: options.standalone ? undefined : { client, id: ADMIN_STREAM_ID },
    predecessorDrained: options.predecessorDrained,
    ...TEST_WINDOWS,
  });

  return { uploader, windows, recordings, catalogEntries, reports, saved };
}

/** Real time for a few test windows. */
function windowsPass(count = 3): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, count * TEST_LIVE_WINDOW_MS));
}

async function drain(uploader: StreamUploader): Promise<void> {
  await uploader.segmentQueue.onIdle();
  await windowsPass();
  await (uploader as unknown as { announceQueue: { onIdle(): Promise<void> } }).announceQueue.onIdle();
}

async function feedOneSegment(uploader: StreamUploader, index: number): Promise<void> {
  uploader.handleSegment(index, 2, Buffer.from(`seg${index}`));
  await drain(uploader);
}

function mediaSequenceOf(playlist: string): number | null {
  const line = playlist.split('\n').find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  return line === undefined ? null : Number(line.split(':')[1]);
}

/** Every line logged while `run` runs, with the previous sink restored afterwards. */
async function logLinesDuring(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({ sink: (_level, line) => lines.push(line) });
  try {
    await run();
  } finally {
    logger.configure(previous);
  }
  return lines;
}

describe('where a declared topic numbers its playlist from', () => {
  /**
   * ⛔⛔ The case the scan exists for. The declaration's topic already carried a broadcast, and a
   * session that numbered from 0 would move the media sequence of a viewer still following the topic
   * backwards.
   */
  it('continues from the newest window the topic already holds', async () => {
    const session = newSession({ windowAt: () => PREVIOUS_WINDOW });
    await feedOneSegment(session.uploader, 0);

    assert.equal(mediaSequenceOf(session.windows[0]?.playlist ?? ''), 7, 'six behind it plus the one it named');
    assert.ok(session.windows[0]?.playlist.includes('#EXT-X-DISCONTINUITY\n'), 'and the seam is marked');
  });

  it('writes the numbering it continued from into its recovery entry', async () => {
    const session = newSession({ windowAt: () => PREVIOUS_WINDOW });

    await feedOneSegment(session.uploader, 0);

    assert.equal(session.saved.at(-1)?.sequenceOffset, 7);
    assert.equal(session.saved.at(-1)?.inherited, undefined, 'a window carries no recording to open with');
  });

  /**
   * ⛔⛔ An entry written before the scan answered says `sequenceOffset: 0`, which is not "unknown yet"
   * but a positive claim that nothing was on the topic, and a recovered session never scans, so it
   * would number the broadcast again from a number viewers had already been handed. Held here through
   * an earlier session still finalizing onto the same topic, which keeps the scan from starting.
   */
  it('writes no recovery entry while its position is unsettled', async () => {
    let release: (() => void) | null = null;
    const session = newSession({
      windowAt: () => PREVIOUS_WINDOW,
      predecessorDrained: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });

    await feedOneSegment(session.uploader, 0);

    assert.equal(session.saved.length, 0, 'an entry here would claim the topic was empty, which a recovery believes');
    assert.equal(session.windows.length, 0, 'and no window names a numbering nobody has settled');

    release!();
    await feedOneSegment(session.uploader, 1);

    const entry = session.saved.at(-1);
    assert.ok(entry, 'and the entry is written as soon as the scan answers');
    assert.equal(entry?.sequenceOffset, 7, 'carrying the numbering the topic really had');
    assert.equal(entry?.segments.length, 2, 'naming the segment it held while the scan was outstanding as well');
  });

  /**
   * ⛔ And the entry lands on the settling itself rather than waiting for a segment to follow it.
   * Otherwise a broadcast whose first segment arrived while the position was unsettled and whose second
   * never came would hold an uploaded, unnamed segment with nothing on disk recording it.
   */
  it('writes the entry as soon as the scan settles, with no further segment needed', async () => {
    let release: (() => void) | null = null;
    const session = newSession({
      windowAt: () => PREVIOUS_WINDOW,
      predecessorDrained: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });

    await feedOneSegment(session.uploader, 0);
    assert.equal(session.saved.length, 0);

    release!();
    await waitFor(() => session.saved.length > 0, SETTLE_CEILING_MS);

    assert.equal(session.saved.at(-1)?.sequenceOffset, 7);
  });

  /**
   * ⛔⛔ A `live` the admin was told while no recovery entry existed would strand that row: nothing on
   * the uploader side would survive a crash to flip it. The report is reached only off the first
   * written window, which is composed only once the position is settled, and the entry is written
   * before the announce.
   */
  it('never reports live to the admin before a recovery entry exists', async () => {
    let release: (() => void) | null = null;
    const session = newSession({
      windowAt: () => PREVIOUS_WINDOW,
      predecessorDrained: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });

    await feedOneSegment(session.uploader, 0);

    assert.equal(session.saved.length, 0, 'the entry is deliberately withheld while the position is unsettled');
    assert.equal(session.reports.length, 0, 'so nothing may have told the admin the stream is live either');

    release!();
    await feedOneSegment(session.uploader, 1);

    assert.ok(session.saved.length > 0);
    assert.ok(
      session.reports.some((report) => report.state === ADMIN_STATE_LIVE),
      'and both happen once it settles, in that order',
    );
  });

  /**
   * ⛔ The standalone deployment is untouched by that. Its topic is a fresh uuid per session, so its
   * position is settled by construction and it persists from its first segment exactly as it always did.
   */
  it('persists from the first segment on a stream that scans nothing', async () => {
    const session = newSession({ standalone: true });

    await feedOneSegment(session.uploader, 0);

    assert.ok(session.saved.length > 0, 'a session with nothing to settle has nothing to wait for');
  });

  it('starts at zero when the topic holds no recent window', async () => {
    const session = newSession();
    await feedOneSegment(session.uploader, 0);

    assert.equal(mediaSequenceOf(session.windows[0]?.playlist ?? ''), 0, 'a 404 is an answer: nothing to continue');
  });

  it('scans once and then writes straight through', async () => {
    let reads = 0;
    const session = newSession({
      windowAt: () => {
        reads++;
        return null;
      },
    });

    await feedOneSegment(session.uploader, 0);
    const readsAfterTheScan = reads;
    await feedOneSegment(session.uploader, 1);
    await feedOneSegment(session.uploader, 2);

    assert.ok(readsAfterTheScan > 0, 'the topic was scanned');
    assert.equal(reads, readsAfterTheScan, 'the scan is once per session, never once per window');
  });

  /**
   * ⛔ Refused rather than guessed. Taking a failed read for an empty topic is what moves a viewer's
   * media sequence backwards, and the cost of refusing is a window or two with nothing written. The
   * session is not latched by the failure: the next segment asks again.
   */
  it('writes no window while it cannot tell where the topic stands, and asks again at the next segment', async () => {
    let refusing = true;
    const session = newSession({
      windowAt: () => {
        if (refusing) {
          throw windowReadRefused();
        }
        return PREVIOUS_WINDOW;
      },
    });

    await feedOneSegment(session.uploader, 0);
    assert.equal(session.windows.length, 0, 'nothing may be written on a topic whose numbering is unknown');

    refusing = false;
    await feedOneSegment(session.uploader, 1);
    assert.equal(mediaSequenceOf(session.windows[0]?.playlist ?? ''), 7, 'the retried scan settles it');
  });

  it('reads an absent window as no window, not as a failure', async () => {
    const session = newSession({
      windowAt: () => {
        throw windowAbsent();
      },
    });

    await feedOneSegment(session.uploader, 0);

    assert.equal(mediaSequenceOf(session.windows[0]?.playlist ?? ''), 0);
  });

  /**
   * A standalone single-rendition stream is untouched, and it is the only session left that is. Its
   * topic is a fresh uuid, so there is nothing to continue from and scanning would spend a read per
   * window to be told so.
   */
  it('is not run at all for a standalone single-rendition stream', async () => {
    let reads = 0;
    const session = newSession({
      standalone: true,
      windowAt: () => {
        reads++;
        return PREVIOUS_WINDOW;
      },
    });

    await feedOneSegment(session.uploader, 0);

    assert.equal(reads, 0);
    assert.equal(
      mediaSequenceOf(session.windows[0]?.playlist ?? ''),
      0,
      'a session that mints its own topic starts at zero',
    );
  });
});

describe('what a declared broadcast reports, and what it no longer writes', () => {
  /**
   * ⛔ Not one entry, at either moment. The admin owns the list of streams in admin mode, and a
   * second writer would publish entries nothing reconciles.
   */
  it('writes nothing to the stream catalog, live or on the flip to vod', async () => {
    const session = newSession();

    await feedOneSegment(session.uploader, 0);
    await session.uploader.notifyStop();

    assert.deepEqual(session.catalogEntries, []);
  });

  it('reports live on its first written window and vod once the recording is uploaded', async () => {
    const session = newSession();

    await feedOneSegment(session.uploader, 0);
    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE],
      'the live report lands where the catalog announce would have, on the first window',
    );

    await session.uploader.notifyStop();

    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE, ADMIN_STATE_VOD],
      'and in that order: a vod the admin never saw go live is a broadcast it cannot show correctly',
    );
  });

  /**
   * The two values the catalog's own VOD entry would have carried, because they answer the same
   * question: where the recording is, and how long it plays. The reference is read off what was
   * actually uploaded rather than written out here.
   */
  it('reports the recording by the reference it was uploaded under, with its playing time', async () => {
    const session = newSession();

    await feedOneSegment(session.uploader, 0);
    await feedOneSegment(session.uploader, 1);
    await session.uploader.notifyStop();

    const vod = session.reports.at(-1);
    assert.equal(session.recordings.length, 1);
    assert.deepEqual(vod, {
      state: ADMIN_STATE_VOD,
      recording: fakeRecordingReference(session.recordings[0]),
      duration: 4,
    });
  });

  /**
   * ⛔ A finalize that could not tell the admin is a finalize that is not finished. The report is the
   * only thing that says the broadcast became a recording, exactly as the catalog write is outside
   * admin mode, so it has to cost the same: the failure propagates and the recovery entry stays on
   * disk for the next boot to retry.
   */
  it('leaves the broadcast unfinalized when the vod report could not be delivered', async () => {
    const removed: string[] = [];
    const session = newSession({
      reportOutcome: (report) => (report.state === ADMIN_STATE_VOD ? STATE_REPORT_FAILED : STATE_REPORT_ACCEPTED),
    });
    (session.uploader as unknown as { recoveryStore: { remove: (id: string) => void } }).recoveryStore.remove = (
      id: string,
    ) => {
      removed.push(id);
    };

    await feedOneSegment(session.uploader, 0);
    await assert.rejects(() => session.uploader.notifyStop(), /admin API/);

    assert.deepEqual(removed, [], 'the recovery entry is the only record the broadcast was live');
  });

  /** Without an admin nothing moves: the catalog is still this service's own to write. */
  it('still writes the catalog in the standalone deployment', async () => {
    const session = newSession({ standalone: true });

    await feedOneSegment(session.uploader, 0);
    await session.uploader.notifyStop();

    assert.equal(session.reports.length, 0);
    assert.equal(session.catalogEntries.length, 2, 'the live announce and the flip to vod');
  });
});

describe('the orchestrator in admin mode', () => {
  /** An admin client that accepts every report, for the sessions these cases actually start. */
  const acceptingAdmin = (): AdminApiClient =>
    new AdminApiClient({
      baseUrl: 'http://admin.test:9877',
      token: 'admin-api-token-0123456789abcdef',
      fetcher: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
    });

  /**
   * ⛔ The generic `POST /stream/start` has no declaration to pass and no way to get one. Admitted,
   * it would mint a random topic and publish a broadcast the admin never learns about and, because
   * nothing writes a catalog entry in admin mode, that no viewer could find either.
   */
  it('refuses an announce that carries no declaration', async () => {
    const orchestrator = makeTestOrchestrator({ adminApi: acceptingAdmin() });
    try {
      assert.equal(orchestrator.startStream(STREAM_ID, MEDIA_TYPE_VIDEO), false);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    } finally {
      await orchestrator.cleanup();
    }
  });

  /**
   * The topic comes off the declaration rather than `crypto.randomUUID()`, and the admin's own id for
   * the stream is persisted beside it. Both are read back off the recovery entry, which is the only
   * thing a rebuilt session has: nothing re-announces a recovered stream, so an entry without the id
   * is a broadcast that finalizes and stays `live` in the admin's list for ever.
   */
  it('publishes a declared stream on the declaration topic, and writes its admin id down', async () => {
    const saved: StreamState[] = [];
    const orchestrator = makeTestOrchestrator(
      { adminApi: acceptingAdmin() },
      {},
      makeFakeRecoveryStore({
        save: (_id: string, state: StreamState) => {
          saved.push(state);
        },
      }),
    );

    try {
      assert.equal(
        orchestrator.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, undefined, {
          id: ADMIN_STREAM_ID,
          topic: DECLARED_TOPIC,
        }),
        true,
      );

      orchestrator.handleSegment(STREAM_ID, 0, 2, Buffer.from('seg'));
      await waitFor(() => saved.length > 0, SETTLE_CEILING_MS);

      assert.equal(saved[0].streamRawTopic, DECLARED_TOPIC, 'a declared stream must not mint a topic of its own');
      assert.equal(saved[0].adminStreamId, ADMIN_STREAM_ID);
    } finally {
      await orchestrator.cleanup();
    }
  });
});

/**
 * Takeover ordering: the fourth property.
 *
 * A re-announce retires the live session and starts its replacement in the same synchronous turn,
 * then drains the retired one in the background. Under a declaration both sessions hold the same
 * topic, and `retire()` does not stop window writes: it gives up the recovery entry, the admin report
 * and the catalog entry, and nothing else. So the retired session's closing windows are written on the
 * topic the replacement is about to write on. Ungated, the two write the same window addresses, and
 * the replacement scans a topic the retired session is still moving.
 */
describe('a replacement session on a declared topic waits for the session it replaced', () => {
  it('writes no window, and does not even scan the topic, while the retired session is finalizing', async () => {
    let releaseDrain = (): void => {};
    const drained = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });

    let reads = 0;
    let finished = false;
    const session = newSession({
      predecessorDrained: drained,
      windowAt: () => {
        reads++;
        return finished ? PREVIOUS_WINDOW : null;
      },
    });

    await feedOneSegment(session.uploader, 0);

    assert.equal(session.windows.length, 0, 'a window here would share an address with the retired session');
    assert.equal(reads, 0, 'and the topic must not be scanned yet: its newest window is still being written');

    finished = true;
    releaseDrain();
    await feedOneSegment(session.uploader, 1);

    assert.equal(
      mediaSequenceOf(session.windows[0]?.playlist ?? ''),
      7,
      'once the retired session is done the replacement continues from its closing window',
    );
  });

  /**
   * The latch is on the drain settling, not on a refusal. A session held once has to write on its own
   * once the drain settles rather than waiting for a further event, or a broadcast would be held for
   * its whole life by one early reconnect.
   */
  it('is not latched by having been held once', async () => {
    let releaseDrain = (): void => {};
    const drained = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const session = newSession({ predecessorDrained: drained });

    await feedOneSegment(session.uploader, 0);
    assert.equal(session.windows.length, 0);

    releaseDrain();
    await drain(session.uploader);

    assert.ok(session.windows.length > 0, 'the session writes normally from here');
  });

  /**
   * ⛔ The gate is for a shared topic only. `StreamOrchestrator` passes the promise only for a session
   * whose topic outlives it, so a session handed none writes from its first window.
   */
  it('does not wait when it was handed no predecessor, which is every session outside a re-announce', async () => {
    const session = newSession();

    await feedOneSegment(session.uploader, 0);

    assert.ok(session.windows.length > 0, 'nothing to wait for, so nothing waits');
  });
});

/**
 * A rung of an ABR ladder under a declaration, which is the other shape admin mode takes.
 *
 * The declared topic is the ladder group, and this session writes its own windows on a topic derived
 * from the ladder group and its rung name. That topic outlives the session exactly as a declared one
 * does, so the opening scan and the predecessor gate are both owed here too. Nothing is written to the
 * stream catalog, and the admin is told instead, but the two reports are now statements about the
 * LADDER: `live` once the ladder's announce landed, and `vod` once every rung of the ladder has
 * finalized or is known not to finish, carrying the ladder's recording rather than this rung's own.
 *
 * ⛔ The rung registers its own record through the ladder registry, which is the only thing that can
 * see the other three rungs. That is why the flip is read off an answer rather than off this session's
 * intent: a rung draining while its siblings are live has ended its own recording and nothing else.
 */
describe('a rung of a declared ladder', () => {
  /**
   * This rung's own topic, which the orchestrator derives from the ladder group and the rung name.
   * Spelled out rather than computed with `rungTopicFor`, because what these cases turn on is that it
   * is NOT the declared topic and that it outlives the session.
   */
  const RUNG_TOPIC = 'rung-topic-0001';
  const RUNG = { name: '720p', width: 1280, height: 720, configuredKbps: 2800 };
  /** The ladder's recording as the merge names it: its lowest finished rung's. Built rather than written out. */
  const LADDER_RECORDING = 'ab'.repeat(32);

  /** One rendition report registered with the registry. */
  interface Upsert {
    adminStreamId?: string;
    group: string;
    rendition: Rendition;
  }

  interface LadderSession {
    uploader: StreamUploader;
    windows: WindowWrite[];
    recordings: string[];
    catalogEntries: unknown[];
    reports: AdminStateReport[];
    upserts: Upsert[];
    /** Every record of this rung registered as one that will not finish. */
    unfinished: Upsert[];
  }

  interface LadderSessionOptions {
    /** What the registry answers for each announce in turn. Defaults to a master at 0 that flipped nothing. */
    announce?: (upsert: Upsert, attempt: number) => RenditionAnnouncement;
    /** What the registry answers when the rung is recorded as one that will not finish. */
    unfinished?: (upsert: Upsert) => RenditionAnnouncement;
    /** Answer for each state report in turn, so a failure can be driven. Defaults to accepting every one. */
    reportOutcome?: (report: AdminStateReport) => StateReportOutcome;
    /** How long a failed announce waits before the next window re-attempts it. */
    catalogAnnounceRetryMs?: number;
    windowAt?: () => Uint8Array | null;
  }

  const LIVE_ANSWER: RenditionAnnouncement = {
    recording: null,
    flippedToFinished: false,
    duration: null,
  };
  const NOTHING_ANSWER: RenditionAnnouncement = {
    recording: null,
    flippedToFinished: false,
    duration: null,
  };

  function newLadderSession(options: LadderSessionOptions = {}): LadderSession {
    const windows: WindowWrite[] = [];
    const recordings: string[] = [];
    const catalogEntries: unknown[] = [];
    const reports: AdminStateReport[] = [];
    const upserts: Upsert[] = [];
    const unfinished: Upsert[] = [];

    const bee = makeFakeBee({
      uploadWindow: async (identifier, payload) => {
        windows.push({ identifier, playlist: playlistOf(payload) });
        return { reference: { toHex: () => 'window' } };
      },
      windowAt: () => (options.windowAt ? options.windowAt() : null),
      uploadRecording: async (playlist) => {
        recordings.push(playlist);
        const reference = fakeRecordingReference(playlist);
        return { reference: { toHex: () => reference } };
      },
    });

    const client = {
      describe: () => 'http://admin.test:9877',
      reportState: async (_id: string, report: AdminStateReport) => {
        reports.push(report);
        return options.reportOutcome?.(report) ?? STATE_REPORT_ACCEPTED;
      },
    } as unknown as AdminApiClient;

    const ladderRegistry: LadderRegistry = {
      upsertRendition: async (identity, rendition) => {
        const upsert = { adminStreamId: identity.adminStreamId, group: identity.group, rendition };
        upserts.push(upsert);
        return options.announce?.(upsert, upserts.length) ?? LIVE_ANSWER;
      },
      recordRungUnfinished: async (identity, rendition) => {
        const upsert = { adminStreamId: identity.adminStreamId, group: identity.group, rendition };
        unfinished.push(upsert);
        return options.unfinished?.(upsert) ?? NOTHING_ANSWER;
      },
    };

    const uploader = new StreamUploader({
      anchor: TEST_ANCHOR,
      publisher: testPublisher(bee),
      streamCatalog: makeFakeCatalog({
        addStream: async (entry: unknown) => {
          catalogEntries.push(entry);
          return true;
        },
      }),
      ladderRegistry,
      recoveryStore: makeFakeRecoveryStore(),
      streamKey: TEST_STREAM_KEY,
      redundancyLevel: 0,
      streamId: `${STREAM_ID}_720p`,
      // The rung's own derived topic, never the declaration's. The declaration's topic is the group.
      streamTopic: RUNG_TOPIC,
      mediatype: MEDIA_TYPE_VIDEO,
      ladder: { group: DECLARED_TOPIC, rung: RUNG },
      admin: { client, id: ADMIN_STREAM_ID },
      catalogAnnounceRetryMs: options.catalogAnnounceRetryMs,
      ...TEST_WINDOWS,
    });

    return { uploader, windows, recordings, catalogEntries, reports, upserts, unfinished };
  }

  /**
   * ⛔⛔ **A rung scans its OWN topic, and it is the only topic it ever scans.** Its topic is derived
   * from the ladder group and the rung name, so it outlives the session: a rung that restarts
   * mid-broadcast comes back onto the topic it was already writing, and numbering from 0 there would
   * move the media sequence of every viewer on that rung backwards.
   */
  it('continues from the newest window its own derived topic already holds', async () => {
    const session = newLadderSession({ windowAt: () => PREVIOUS_WINDOW });

    await feedOneSegment(session.uploader, 0);

    assert.equal(mediaSequenceOf(session.windows[0]?.playlist ?? ''), 7);
    assert.ok(session.windows[0]?.playlist.includes('#EXT-X-DISCONTINUITY\n'), 'the seam must be marked');
  });

  it('starts at zero when its own topic holds no recent window, which is a new ladder', async () => {
    const session = newLadderSession();

    await feedOneSegment(session.uploader, 0);

    assert.equal(mediaSequenceOf(session.windows[0]?.playlist ?? ''), 0);
  });

  it('writes nothing to the stream catalog, and registers its rung with the ladder registry instead', async () => {
    const session = newLadderSession();

    await feedOneSegment(session.uploader, 0);

    assert.deepEqual(session.catalogEntries, []);
    assert.deepEqual(
      session.upserts.map((upsert) => [
        upsert.group,
        upsert.adminStreamId,
        upsert.rendition.name,
        upsert.rendition.topic,
      ]),
      [[DECLARED_TOPIC, ADMIN_STREAM_ID, '720p', RUNG_TOPIC]],
      'the record names the rung′s own topic, under the declared ladder, addressed to the declared stream',
    );
  });

  it('reports live once the ladder′s announce has landed', async () => {
    const session = newLadderSession();

    await feedOneSegment(session.uploader, 0);

    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE],
    );
  });

  /**
   * ⛔ The reference is the LADDER's recording as the merge answered it, never this rung's own: one
   * declared stream is one ladder. And the duration is the ladder's.
   */
  it('reports vod with the ladder′s recording and duration, once the ladder flipped', async () => {
    const session = newLadderSession({
      announce: (upsert) =>
        upsert.rendition.recording === undefined
          ? LIVE_ANSWER
          : { recording: LADDER_RECORDING, flippedToFinished: true, duration: 12 },
    });

    await feedOneSegment(session.uploader, 0);
    await session.uploader.notifyStop();

    assert.deepEqual(session.reports.at(-1), { state: ADMIN_STATE_VOD, recording: LADDER_RECORDING, duration: 12 });
    assert.equal(
      session.upserts.at(-1)?.rendition.recording,
      fakeRecordingReference(session.recordings[0]),
      'and the rung′s own record carries its own recording',
    );
  });

  /**
   * ⛔ A rung draining while its siblings are still live has ended its own recording and nothing more.
   * The broadcast is over when the LAST of them finalizes, which is the only report the admin answers
   * with a flip, so a rung announcing the end off its own drain would take three live rungs off the
   * air in the admin′s list.
   */
  it('reports no vod when its own finalize did not finish the ladder', async () => {
    const session = newLadderSession();

    await feedOneSegment(session.uploader, 0);
    await session.uploader.notifyStop();

    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE],
      'the broadcast went live and stays that way: three of its rungs are still publishing',
    );
    assert.equal(session.upserts.length, 2, 'the rung still announced itself finished, which is what flips the ladder');
    assert.equal(session.upserts[1].rendition.recording, fakeRecordingReference(session.recordings[0]));
  });

  /**
   * ⛔⛔⛔ 2026-09-23, admin mode's half. A rung whose stop failed has no recording, and the ladder it
   * belonged to has to stop waiting for it, or three rungs' recording stays listed as live for good.
   */
  describe('a rung whose stop failed', () => {
    it('registers itself as it stands, with no recording, under the declared ladder and stream', async () => {
      const session = newLadderSession();
      await feedOneSegment(session.uploader, 0);

      await session.uploader.announceUnfinished();

      assert.deepEqual(
        session.unfinished.map((upsert) => [upsert.group, upsert.adminStreamId, upsert.rendition.name]),
        [[DECLARED_TOPIC, ADMIN_STREAM_ID, '720p']],
      );
      assert.equal(session.unfinished[0].rendition.topic, RUNG_TOPIC, 'the record names the rung′s own topic');
      assert.equal(session.unfinished[0].rendition.recording, undefined, 'a rung with no recording names none');
    });

    /**
     * ⛔ The drain that failed has already retired this session, which is the guard every other report
     * here passes. It is passed over on purpose: the orchestrator calls this only when no newer session
     * took the id, and a guard that held here would leave the recording listed as live.
     */
    it('reports vod with the ladder′s recording, once, when marking it is what finishes the ladder', async () => {
      const session = newLadderSession({
        unfinished: () => ({ recording: LADDER_RECORDING, flippedToFinished: true, duration: 12 }),
      });
      await feedOneSegment(session.uploader, 0);
      session.uploader.retire();

      const lines = await logLinesDuring(() => session.uploader.announceUnfinished());

      assert.deepEqual(session.reports, [
        { state: ADMIN_STATE_LIVE },
        { state: ADMIN_STATE_VOD, recording: LADDER_RECORDING, duration: 12 },
      ]);
      assert.equal(
        lines.filter((line) => line.includes(ladderFinalized(DECLARED_TOPIC))).length,
        1,
        'one broadcast ended, so the flip is announced exactly once',
      );
    });

    it('reports nothing when the ladder is still waiting for other rungs', async () => {
      const session = newLadderSession();
      await feedOneSegment(session.uploader, 0);

      const lines = await logLinesDuring(() => session.uploader.announceUnfinished());

      assert.deepEqual(
        session.reports.map((report) => report.state),
        [ADMIN_STATE_LIVE],
        'three of its rungs are still publishing, so the broadcast stays live',
      );
      assert.equal(lines.filter((line) => line.includes(ladderFinalized(DECLARED_TOPIC))).length, 0);
    });

    /** Reported only after the report landed, as a finalize's flip is: a line claiming it first is a flip nobody took. */
    it('does not say the ladder finalized when the vod report could not be delivered', async () => {
      const session = newLadderSession({
        unfinished: () => ({ recording: LADDER_RECORDING, flippedToFinished: true, duration: 12 }),
        reportOutcome: (report) => (report.state === ADMIN_STATE_VOD ? STATE_REPORT_FAILED : STATE_REPORT_ACCEPTED),
      });
      await feedOneSegment(session.uploader, 0);

      const lines = await logLinesDuring(async () => {
        await assert.rejects(() => session.uploader.announceUnfinished(), /admin API/);
      });

      assert.equal(lines.filter((line) => line.includes(ladderFinalized(DECLARED_TOPIC))).length, 0);
    });
  });

  /**
   * A rendition report that did not land is a rung missing from what the admin holds, so it costs
   * exactly what a failed catalog announce costs: the age `/health` reports as an unlisted stream, and
   * a re-attempt on the announce cadence.
   */
  it('re-attempts a failed announce on the announce cadence, and says so on /health meanwhile', async () => {
    let refusing = true;
    const session = newLadderSession({
      catalogAnnounceRetryMs: 0,
      announce: () => {
        if (refusing) {
          throw new Error('the admin refused the rendition report');
        }
        return LIVE_ANSWER;
      },
    });

    await feedOneSegment(session.uploader, 0);
    assert.ok(session.upserts.length >= 1);
    assert.equal(session.reports.length, 0, 'nothing is live until the ladder holds this rung');
    assert.notEqual(
      session.uploader.getMsSinceCatalogAnnounceFailed(),
      null,
      'a ladder the admin does not hold is a broadcast no viewer can find, which is what this signal is',
    );

    refusing = false;
    await feedOneSegment(session.uploader, 1);

    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE],
    );
    assert.equal(session.uploader.getMsSinceCatalogAnnounceFailed(), null, 'and the signal clears once it lands');
  });

  /**
   * ⛔ A window is a live playlist, not a recording, so a session continuing a topic carries nothing
   * of the last session's media into its own recording. Each session's recording is its own.
   */
  it('finalizes a recording of its own media alone, even on a topic that held a broadcast', async () => {
    const session = newLadderSession({ windowAt: () => PREVIOUS_WINDOW });

    await feedOneSegment(session.uploader, 0);
    await feedOneSegment(session.uploader, 1);
    await session.uploader.notifyStop();

    const recording = session.recordings[0] ?? '';
    const uris = recording.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.equal(uris.length, 2, 'only this session′s own segments');
    assert.ok(!uris.includes('d'.repeat(64)), 'nothing from the window it continued');
  });
});
