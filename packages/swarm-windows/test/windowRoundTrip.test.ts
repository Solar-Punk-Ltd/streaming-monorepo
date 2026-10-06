import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WindowClock } from '../src/windowClock.js';
import { WindowReader, type WindowFound, type WindowReadResult } from '../src/windowReader.js';
import { createLiveWindowWriter, createNoteWindowWriter, type WindowWriteEvent } from '../src/windowWriter.js';
import {
  isHeartbeatWindow,
  LIVE_PLAYLIST_WINDOW_MS,
  type LiveWindowPayload,
  parseLiveWindowPayload,
  parseWindowNote,
  STREAM_LIST_HEARTBEAT_MS,
  STREAM_LIST_NOTE_WINDOW_MS,
  type WindowNote,
  type WindowSlot,
  windowEnd,
  windowOf,
} from '../src/windows.js';
import { SIM_START_MS, SimWorld } from './windowSim.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** How long a write takes to reach the store, and how long a read takes to answer. */
const WRITE_MS = 120;
const READ_MS = 100;

/** A chunk store in memory: what the real writer writes and the real reader reads, keyed by slot. */
function memoryStore(world: SimWorld) {
  const chunks = new Map<string, Uint8Array>();
  const keyOf = (slot: WindowSlot): string => `${slot.topic}/${slot.kind}/${slot.window}`;
  const write = (slot: WindowSlot, payload: Uint8Array): Promise<void> =>
    new Promise((resolve) => {
      world.setTimeout(() => {
        chunks.set(keyOf(slot), payload);
        resolve();
      }, WRITE_MS);
    });
  const read = (slot: WindowSlot): Promise<WindowReadResult> =>
    new Promise((resolve) => {
      world.setTimeout(() => {
        const payload = chunks.get(keyOf(slot));
        resolve(payload === undefined ? { kind: 'absent' } : { kind: 'found', payload });
      }, READ_MS);
    });
  return { write, read };
}

const writtenWindows = (events: readonly WindowWriteEvent[]): number[] =>
  events.flatMap((event) => (event.outcome === 'written' ? [event.window] : []));

describe('the real window writer into the real window reader', () => {
  it('notes: every news index is delivered and every heartbeat window is found', async () => {
    const windowMs = STREAM_LIST_NOTE_WINDOW_MS;
    const world = new SimWorld(1);
    const store = memoryStore(world);
    let newest = -1;
    for (const [index, atSeconds] of [95, 131, 153, 240].entries()) {
      world.at(SIM_START_MS + atSeconds * SECOND, () => {
        newest = index;
      });
    }
    const events: WindowWriteEvent[] = [];
    const writer = createNoteWindowWriter({
      topic: 'event-streams',
      windowMs,
      heartbeatMs: STREAM_LIST_HEARTBEAT_MS,
      newestStored: () => newest,
      write: store.write,
      onEvent: (event) => events.push(event),
      clock: world,
    });
    const founds: WindowFound<WindowNote>[] = [];
    const reader = new WindowReader<WindowNote>({
      kind: 'note',
      topic: 'event-streams',
      windowMs,
      heartbeatMs: STREAM_LIST_HEARTBEAT_MS,
      clock: new WindowClock(),
      read: store.read,
      parse: parseWindowNote,
      now: world.now,
      setTimeout: world.setTimeout,
      clearTimeout: world.clearTimeout,
      onFound: (found) => founds.push(found),
    });
    const readerStart = SIM_START_MS + 2 * MINUTE;
    const end = SIM_START_MS + 8 * MINUTE;
    writer.start();
    await world.runUntil(readerStart);
    reader.start();
    await world.runUntil(end);
    reader.stop();
    const stopped = writer.stop();
    await world.runUntil(end + SECOND);
    await stopped;

    const found = new Set(founds.map((entry) => entry.window));
    const heartbeats = [];
    for (let w = windowOf(readerStart, windowMs); windowEnd(w, windowMs) + 5 * SECOND < end; w++) {
      if (isHeartbeatWindow(w, windowMs, STREAM_LIST_HEARTBEAT_MS)) {
        heartbeats.push(w);
      }
    }
    assert.ok(heartbeats.length >= 5);
    assert.deepEqual(
      heartbeats.filter((w) => !found.has(w)),
      [],
      'every heartbeat window found',
    );
    const written = writtenWindows(events).filter(
      (w) => w >= windowOf(readerStart, windowMs) && windowEnd(w, windowMs) + 5 * SECOND < end,
    );
    assert.deepEqual(
      written.filter((w) => !found.has(w)),
      [],
      'every window the writer wrote found',
    );
    const delivered = new Set(founds.map((entry) => entry.value.newest));
    for (const index of [0, 1, 2, 3]) {
      assert.ok(delivered.has(index), `news index ${index} delivered`);
    }
    assert.deepEqual(
      events.filter((event) => event.outcome === 'failed' || event.outcome === 'missed'),
      [],
    );
  });

  it('live: every window is found', async () => {
    const windowMs = LIVE_PLAYLIST_WINDOW_MS;
    const world = new SimWorld(2);
    const store = memoryStore(world);
    const events: WindowWriteEvent[] = [];
    const writer = createLiveWindowWriter({
      topic: 'stage-1-1080p',
      compose: (window) =>
        `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${window}\n#EXTINF:2.000,\nseg-${window}.ts\n`,
      write: store.write,
      onEvent: (event) => events.push(event),
      clock: world,
    });
    const founds: WindowFound<LiveWindowPayload>[] = [];
    const reader = new WindowReader<LiveWindowPayload>({
      kind: 'live',
      topic: 'stage-1-1080p',
      windowMs,
      clock: new WindowClock(),
      read: store.read,
      parse: parseLiveWindowPayload,
      now: world.now,
      setTimeout: world.setTimeout,
      clearTimeout: world.clearTimeout,
      onFound: (found) => founds.push(found),
    });
    const readerStart = SIM_START_MS + 20 * SECOND;
    const end = SIM_START_MS + 4 * MINUTE;
    writer.start();
    await world.runUntil(readerStart);
    reader.start();
    await world.runUntil(end);
    reader.stop();
    const stopped = writer.stop();
    await world.runUntil(end + SECOND);
    await stopped;

    const found = new Set(founds.map((entry) => entry.window));
    const expected = [];
    for (let w = windowOf(readerStart, windowMs); windowEnd(w, windowMs) + 5 * SECOND < end; w++) {
      expected.push(w);
    }
    assert.ok(expected.length >= 100);
    assert.deepEqual(
      expected.filter((w) => !found.has(w)),
      [],
      'every window found',
    );
    assert.deepEqual(
      events.filter((event) => event.outcome !== 'written'),
      [],
    );
  });
});
