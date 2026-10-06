import { Bee, BeeResponseError } from '@ethersphere/bee-js';
import {
  encodeLiveWindowPayload,
  LIVE_PLAYLIST_WINDOW_MS,
  parseLiveWindowPayload,
  windowIdentifier,
  type WindowWriterClock,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { AdminApiClient, AdminStateReport, STATE_REPORT_ACCEPTED } from '../src/libs/AdminApiClient.js';
import { LadderRegistry, RenditionAnnouncement } from '../src/libs/LadderRegistry.js';
import { StreamUploader, StreamUploaderOptions } from '../src/libs/StreamUploader.js';
import { LadderMembership, MEDIA_TYPE_VIDEO, Rendition, StreamState } from '../src/types.js';

import { makeFakeCatalog, makeFakeRecoveryStore, TEST_ANCHOR, testPublisher } from './helpers/fakes.js';

// A valid 32-byte secp256k1 private key (value 1), enough for bee-js to derive a signer in tests.
const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const TOPIC = 'topic-test';
const STAMP = 'stamp';

// A window boundary, so window arithmetic in the assertions reads plainly.
const START_MS = 1_000_000_000_000;
const FIRST_WINDOW = START_MS / LIVE_PLAYLIST_WINDOW_MS;

const LADDER: LadderMembership = {
  group: 'group-1',
  rung: { name: '360p', width: 640, height: 360, configuredKbps: 800 },
} as LadderMembership;

/**
 * A clock whose time moves only when a test moves it, with the timer interface the window writer
 * takes. Firing yields a macrotask after each timer, so the write a window end starts has settled
 * before the next assertion.
 */
class ManualWindowClock implements WindowWriterClock {
  private current = START_MS;
  private nextId = 0;
  private timers: { id: number; due: number; callback: () => void }[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, due: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Moves the clock on by whole windows, firing each window end in turn. */
  async passWindows(count: number): Promise<void> {
    const target = this.current + count * LIVE_PLAYLIST_WINDOW_MS;
    for (;;) {
      const due = this.timers.filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due)[0];
      if (due === undefined) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = due.due;
      due.callback();
      await settle();
    }
    this.current = target;
    await settle();
  }
}

/** Lets every promise chain already started run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A content address, so the same bytes always come back under the same reference as on Swarm. */
function contentReference(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

interface WindowWrite {
  identifier: string;
  stamp: string;
  payload: Uint8Array;
  options: unknown;
}

interface BytesUpload {
  data: Uint8Array;
  options: unknown;
}

interface FakeWindowBee {
  bee: Bee;
  windowWrites: WindowWrite[];
  segmentUploads: BytesUpload[];
  /** Feed reads and writes, which a publisher on windows must make none of. */
  feedCalls: string[];
  /** Window identifiers the opening scan asked for, in the order asked. */
  windowReads: string[];
  /** Window chunks already on Swarm, by identifier, for the opening scan to find. */
  stored: Map<string, Uint8Array>;
  /** Rejects the next window write when set to a number above zero, counting down. */
  failWindowWrites: number;
  /** Segment uploads that wait for the test to release them, by the order they were made. */
  holdSegments: boolean;
  releaseSegments(): void;
}

function makeWindowBee(): FakeWindowBee {
  const held: (() => void)[] = [];
  const fake: FakeWindowBee = {
    bee: undefined as unknown as Bee,
    windowWrites: [],
    segmentUploads: [],
    feedCalls: [],
    windowReads: [],
    stored: new Map(),
    failWindowWrites: 0,
    holdSegments: false,
    releaseSegments: () => {
      for (const release of held.splice(0)) {
        release();
      }
    },
  };
  fake.bee = {
    data: {
      upload: async (_stamp: string, data: Uint8Array, options: unknown) => {
        fake.segmentUploads.push({ data, options });
        if (fake.holdSegments) {
          await new Promise<void>((resolve) => held.push(resolve));
        }
        const reference = contentReference(data);
        return { reference: { toHex: () => reference } };
      },
    },
    soc: {
      makeWriter: () => ({
        upload: async (stamp: string, identifier: { toHex(): string }, payload: Uint8Array, options: unknown) => {
          if (fake.failWindowWrites > 0) {
            fake.failWindowWrites -= 1;
            throw Object.assign(new Error('fake bee refused the window'), { status: 500 });
          }
          fake.windowWrites.push({ identifier: identifier.toHex(), stamp, payload, options });
          return { reference: { toHex: () => 'cd'.repeat(32) } };
        },
      }),
      makeReader: () => ({
        download: async (identifier: { toHex(): string }) => {
          const hex = identifier.toHex();
          fake.windowReads.push(hex);
          const payload = fake.stored.get(hex);
          if (payload === undefined) {
            throw new BeeResponseError('GET', '/chunks', 'Not Found', undefined, 404, 'Not Found');
          }
          return { payload: { toUint8Array: () => payload } };
        },
      }),
    },
    feed: {
      makeWriter: () => {
        fake.feedCalls.push('makeWriter');
        return { uploadPayload: async () => ({ reference: { toHex: () => 'soc' } }) };
      },
      makeReader: () => {
        fake.feedCalls.push('makeReader');
        return {
          downloadPayload: async () => {
            throw new BeeResponseError('GET', '/feeds', 'Not Found', undefined, 404, 'Not Found');
          },
        };
      },
    },
  } as unknown as Bee;
  return fake;
}

function liveIdentifier(window: number, topic = TOPIC): string {
  return windowIdentifier({ topic, kind: 'live', windowMs: LIVE_PLAYLIST_WINDOW_MS, window }).toHex();
}

function playlistOf(write: WindowWrite): string {
  const parsed = parseLiveWindowPayload(write.payload);
  assert.ok(parsed, 'a window payload the reader would refuse');
  return parsed.playlist;
}

function mediaSequenceOf(playlist: string): number {
  const line = playlist.split('\n').find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  assert.ok(line, 'a live playlist names its media sequence');
  return Number(line.split(':')[1]);
}

function segmentNamesOf(playlist: string): string[] {
  return playlist.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
}

function uploaderOn(
  fake: FakeWindowBee,
  clock: ManualWindowClock,
  overrides: Partial<StreamUploaderOptions> = {},
): StreamUploader {
  return new StreamUploader({
    anchor: TEST_ANCHOR,
    publisher: testPublisher(fake.bee, STAMP),
    streamCatalog: makeFakeCatalog(),
    recoveryStore: makeFakeRecoveryStore(),
    streamKey: TEST_STREAM_KEY,
    redundancyLevel: 0,
    streamId: 'stream-test',
    streamTopic: TOPIC,
    mediatype: MEDIA_TYPE_VIDEO,
    windowClock: clock,
    ...overrides,
  });
}

async function handOver(uploader: StreamUploader, from: number, count: number): Promise<void> {
  for (let index = from; index < from + count; index++) {
    uploader.handleSegment(index, 2, Buffer.from(`segment-${index}`));
  }
  await uploader.segmentQueue.onIdle();
  await settle();
}

/** Finalizes while the window clock moves, since the closing window is written at a window end. */
async function finalizeWhileWindowsPass(uploader: StreamUploader, clock: ManualWindowClock): Promise<unknown> {
  let outcome: { error: unknown } | null = null;
  const stopping = uploader.notifyStop().then(
    () => {
      outcome = { error: undefined };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  for (let i = 0; i < 10 && outcome === null; i++) {
    await clock.passWindows(1);
  }
  await stopping;
  return (outcome as { error: unknown } | null)?.error;
}

describe('each quality writes its live playlist as a window chunk every 2 s', () => {
  it('writes one window per 2 s at the window identifier of its topic, direct, and no feed index', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock);

    await handOver(uploader, 0, 2);
    await clock.passWindows(3);

    assert.deepEqual(
      fake.windowWrites.map((write) => write.identifier),
      [liveIdentifier(FIRST_WINDOW), liveIdentifier(FIRST_WINDOW + 1), liveIdentifier(FIRST_WINDOW + 2)],
    );
    for (const write of fake.windowWrites) {
      assert.equal(write.stamp, STAMP);
      assert.deepEqual(write.options, { deferred: false });
      assert.deepEqual(
        segmentNamesOf(playlistOf(write)),
        fake.segmentUploads.map((u) => contentReference(u.data)),
      );
    }
    assert.deepEqual(fake.feedCalls, [], 'a live playlist is never written to a feed');
  });

  it('writes the time it wrote the window into the window', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock);

    await handOver(uploader, 0, 1);
    await clock.passWindows(1);

    const parsed = parseLiveWindowPayload(fake.windowWrites[0].payload);
    assert.equal(parsed?.writtenAt, START_MS + LIVE_PLAYLIST_WINDOW_MS);
  });

  it('names only segments whose own upload finished', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock);

    await handOver(uploader, 0, 1);
    fake.holdSegments = true;
    uploader.handleSegment(1, 2, Buffer.from('segment-1'));
    await settle();
    await clock.passWindows(1);

    assert.deepEqual(segmentNamesOf(playlistOf(fake.windowWrites[0])), [contentReference(Buffer.from('segment-0'))]);
    fake.releaseSegments();
    await uploader.segmentQueue.onIdle();
  });

  it('writes nothing while no segment has been handed over', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    uploaderOn(fake, clock);

    await clock.passWindows(3);

    assert.equal(fake.windowWrites.length, 0);
  });

  it('writes no window while the clock is not trusted, and writes again once it is', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    let trusted = false;
    const uploader = uploaderOn(fake, clock, { clockTrusted: () => trusted });

    await handOver(uploader, 0, 1);
    await clock.passWindows(2);
    assert.equal(fake.windowWrites.length, 0, 'a window named by a clock that is off is a window at the wrong address');

    trusted = true;
    await clock.passWindows(1);
    assert.equal(fake.windowWrites.length, 1);
  });

  it('announces the stream once its first window is written, and not before', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const announced: unknown[] = [];
    const uploader = uploaderOn(fake, clock, {
      streamCatalog: makeFakeCatalog({
        addStream: async (entry: unknown) => {
          announced.push(entry);
          return false;
        },
      }),
    });

    await handOver(uploader, 0, 1);
    assert.equal(announced.length, 0, 'listed live before a viewer could read anything');

    await clock.passWindows(1);
    assert.equal(announced.length, 1);
  });
});

describe('B17: a failed window write is not retried, the next window carries the news', () => {
  it('writes the next window at its own address and never the failed one again', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock);

    await handOver(uploader, 0, 1);
    fake.failWindowWrites = 1;
    await clock.passWindows(1);
    await handOver(uploader, 1, 1);
    await clock.passWindows(1);

    assert.deepEqual(
      fake.windowWrites.map((write) => write.identifier),
      [liveIdentifier(FIRST_WINDOW + 1)],
    );
    assert.equal(segmentNamesOf(playlistOf(fake.windowWrites[0])).length, 2, 'the next window names both segments');
    assert.equal(uploader.hasStaleLiveManifest(), false, 'a written window clears the stale signal');
  });

  it('reports the failure as a stale live playlist until a window lands', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock);

    await handOver(uploader, 0, 1);
    fake.failWindowWrites = 2;
    await clock.passWindows(2);

    assert.equal(uploader.getConsecutiveManifestFailures(), 2);
    assert.equal(uploader.hasStaleLiveManifest(), true);
  });
});

describe('B15: no feed position machinery', () => {
  it('makes no feed read before writing a window, on a topic that outlives its session', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock, { ladder: LADDER });

    await handOver(uploader, 0, 1);
    await clock.passWindows(1);

    assert.equal(fake.windowWrites.length, 1);
    assert.deepEqual(fake.feedCalls, [], 'a feed read is no longer the gate before a publish');
  });
});

describe('B14: a returning session takes its media sequence from what it had', () => {
  it('a restarted uploader writes the current window with the media sequence its recovery entry held', async () => {
    const first = makeWindowBee();
    const clock = new ManualWindowClock();
    const saved: StreamState[] = [];
    const before = uploaderOn(first, clock, {
      ladder: LADDER,
      recoveryStore: makeFakeRecoveryStore({ save: (_id: string, state: StreamState) => saved.push(state) }),
    });
    await handOver(before, 0, 5);
    await clock.passWindows(1);
    const livePlaylist = playlistOf(first.windowWrites.at(-1)!);

    const restarted = makeWindowBee();
    const state = saved.at(-1)!;
    const after = uploaderOn(restarted, clock, {
      ladder: LADDER,
      restoreState: {
        streamRawTopic: state.streamRawTopic,
        segments: state.segments,
        hlsHeaders: state.hlsHeaders,
        isFirstSegmentReady: state.isFirstSegmentReady,
        isFirstManifestReady: state.isFirstManifestReady,
        anchor: state.anchor,
        sequenceOffset: state.sequenceOffset,
      },
    });
    await handOver(after, 5, 1);
    await clock.passWindows(1);

    const resumed = playlistOf(restarted.windowWrites.at(-1)!);
    assert.equal(mediaSequenceOf(resumed), mediaSequenceOf(livePlaylist));
    assert.equal(segmentNamesOf(resumed).length, 6, 'the restored segments and the new one');
    assert.deepEqual(restarted.windowReads, [], 'a recovered session already knows where it stands');
  });

  it('a new session on a topic that outlived the last one continues from its newest window', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    // The last session's closing window, three windows ago: 40 behind its window and 5 in it.
    const previous = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:40',
      '',
      ...[40, 41, 42, 43, 44].flatMap((n) => ['#EXTINF:2.000,', 'ab'.repeat(31) + n.toString(16).padStart(2, '0')]),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    fake.stored.set(liveIdentifier(FIRST_WINDOW - 3), encodeLiveWindowPayload(previous, START_MS - 4_000));
    const uploader = uploaderOn(fake, clock, { ladder: LADDER });

    await handOver(uploader, 0, 1);
    await clock.passWindows(1);

    assert.equal(mediaSequenceOf(playlistOf(fake.windowWrites[0])), 45);
    assert.ok(
      fake.windowReads.every((read) => read !== liveIdentifier(FIRST_WINDOW)),
      'the window still open is never asked for, since asking early delays it for every reader',
    );
  });

  it('a new session on a topic with no recent window starts fresh', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock, { ladder: LADDER });

    await handOver(uploader, 0, 1);
    await clock.passWindows(1);

    assert.equal(mediaSequenceOf(playlistOf(fake.windowWrites[0])), 0);
  });
});

describe('B16: two writers on one window address are as bad as two on one feed index', () => {
  it('a replacement session writes no window until its predecessor stopped', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    let predecessorStopped: () => void = () => {};
    const predecessorDrained = new Promise<void>((resolve) => {
      predecessorStopped = resolve;
    });
    const uploader = uploaderOn(fake, clock, { ladder: LADDER, predecessorDrained });

    await handOver(uploader, 0, 2);
    await clock.passWindows(3);
    assert.equal(fake.windowWrites.length, 0, 'wrote over the window its predecessor may still be writing');

    predecessorStopped();
    await settle();
    await clock.passWindows(1);
    assert.equal(fake.windowWrites.length, 1);
  });
});

describe('B5: a pause and return inside the reconnect window', () => {
  it('keeps writing windows through the pause, and the return carries its discontinuity', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock);

    await handOver(uploader, 0, 3);
    await clock.passWindows(1);
    const beforePause = playlistOf(fake.windowWrites.at(-1)!);

    await clock.passWindows(3);
    assert.equal(fake.windowWrites.length, 4, 'a window per 2 s while the encoder is away');
    for (const write of fake.windowWrites.slice(1)) {
      assert.equal(playlistOf(write), beforePause, 'the same playlist while nothing new arrived');
    }

    uploader.resumeAfterReconnect('a-return');
    await handOver(uploader, 3, 1);
    await clock.passWindows(1);

    const afterReturn = playlistOf(fake.windowWrites.at(-1)!);
    assert.ok(afterReturn.includes('#EXT-X-DISCONTINUITY\n'), afterReturn);
    assert.equal(segmentNamesOf(afterReturn).filter((name) => !name.startsWith('gap-')).length, 4);
  });
});

describe('the end of a broadcast', () => {
  it('closes with a window carrying ENDLIST, and writes none after it', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const uploader = uploaderOn(fake, clock);

    await handOver(uploader, 0, 2);
    await clock.passWindows(1);
    assert.equal(await finalizeWhileWindowsPass(uploader, clock), undefined);
    const written = fake.windowWrites.length;
    await clock.passWindows(3);

    assert.ok(playlistOf(fake.windowWrites.at(-1)!).includes('#EXT-X-ENDLIST'));
    assert.ok(!playlistOf(fake.windowWrites.at(-2)!).includes('#EXT-X-ENDLIST'));
    assert.equal(fake.windowWrites.length, written, 'a window after the end tells a reader it is live again');
  });

  it('lists the stream live before it lists the recording, when its first window is its closing one', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const states: string[] = [];
    const uploader = uploaderOn(fake, clock, {
      streamCatalog: makeFakeCatalog({
        addStream: async (entry: { state: string }) => {
          // The live write is slow, which is when the recording's write could overtake it.
          if (entry.state === 'live') {
            await settle();
            await settle();
          }
          states.push(entry.state);
          return entry.state === 'vod';
        },
      }),
    });

    await handOver(uploader, 0, 1);
    await finalizeWhileWindowsPass(uploader, clock);

    assert.deepEqual(states, ['live', 'vod'], 'a list left saying live names a broadcast that has ended');
  });

  it('uploads the recording playlist once as bytes, direct, and lists the stream with its reference', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const entries: Record<string, unknown>[] = [];
    const uploader = uploaderOn(fake, clock, {
      streamCatalog: makeFakeCatalog({
        addStream: async (entry: Record<string, unknown>) => {
          entries.push(entry);
          return entry.state === 'vod';
        },
      }),
    });

    await handOver(uploader, 0, 3);
    await clock.passWindows(1);
    await finalizeWhileWindowsPass(uploader, clock);

    const recordingUpload = fake.segmentUploads.at(-1)!;
    const recording = Buffer.from(recordingUpload.data).toString('utf-8');
    assert.ok(recording.includes('#EXT-X-PLAYLIST-TYPE:VOD') && recording.includes('#EXT-X-ENDLIST'));
    assert.deepEqual(recordingUpload.options, { deferred: false });
    const vod = entries.at(-1)!;
    assert.equal(vod.state, 'vod');
    assert.equal(vod.recording, contentReference(recordingUpload.data));
    assert.equal(vod.index, undefined, 'a recording on windows is named by reference, never by a feed index');
    assert.equal(vod.duration, 6);
  });

  it('reports the recording to the admin by reference with its duration', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const reports: AdminStateReport[] = [];
    const client = {
      reportState: async (_id: string, report: AdminStateReport) => {
        reports.push(report);
        return STATE_REPORT_ACCEPTED;
      },
    } as unknown as AdminApiClient;
    const uploader = uploaderOn(fake, clock, { admin: { client, id: 'admin-stream' } });

    await handOver(uploader, 0, 2);
    await clock.passWindows(1);
    await finalizeWhileWindowsPass(uploader, clock);

    const recordingUpload = fake.segmentUploads.at(-1)!;
    assert.deepEqual(reports, [
      { state: 'live' },
      { state: 'vod', recording: contentReference(recordingUpload.data), duration: 4 },
    ]);
  });

  it('puts the recording on the rung of a ladder, and reports the ladder by its recording in admin mode', async () => {
    const fake = makeWindowBee();
    const clock = new ManualWindowClock();
    const renditions: Rendition[] = [];
    const reports: AdminStateReport[] = [];
    const registry: LadderRegistry = {
      upsertRendition: async (_identity: unknown, rendition: Rendition): Promise<RenditionAnnouncement> => {
        renditions.push(rendition);
        const finished = rendition.recording !== undefined;
        return {
          recording: finished ? (rendition.recording ?? null) : null,
          flippedToFinished: finished,
          duration: finished ? (rendition.duration ?? null) : null,
        } as RenditionAnnouncement;
      },
      recordRungUnfinished: async () => ({
        recording: null,
        flippedToFinished: false,
        duration: null,
      }),
    } as unknown as LadderRegistry;
    const client = {
      reportState: async (_id: string, report: AdminStateReport) => {
        reports.push(report);
        return STATE_REPORT_ACCEPTED;
      },
    } as unknown as AdminApiClient;
    const uploader = uploaderOn(fake, clock, {
      ladder: LADDER,
      ladderRegistry: registry,
      admin: { client, id: 'admin-stream' },
    });

    await handOver(uploader, 0, 2);
    await clock.passWindows(1);
    await finalizeWhileWindowsPass(uploader, clock);

    const reference = contentReference(fake.segmentUploads.at(-1)!.data);
    assert.equal(renditions.at(-1)?.recording, reference);
    assert.equal(renditions.at(-1)?.duration, 4);
    assert.equal(renditions.at(-1)?.index, undefined);
    assert.deepEqual(reports.at(-1), { state: 'vod', recording: reference, duration: 4 });
  });
});

describe('B18: a crash between the recording and the list update', () => {
  it('ends with one correct list entry, because the recording uploaded again has the same reference', async () => {
    const clock = new ManualWindowClock();
    const saved: StreamState[] = [];
    const list = new Map<string, Record<string, unknown>>();
    let crashAtTheListWrite = true;
    const catalog = makeFakeCatalog({
      addStream: async (entry: Record<string, unknown>) => {
        if (entry.state === 'vod' && crashAtTheListWrite) {
          throw new Error('the process died here');
        }
        list.set(`${String(entry.owner)}/${String(entry.topic)}`, entry);
        return entry.state === 'vod';
      },
    });
    const recoveryStore = makeFakeRecoveryStore({ save: (_id: string, state: StreamState) => saved.push(state) });

    const first = makeWindowBee();
    const crashed = uploaderOn(first, clock, { streamCatalog: catalog, recoveryStore });
    await handOver(crashed, 0, 3);
    await clock.passWindows(1);
    assert.ok((await finalizeWhileWindowsPass(crashed, clock)) instanceof Error, 'the list write failed');
    const firstRecording = contentReference(first.segmentUploads.at(-1)!.data);

    crashAtTheListWrite = false;
    const second = makeWindowBee();
    const state = saved.at(-1)!;
    const recovered = uploaderOn(second, clock, {
      streamCatalog: catalog,
      recoveryStore,
      restoreState: {
        streamRawTopic: state.streamRawTopic,
        segments: state.segments,
        hlsHeaders: state.hlsHeaders,
        isFirstSegmentReady: state.isFirstSegmentReady,
        isFirstManifestReady: state.isFirstManifestReady,
        anchor: state.anchor,
        sequenceOffset: state.sequenceOffset,
      },
    });
    assert.equal(await finalizeWhileWindowsPass(recovered, clock), undefined);

    assert.equal(contentReference(second.segmentUploads.at(-1)!.data), firstRecording);
    assert.equal(list.size, 1);
    const [entry] = list.values();
    assert.equal(entry.state, 'vod');
    assert.equal(entry.recording, firstRecording);
  });
});
