/**
 * The stream list's notes as the admin writes them: after each catalogue version, a note in a 10 s window
 * naming the newest index whose write finished, and a heartbeat note once a minute with no change. Unit test
 * against the in-memory ports and a clock the test moves. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseWindowNote,
  STREAM_LIST_HEARTBEAT_MS,
  STREAM_LIST_NOTE_WINDOW_MS,
  windowEnd,
  windowOf,
  type WindowSlot,
  type WindowWriterClock,
} from '@streaming-monorepo/swarm-windows';

import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { CatalogueTarget } from '../../src/domain/FeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { ListNotes } from '../../src/domain/ListNotes.js';
import { PublishService } from '../../src/domain/PublishService.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  noCatalogueStamp,
  streamRow,
  TEST_OPERATOR,
  TEST_OWNER,
} from './support/fakes.js';
import { stagesWithMain } from './support/stageFakes.js';

const feed: FeedIdentity = { owner: TEST_OWNER, topic: 'swarm-stream', topicHex: 'cf'.repeat(32) };
const TARGET: CatalogueTarget = { beeApiUrl: 'http://bee.invalid', batchId: 'b2'.repeat(32) };

/** 5.3 s into a window that is not a heartbeat window, so its end at 4.7 s writes a note only for news. */
const START_MS = 1793793615300;
const FIRST = windowOf(START_MS, STREAM_LIST_NOTE_WINDOW_MS);
const FIRST_END_MS = windowEnd(FIRST, STREAM_LIST_NOTE_WINDOW_MS) - START_MS;
const HEARTBEAT_EVERY = STREAM_LIST_HEARTBEAT_MS / STREAM_LIST_NOTE_WINDOW_MS;

/** Timers on a time the test moves, starting at {@link START_MS}. */
class TestClock implements WindowWriterClock {
  private at = START_MS;
  private nextId = 1;
  private timers: { id: number; due: number; callback: () => void }[] = [];

  now = (): number => this.at;

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ id, due: this.at + Math.max(0, delayMs), callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  async advance(ms: number): Promise<void> {
    const until = this.at + ms;
    for (;;) {
      await settle();
      const due = this.timers.filter((timer) => timer.due <= until).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.at = Math.max(this.at, due.due);
      due.callback();
    }
    this.at = until;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Setup {
  log?: FakeFeedWriteLog;
  forRead?: () => Promise<{ target: CatalogueTarget | null } | { skipped: string }>;
}

function notesUnderTest(setup: Setup = {}) {
  const log = setup.log ?? new FakeFeedWriteLog();
  const gateway = new FakeFeedGateway();
  const clock = new TestClock();
  const notes = new ListNotes({
    log,
    feed,
    gateway,
    targets: { forRead: setup.forRead ?? (async () => ({ target: TARGET })) },
    clock,
  });
  return { log, gateway, clock, notes };
}

const named = (gateway: FakeFeedGateway) =>
  gateway.notes.map((note) => [note.slot.window, parseWindowNote(note.payload)?.newest]);

const record = (index: number) => ({
  owner: feed.owner,
  topic: feed.topicHex,
  feedIndex: index,
  entryCount: 0,
  payload: [],
  payloadText: '[]',
  reference: null,
  batchId: null,
});

describe('ListNotes', () => {
  it('writes heartbeat notes in aligned windows naming -1 while nothing is stored', async () => {
    const { gateway, clock, notes } = notesUnderTest();
    await notes.start();

    await clock.advance(FIRST_END_MS + 2 * STREAM_LIST_HEARTBEAT_MS);
    await notes.stop();

    const heartbeats = Array.from({ length: 12 }, (_, i) => FIRST + i).filter((w) => w % HEARTBEAT_EVERY === 0);
    assert.equal(heartbeats.length, 2);
    assert.deepEqual(
      named(gateway),
      heartbeats.map((window) => [window, -1]),
    );
  });

  it('writes each note under the list topic name, through the target the catalogue is written with', async () => {
    const { gateway, clock, notes } = notesUnderTest();
    await notes.start();

    await clock.advance(FIRST_END_MS + STREAM_LIST_HEARTBEAT_MS);
    await notes.stop();

    assert.ok(gateway.notes.length >= 1);
    for (const note of gateway.notes) {
      const expected: Omit<WindowSlot, 'window'> = {
        topic: 'swarm-stream',
        kind: 'note',
        windowMs: STREAM_LIST_NOTE_WINDOW_MS,
      };
      assert.deepEqual({ ...note.slot, window: undefined }, { ...expected, window: undefined });
      assert.deepEqual(note.target, TARGET);
    }
  });

  it('starts from the newest write recorded before it, with no write of its own', async () => {
    const log = new FakeFeedWriteLog();
    await log.record(record(40));
    await log.record(record(41));
    const { gateway, clock, notes } = notesUnderTest({ log });
    await notes.start();

    await clock.advance(FIRST_END_MS);
    await notes.stop();

    assert.deepEqual(named(gateway), [[FIRST, 41]], 'the first window is news, the boot head');
  });

  it('names a version recorded through it at the next window end, never before its record finished', async () => {
    const log = new FakeFeedWriteLog();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowLog = Object.assign(Object.create(log) as FakeFeedWriteLog, {
      record: async (write: ReturnType<typeof record>) => {
        await held;
        await log.record(write);
      },
    });
    const { gateway, clock, notes } = notesUnderTest({ log: slowLog });
    await notes.start();

    const recording = notes.record(record(0));
    await clock.advance(FIRST_END_MS);
    assert.equal(gateway.notes.length, 0, 'the version was still being recorded at the window end');

    release();
    await recording;
    await clock.advance(STREAM_LIST_NOTE_WINDOW_MS);
    await notes.stop();

    assert.deepEqual(named(gateway), [[FIRST + 1, 0]]);
  });

  it('writes the news of a failed note again in the following window', async () => {
    const { gateway, clock, notes } = notesUnderTest();
    await notes.start();
    await notes.record(record(3));
    gateway.failNextNote = new Error('the storer did not answer');

    await clock.advance(FIRST_END_MS);
    assert.equal(gateway.notes.length, 0);
    await clock.advance(STREAM_LIST_NOTE_WINDOW_MS);
    await notes.stop();

    assert.deepEqual(named(gateway), [[FIRST + 1, 3]]);
  });

  it('writes no note while the catalogue has no node to write through', async () => {
    const { gateway, clock, notes } = notesUnderTest({ forRead: async () => ({ skipped: 'no catalogue stamp' }) });
    await notes.start();

    await clock.advance(FIRST_END_MS + STREAM_LIST_HEARTBEAT_MS);
    await notes.stop();

    assert.equal(gateway.notes.length, 0);
  });

  it('writes nothing once stopped', async () => {
    const { gateway, clock, notes } = notesUnderTest();
    await notes.start();
    await notes.stop();

    await notes.record(record(0));
    await clock.advance(FIRST_END_MS + STREAM_LIST_HEARTBEAT_MS);

    assert.equal(gateway.notes.length, 0);
  });
});

describe('ListNotes under PublishService', () => {
  async function publishing(notes: ListNotes, gateway: FakeFeedGateway) {
    const renditions = new FakeRenditionStore();
    const store = new FakeStreamStore(renditions);
    const publishService = new PublishService(
      store,
      renditions,
      stagesWithMain(),
      notes,
      gateway,
      noCatalogueStamp(),
      feed,
      new InMemoryAuditLog(),
    );
    return { store, publishService };
  }

  it('names each catalogue version the publish path wrote', async () => {
    const { gateway, clock, notes } = notesUnderTest();
    const { store, publishService } = await publishing(notes, gateway);
    await notes.start();

    await publishService.publish(TEST_OPERATOR, store.add(streamRow()).id);
    await clock.advance(FIRST_END_MS);
    await notes.stop();

    assert.deepEqual(
      gateway.writes.map((write) => write.index),
      [0],
    );
    assert.deepEqual(named(gateway), [[FIRST, 0]]);
  });

  it('names no version whose catalogue write failed', async () => {
    const { gateway, clock, notes } = notesUnderTest();
    const { store, publishService } = await publishing(notes, gateway);
    await notes.start();
    gateway.failNextWrite = new Error('postage exhausted');

    await assert.rejects(publishService.publish(TEST_OPERATOR, store.add(streamRow()).id));
    await clock.advance(FIRST_END_MS + STREAM_LIST_HEARTBEAT_MS);
    await notes.stop();

    assert.ok(gateway.notes.length >= 1, 'the heartbeat still runs');
    assert.ok(
      named(gateway).every(([, newest]) => newest === -1),
      'a note named a version that was never written',
    );
  });
});
