import { Bee, BeeResponseError, FeedIndex, Identifier, PrivateKey } from '@ethersphere/bee-js';
import {
  parseWindowNote,
  STREAM_LIST_HEARTBEAT_MS,
  STREAM_LIST_NOTE_WINDOW_MS,
  windowEnd,
  windowIdentifier,
  windowOf,
  type WindowNote,
  type WindowWriterClock,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { type Timer } from '../src/libs/Clock.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { MEDIA_TYPE_VIDEO, STREAM_STATUS_LIVE } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const LIST_TOPIC = 'test-stream-list';
const OWNER = new PrivateKey(TEST_STREAM_KEY).publicKey().address().toHex();

/** 5.3 s into a window that is not a heartbeat window, so its end at 4.7 s writes a note only for news. */
const START_MS = 1793793615300;
const FIRST = windowOf(START_MS, STREAM_LIST_NOTE_WINDOW_MS);
const FIRST_END_MS = windowEnd(FIRST, STREAM_LIST_NOTE_WINDOW_MS) - START_MS;
const HEARTBEAT_EVERY = STREAM_LIST_HEARTBEAT_MS / STREAM_LIST_NOTE_WINDOW_MS;

interface FeedWrite {
  index: number;
  deferred?: boolean;
}

interface NoteUpload {
  identifier: string;
  signer: string;
  stamp: string;
  deferred?: boolean;
  note: WindowNote | null;
}

interface NotesBeeOptions {
  /** The head the boot lookup finds. Absent, the feed was never written. */
  headIndex?: number;
  /** Awaited inside each feed write, so a test can hold one open across a window end. */
  holdFeedWrite?: () => Promise<void>;
  /** Called before each feed write. An error is thrown instead of the write. */
  feedWriteFails?: () => Error | null;
  /** Called before each note upload. An error is thrown instead of the upload. */
  noteFails?: () => Error | null;
}

interface Recorded {
  feed: FeedWrite[];
  notes: NoteUpload[];
}

function notesBee(recorded: Recorded, options: NotesBeeOptions = {}): Bee {
  return {
    feed: {
      makeReader: () => ({
        downloadPayload: async (read?: { index?: FeedIndex }) => {
          if (read?.index) {
            return { payload: { toJSON: () => [] } };
          }
          if (options.headIndex === undefined) {
            throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
          }
          return { feedIndex: FeedIndex.fromBigInt(BigInt(options.headIndex)), payload: { toJSON: () => [] } };
        },
      }),
      makeWriter: () => ({
        uploadPayload: async (_stamp: string, _payload: unknown, write: { index: FeedIndex; deferred?: boolean }) => {
          const error = options.feedWriteFails?.();
          if (error) {
            throw error;
          }
          await options.holdFeedWrite?.();
          recorded.feed.push({ index: Number(write.index.toBigInt()), deferred: write.deferred });
          return { reference: { toHex: () => 'ref' } };
        },
      }),
    },
    soc: {
      makeWriter: (signer: PrivateKey) => ({
        upload: async (stamp: string, identifier: Identifier, data: Uint8Array, upload?: { deferred?: boolean }) => {
          const error = options.noteFails?.();
          if (error) {
            throw error;
          }
          recorded.notes.push({
            identifier: new Identifier(identifier).toHex(),
            signer: signer.publicKey().address().toHex(),
            stamp,
            deferred: upload?.deferred,
            note: parseWindowNote(data),
          });
          return { reference: { toHex: () => 'ref' } };
        },
      }),
    },
    connectivity: { isConnected: async () => true },
  } as unknown as Bee;
}

function makePublishers(bee: Bee): BeePublisherPool {
  const publisher = { rung: SINGLE_PUBLISHER, url: '', stamp: 'stamp', bee };
  return { coordinator: () => publisher, forRung: () => publisher } as unknown as BeePublisherPool;
}

/** The writer's wall clock and timers over the suite's fake timers, starting at {@link START_MS}. */
function windowClock(): { timers: FakeClock; clock: WindowWriterClock } {
  const timers = new FakeClock();
  return {
    timers,
    clock: {
      now: () => START_MS + timers.now(),
      setTimeout: (callback, delayMs) => timers.setTimer(callback, delayMs),
      clearTimeout: (handle) => {
        (handle as Timer).cancel();
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function advance(timers: FakeClock, ms: number): Promise<void> {
  await timers.advance(ms);
  await settle();
}

const noteIdentifier = (window: number): string =>
  windowIdentifier({ topic: LIST_TOPIC, kind: 'note', windowMs: STREAM_LIST_NOTE_WINDOW_MS, window }).toHex();

const liveEntry = (topic: string) => ({
  title: 'title',
  owner: 'owner',
  topic,
  state: STREAM_STATUS_LIVE,
  mediatype: MEDIA_TYPE_VIDEO,
  timestamp: 0,
});

async function startedCatalog(options: NotesBeeOptions = {}, clockTrusted?: () => boolean) {
  const recorded: Recorded = { feed: [], notes: [] };
  const catalog = new StreamCatalog(makePublishers(notesBee(recorded, options)), TEST_STREAM_KEY, LIST_TOPIC);
  await catalog.init();
  const { timers, clock } = windowClock();
  catalog.startNotes({ clock, clockTrusted });
  return { catalog, recorded, timers };
}

describe('StreamCatalog writes the list direct, then a note naming it', () => {
  it('writes each new version direct, as the next feed index', async () => {
    const { catalog, recorded } = await startedCatalog({ headIndex: 6 });

    await catalog.addStream(liveEntry('a'));
    await catalog.addStream(liveEntry('b'));
    await catalog.stopNotes();

    assert.deepEqual(recorded.feed, [
      { index: 7, deferred: false },
      { index: 8, deferred: false },
    ]);
  });

  it('names a new version in the note of the next window end, signed by the list key and written direct', async () => {
    const { catalog, recorded, timers } = await startedCatalog();

    await catalog.addStream(liveEntry('a'));
    await advance(timers, FIRST_END_MS);
    await catalog.stopNotes();

    assert.equal(recorded.notes.length, 1, 'one window ended with news, so one note');
    const [note] = recorded.notes;
    assert.equal(note.identifier, noteIdentifier(FIRST), 'the note is at the list topic name, kind note, 10 s window');
    assert.equal(note.signer, OWNER, 'the note is signed by the key that signs the list');
    assert.equal(note.stamp, 'stamp');
    assert.equal(note.deferred, false, 'a note is written direct');
    assert.equal(note.note?.newest, 0);
    assert.equal(note.note?.writtenAt, START_MS + FIRST_END_MS);
  });

  it('never names a version whose write has not finished', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { catalog, recorded, timers } = await startedCatalog({ holdFeedWrite: () => held });

    const adding = catalog.addStream(liveEntry('a'));
    await advance(timers, FIRST_END_MS);
    assert.equal(recorded.notes.length, 0, 'the version was still being written at the window end');

    release();
    await adding;
    await advance(timers, STREAM_LIST_NOTE_WINDOW_MS);
    await catalog.stopNotes();

    assert.deepEqual(
      recorded.notes.map((note) => [note.identifier, note.note?.newest]),
      [[noteIdentifier(FIRST + 1), 0]],
    );
  });

  it('writes a heartbeat note in every aligned window with no change, -1 for a list never written', async () => {
    const { catalog, recorded, timers } = await startedCatalog();

    await advance(timers, FIRST_END_MS + 2 * STREAM_LIST_HEARTBEAT_MS);
    await catalog.stopNotes();

    const heartbeats = Array.from({ length: 12 }, (_, i) => FIRST + i).filter((w) => w % HEARTBEAT_EVERY === 0);
    assert.equal(heartbeats.length, 2);
    assert.deepEqual(
      recorded.notes.map((note) => [note.identifier, note.note?.newest]),
      heartbeats.map((window) => [noteIdentifier(window), -1]),
    );
  });

  it('carries the head it booted from in its heartbeat, with no write of its own', async () => {
    const { catalog, recorded, timers } = await startedCatalog({ headIndex: 41 });

    await advance(timers, FIRST_END_MS + STREAM_LIST_HEARTBEAT_MS);
    await catalog.stopNotes();

    assert.ok(recorded.notes.length >= 1);
    assert.ok(recorded.notes.every((note) => note.note?.newest === 41));
  });

  it('writes the news of a failed note again in the following window', async () => {
    let failNext = true;
    const { catalog, recorded, timers } = await startedCatalog({
      noteFails: () => {
        if (!failNext) return null;
        failNext = false;
        return new Error('the storer did not answer');
      },
    });

    await catalog.addStream(liveEntry('a'));
    await advance(timers, FIRST_END_MS);
    assert.equal(recorded.notes.length, 0, 'the first note failed');

    await advance(timers, STREAM_LIST_NOTE_WINDOW_MS);
    await catalog.stopNotes();

    assert.deepEqual(
      recorded.notes.map((note) => [note.identifier, note.note?.newest]),
      [[noteIdentifier(FIRST + 1), 0]],
    );
  });

  it('names no version whose list write failed', async () => {
    const { catalog, recorded, timers } = await startedCatalog({
      feedWriteFails: () => new BeeResponseError('POST', '/soc', 'Bad Request', undefined, 400, 'Bad Request'),
    });

    await assert.rejects(catalog.addStream(liveEntry('a')));
    await advance(timers, FIRST_END_MS + STREAM_LIST_HEARTBEAT_MS);
    await catalog.stopNotes();

    assert.deepEqual(recorded.feed, []);
    assert.ok(recorded.notes.length >= 1, 'the heartbeat still runs');
    assert.ok(
      recorded.notes.every((note) => note.note?.newest === -1),
      'a note named a version that was never stored',
    );
  });

  it('skips the note while the clock check distrusts the clock, and carries the news once it trusts it', async () => {
    let trusted = false;
    const { catalog, recorded, timers } = await startedCatalog({}, () => trusted);

    await catalog.addStream(liveEntry('a'));
    await advance(timers, FIRST_END_MS);
    assert.equal(
      recorded.notes.length,
      0,
      'a note dated by a clock the check distrusts would sit at the wrong address',
    );

    trusted = true;
    await advance(timers, STREAM_LIST_NOTE_WINDOW_MS);
    await catalog.stopNotes();

    assert.deepEqual(
      recorded.notes.map((note) => [note.identifier, note.note?.newest]),
      [[noteIdentifier(FIRST + 1), 0]],
    );
  });

  it('writes nothing once stopped, and nothing when never started', async () => {
    const { catalog, recorded, timers } = await startedCatalog();
    await catalog.stopNotes();
    await catalog.addStream(liveEntry('a'));
    await advance(timers, FIRST_END_MS + STREAM_LIST_HEARTBEAT_MS);
    assert.deepEqual(recorded.notes, []);

    const silent: Recorded = { feed: [], notes: [] };
    const unstarted = new StreamCatalog(makePublishers(notesBee(silent)), TEST_STREAM_KEY, LIST_TOPIC);
    await unstarted.init();
    await unstarted.addStream(liveEntry('a'));
    await unstarted.stopNotes();
    assert.deepEqual(silent.notes, [], 'a catalog whose list belongs to the admin writes no note');
  });
});
