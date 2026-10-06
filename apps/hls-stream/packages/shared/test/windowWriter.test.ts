import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createLiveWindowWriter,
  createNoteWindowWriter,
  WINDOW_WRITE_LATE_LIMIT_MS,
  WINDOW_WRITE_MAX_IN_FLIGHT,
  type WindowWriteEvent,
  type WindowWriterClock,
} from '../src/windowWriter.js';
import {
  LIVE_PLAYLIST_WINDOW_MS,
  parseLiveWindowPayload,
  parseWindowNote,
  windowEnd,
  windowOf,
  type WindowSlot,
} from '../src/windows.js';

/**
 * A wall clock that can jump and a timer queue that runs on its own monotonic time, the way
 * `Date.now()` and `setTimeout` behave: a wall clock step moves `now()` and leaves pending timers due
 * when they were due.
 */
class FakeClock implements WindowWriterClock {
  private monotonic = 0;
  private wallOffset: number;
  private nextId = 1;
  private timers: { id: number; due: number; callback: () => void }[] = [];

  constructor(startMs: number) {
    this.wallOffset = startMs;
  }

  now = (): number => this.monotonic + this.wallOffset;

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ id, due: this.monotonic + Math.max(0, delayMs), callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Steps the wall clock without running anything, as an NTP correction or a manual change does. */
  jump(deltaMs: number): void {
    this.wallOffset += deltaMs;
  }

  /** Lets time pass without running any timer, as a blocked event loop or a sleeping laptop does. */
  stall(ms: number): void {
    this.monotonic += ms;
  }

  /** Runs every timer that falls due in the next `ms`, in order, settling promises after each. */
  async advance(ms: number): Promise<void> {
    const until = this.monotonic + ms;
    for (;;) {
      await settle();
      const due = this.timers.filter((timer) => timer.due <= until).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (due === undefined) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer !== due);
      this.monotonic = Math.max(this.monotonic, due.due);
      due.callback();
    }
    this.monotonic = until;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const WINDOW_MS = LIVE_PLAYLIST_WINDOW_MS;
/** 300 ms into a live window, so the first write is due 1700 ms after start. */
const START_MS = 1793793605300;
const FIRST = windowOf(START_MS, WINDOW_MS);
const FIRST_DUE_MS = windowEnd(FIRST, WINDOW_MS) - START_MS;

const playlistFor = (window: number): string =>
  `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${window}\n#EXTINF:2.0,\nseg-${window}.ts\n`;

interface Written {
  readonly slot: WindowSlot;
  readonly payload: Uint8Array;
  readonly at: number;
}

/** A write that records each call and answers as `answer` says, resolving at once by default. */
function recordingWrite(clock: FakeClock, answer: (slot: WindowSlot) => Promise<void> = () => Promise.resolve()) {
  const calls: Written[] = [];
  const write = (slot: WindowSlot, payload: Uint8Array): Promise<void> => {
    calls.push({ slot, payload, at: clock.now() });
    return answer(slot);
  };
  return { calls, write };
}

function after(clock: FakeClock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

const windowsOf = (calls: readonly Written[]): number[] => calls.map((call) => call.slot.window);
const outcomes = (events: readonly WindowWriteEvent[]): string[] =>
  events.map((event) =>
    event.outcome === 'skipped'
      ? `${event.window} skipped ${event.reason}`
      : event.outcome === 'missed'
        ? `${event.fromWindow}-${event.toWindow} missed`
        : `${event.window} ${event.outcome}`,
  );

function liveWriter(
  clock: FakeClock,
  write: (slot: WindowSlot, payload: Uint8Array) => Promise<void>,
  extra: Partial<Parameters<typeof createLiveWindowWriter>[0]> = {},
) {
  const events: WindowWriteEvent[] = [];
  const writer = createLiveWindowWriter({
    topic: 'stage-1-1080p',
    compose: playlistFor,
    write,
    onEvent: (event) => events.push(event),
    clock,
    ...extra,
  });
  return { writer, events };
}

describe('the live window writer', () => {
  it('names its defaults', () => {
    assert.equal(WINDOW_WRITE_LATE_LIMIT_MS, 500);
    assert.equal(WINDOW_WRITE_MAX_IN_FLIGHT, 2);
  });

  it('writes consecutive windows once each, at their end, with the composed playlist and the time it wrote', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS + 3 * WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 1, FIRST + 2, FIRST + 3]);
    for (const call of calls) {
      assert.deepEqual(call.slot, {
        topic: 'stage-1-1080p',
        kind: 'live',
        windowMs: WINDOW_MS,
        window: call.slot.window,
      });
      assert.equal(call.at, windowEnd(call.slot.window, WINDOW_MS));
      const decoded = parseLiveWindowPayload(call.payload);
      assert.deepEqual(decoded, { playlist: playlistFor(call.slot.window), writtenAt: call.at });
    }
    assert.deepEqual(outcomes(events), [
      `${FIRST} written`,
      `${FIRST + 1} written`,
      `${FIRST + 2} written`,
      `${FIRST + 3} written`,
    ]);
    await writer.stop();
  });

  it('writes nothing for a window with no playlist to publish, and reports it', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write, {
      compose: (window) => (window === FIRST + 1 ? null : playlistFor(window)),
    });
    writer.start();
    await clock.advance(FIRST_DUE_MS + 2 * WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 2]);
    assert.deepEqual(outcomes(events), [`${FIRST} written`, `${FIRST + 1} skipped nothing`, `${FIRST + 2} written`]);
    await writer.stop();
  });

  it('reports a failed write, never retries it, and writes the next window normally', async () => {
    const clock = new FakeClock(START_MS);
    const failure = new Error('the storer refused');
    const { calls, write } = recordingWrite(clock, (slot) =>
      slot.window === FIRST ? Promise.reject(failure) : Promise.resolve(),
    );
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS + 3 * WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 1, FIRST + 2, FIRST + 3]);
    assert.equal(new Set(windowsOf(calls)).size, calls.length, 'no window is written twice');
    const failed = events.find((event) => event.outcome === 'failed');
    assert.ok(failed !== undefined && failed.outcome === 'failed');
    assert.equal(failed.window, FIRST);
    assert.equal(failed.error, failure);
    assert.deepEqual(outcomes(events).slice(1), [
      `${FIRST + 1} written`,
      `${FIRST + 2} written`,
      `${FIRST + 3} written`,
    ]);
    await writer.stop();
  });

  it('reports how long a write took', async () => {
    const clock = new FakeClock(START_MS);
    const { write } = recordingWrite(clock, () => after(clock, 84));
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS + 100);

    assert.deepEqual(events, [
      { outcome: 'written', window: FIRST, writtenAt: windowEnd(FIRST, WINDOW_MS), durationMs: 84 },
    ]);
    await writer.stop();
  });

  it('does not hold the next window back while a slow write is still running', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock, () => after(clock, 3000));
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS + 4 * WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 1, FIRST + 2, FIRST + 3, FIRST + 4]);
    assert.equal(calls[1]?.at, windowEnd(FIRST + 1, WINDOW_MS), 'the second write starts before the first ends');
    assert.ok(events.every((event) => event.outcome !== 'skipped'));
    const stopped = writer.stop();
    await clock.advance(3000);
    await stopped;
  });

  it('skips a window as busy when it would exceed the writes allowed at once', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock, (slot) =>
      slot.window === FIRST ? after(clock, 3000) : Promise.resolve(),
    );
    const { writer, events } = liveWriter(clock, write, { maxInFlight: 1 });
    writer.start();
    await clock.advance(FIRST_DUE_MS + 2 * WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 2]);
    assert.deepEqual(outcomes(events), [`${FIRST + 1} skipped busy`, `${FIRST} written`, `${FIRST + 2} written`]);
    await writer.stop();
  });

  it('writes up to the default two at once and skips the third as busy while both hang', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock, () => new Promise<void>(() => {}));
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS + 2 * WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 1]);
    assert.deepEqual(outcomes(events), [`${FIRST + 2} skipped busy`]);
    void writer.stop();
  });

  it('skips a window whose timer fires 700 ms after its end as late', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    clock.stall(FIRST_DUE_MS + 700);
    await clock.advance(WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST + 1]);
    assert.deepEqual(outcomes(events), [`${FIRST} skipped late`, `${FIRST + 1} written`]);
    await writer.stop();
  });

  it('writes a window whose timer fires within the late limit', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer } = liveWriter(clock, write);
    writer.start();
    clock.stall(FIRST_DUE_MS + WINDOW_WRITE_LATE_LIMIT_MS);
    await clock.advance(0);

    assert.deepEqual(windowsOf(calls), [FIRST]);
    await writer.stop();
  });

  it('never writes a window twice when the clock moves back 5 s, and resumes once it passes the last one', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS);
    assert.deepEqual(windowsOf(calls), [FIRST]);

    clock.jump(-5000);
    await clock.advance(5000);
    assert.deepEqual(windowsOf(calls), [FIRST], 'nothing written while the clock is behind the last window written');

    await clock.advance(3 * WINDOW_MS);
    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 1, FIRST + 2, FIRST + 3]);
    for (const call of calls) {
      assert.equal(call.at, windowEnd(call.slot.window, WINDOW_MS));
    }
    assert.ok(events.every((event) => event.outcome === 'written'));
    await writer.stop();
  });

  it('does not spin when the clock steps back 30 days, and writes again once the clock passes the last window', async () => {
    const clock = new FakeClock(START_MS);
    const NODE_TIMER_LIMIT_MS = 2 ** 31 - 1;
    let armed = 0;
    // Node fires a timer longer than its limit after 1 ms, which a plain fake would not.
    const nodeLike: WindowWriterClock = {
      now: clock.now,
      setTimeout: (callback, delayMs) => {
        armed++;
        return clock.setTimeout(callback, delayMs > NODE_TIMER_LIMIT_MS ? 1 : delayMs);
      },
      clearTimeout: clock.clearTimeout,
    };
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write, { clock: nodeLike });
    writer.start();
    await clock.advance(FIRST_DUE_MS);
    assert.deepEqual(windowsOf(calls), [FIRST]);

    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    clock.jump(-thirtyDays);
    const before = armed;
    await clock.advance(60000);
    assert.ok(armed - before <= 5, `armed ${armed - before} timers in a minute`);
    assert.deepEqual(windowsOf(calls), [FIRST]);

    clock.jump(thirtyDays + 5000);
    await clock.advance(70000);
    assert.ok(windowsOf(calls).length >= 2, 'writes again');
    assert.ok(events.every((event) => event.outcome !== 'failed'));
    await writer.stop();
  });

  it('writes only the window that just ended after the clock jumps forward 60 s, and reports the rest once', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS);
    clock.jump(60000);
    await clock.advance(WINDOW_MS);

    const landed = FIRST + 1 + 60000 / WINDOW_MS;
    assert.deepEqual(windowsOf(calls), [FIRST, landed]);
    assert.deepEqual(outcomes(events), [`${FIRST} written`, `${FIRST + 1}-${landed - 1} missed`, `${landed} written`]);
    await writer.stop();
  });

  it('writes only the window that just ended after a 60 s stall, and reports the rest once', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS);
    clock.stall(WINDOW_MS + 60000);
    await clock.advance(0);

    const landed = FIRST + 1 + 60000 / WINDOW_MS;
    assert.deepEqual(windowsOf(calls), [FIRST, landed]);
    assert.deepEqual(outcomes(events), [`${FIRST} written`, `${FIRST + 1}-${landed - 1} missed`, `${landed} written`]);
    await clock.advance(WINDOW_MS);
    assert.deepEqual(windowsOf(calls), [FIRST, landed, landed + 1]);
    await writer.stop();
  });

  it('skips a window and writes nothing while the clock is not trusted', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    let trusted = false;
    const { writer, events } = liveWriter(clock, write, { clockTrusted: () => trusted });
    writer.start();
    await clock.advance(FIRST_DUE_MS);
    trusted = true;
    await clock.advance(WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST + 1]);
    assert.deepEqual(outcomes(events), [`${FIRST} skipped clockUntrusted`, `${FIRST + 1} written`]);
    await writer.stop();
  });

  it('skips a window whose playlist is over 4096 bytes as too large', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const tooLong = `#EXTM3U\n#EXT-X-VERSION:3\n${'#EXTINF:2.0,\nsegment.ts\n'.repeat(200)}`;
    const { writer, events } = liveWriter(clock, write, {
      compose: (window) => (window === FIRST ? tooLong : playlistFor(window)),
    });
    writer.start();
    await clock.advance(FIRST_DUE_MS + WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST + 1]);
    assert.deepEqual(outcomes(events), [`${FIRST} skipped tooLarge`, `${FIRST + 1} written`]);
    await writer.stop();
  });

  it('reports a window as failed and keeps going when composing it throws', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write, {
      compose: (window) => (window === FIRST ? 'not a playlist\n' : playlistFor(window)),
    });
    writer.start();
    await clock.advance(FIRST_DUE_MS + WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST + 1]);
    assert.deepEqual(outcomes(events), [`${FIRST} failed`, `${FIRST + 1} written`]);
    await writer.stop();
  });

  it('writes nothing after stop, and lets a running write finish without scheduling more', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock, () => after(clock, 1500));
    const { writer, events } = liveWriter(clock, write);
    writer.start();
    await clock.advance(FIRST_DUE_MS + 100);
    assert.deepEqual(windowsOf(calls), [FIRST]);

    const stopped = writer.stop();
    let stopReturned = false;
    void stopped.then(() => {
      stopReturned = true;
    });
    await clock.advance(1400);
    assert.ok(stopReturned, 'stop resolves once the running write has finished');
    await stopped;
    await clock.advance(5 * WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST]);
    assert.deepEqual(outcomes(events), [`${FIRST} written`]);
    assert.equal(clock.pendingTimers, 0);
  });

  it('writes its windows normally on a clock that reads fractions of a millisecond', async () => {
    const clock = new FakeClock(START_MS);
    const fractional: WindowWriterClock = {
      now: () => clock.now() + 0.7,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = liveWriter(clock, write, { clock: fractional });
    writer.start();
    await clock.advance(FIRST_DUE_MS + 2 * WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 1, FIRST + 2]);
    assert.deepEqual(
      events.map((event) => event.outcome),
      ['written', 'written', 'written'],
    );
    for (const call of calls) {
      assert.ok(Number.isInteger(parseLiveWindowPayload(call.payload)?.writtenAt));
    }
    await writer.stop();
  });

  it('starts once however often start is called', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer } = liveWriter(clock, write);
    writer.start();
    writer.start();
    await clock.advance(FIRST_DUE_MS + WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [FIRST, FIRST + 1]);
    await writer.stop();
  });

  it('refuses a late limit or a write limit that makes no sense', () => {
    const clock = new FakeClock(START_MS);
    const { write } = recordingWrite(clock);
    assert.throws(() => liveWriter(clock, write, { lateLimitMs: -1 }), RangeError);
    assert.throws(() => liveWriter(clock, write, { maxInFlight: 0 }), RangeError);
    assert.throws(() => liveWriter(clock, write, { maxInFlight: 1.5 }), RangeError);
    assert.throws(() => liveWriter(clock, write, { windowMs: 0 }), RangeError);
  });
});

describe('the note window writer', () => {
  /** 2 s windows with a heartbeat every third window, so heartbeat windows are those divisible by 3. */
  const NOTE_WINDOW_MS = 2000;
  const HEARTBEAT_MS = 6000;
  const firstHeartbeat = Math.ceil(FIRST / 3) * 3;

  function noteWriter(
    clock: FakeClock,
    write: (slot: WindowSlot, payload: Uint8Array) => Promise<void>,
    newestStored: () => number,
  ) {
    const events: WindowWriteEvent[] = [];
    const writer = createNoteWindowWriter({
      topic: 'stream-list',
      windowMs: NOTE_WINDOW_MS,
      heartbeatMs: HEARTBEAT_MS,
      newestStored,
      write,
      onEvent: (event) => events.push(event),
      clock,
    });
    return { writer, events };
  }

  const notesOf = (calls: readonly Written[]) =>
    calls.map((call) => ({ window: call.slot.window, note: parseWindowNote(call.payload) }));

  it('with no news writes only the aligned heartbeat windows, naming -1 before anything is stored', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    const { writer, events } = noteWriter(clock, write, () => -1);
    writer.start();
    await clock.advance(FIRST_DUE_MS + 6 * NOTE_WINDOW_MS);

    assert.deepEqual(windowsOf(calls), [firstHeartbeat, firstHeartbeat + 3]);
    for (const call of calls) {
      assert.deepEqual(call.slot, {
        topic: 'stream-list',
        kind: 'note',
        windowMs: NOTE_WINDOW_MS,
        window: call.slot.window,
      });
      assert.deepEqual(parseWindowNote(call.payload), {
        newest: -1,
        writtenAt: windowEnd(call.slot.window, NOTE_WINDOW_MS),
      });
    }
    assert.equal(events.filter((event) => event.outcome === 'skipped' && event.reason === 'nothing').length, 5);
    await writer.stop();
  });

  it('writes news at the next window end and then only the heartbeat', async () => {
    const clock = new FakeClock(START_MS);
    const { calls, write } = recordingWrite(clock);
    let newest = -1;
    const { writer } = noteWriter(clock, write, () => newest);
    writer.start();
    // Into the first window that is not a heartbeat, then store index 4 during it.
    const news = firstHeartbeat + 1;
    await clock.advance(windowEnd(news - 1, NOTE_WINDOW_MS) - START_MS + 500);
    newest = 4;
    await clock.advance(5 * NOTE_WINDOW_MS);

    assert.deepEqual(notesOf(calls), [
      { window: firstHeartbeat, note: { newest: -1, writtenAt: windowEnd(firstHeartbeat, NOTE_WINDOW_MS) } },
      { window: news, note: { newest: 4, writtenAt: windowEnd(news, NOTE_WINDOW_MS) } },
      { window: firstHeartbeat + 3, note: { newest: 4, writtenAt: windowEnd(firstHeartbeat + 3, NOTE_WINDOW_MS) } },
    ]);
    await writer.stop();
  });

  it("writes a failed news note again in the following window, at that window's address", async () => {
    const clock = new FakeClock(START_MS);
    const news = firstHeartbeat + 1;
    const { calls, write } = recordingWrite(clock, (slot) =>
      slot.window === news ? Promise.reject(new Error('the storer refused')) : Promise.resolve(),
    );
    let newest = -1;
    const { writer, events } = noteWriter(clock, write, () => newest);
    writer.start();
    await clock.advance(windowEnd(news - 1, NOTE_WINDOW_MS) - START_MS + 500);
    newest = 4;
    await clock.advance(2 * NOTE_WINDOW_MS);

    assert.deepEqual(
      notesOf(calls).filter((entry) => entry.window >= news),
      [
        { window: news, note: { newest: 4, writtenAt: windowEnd(news, NOTE_WINDOW_MS) } },
        { window: news + 1, note: { newest: 4, writtenAt: windowEnd(news + 1, NOTE_WINDOW_MS) } },
      ],
    );
    assert.deepEqual(outcomes(events).slice(-2), [`${news} failed`, `${news + 1} written`]);
    await writer.stop();
  });

  it('refuses a heartbeat that is not a positive whole multiple of the window', () => {
    const clock = new FakeClock(START_MS);
    const { write } = recordingWrite(clock);
    for (const heartbeatMs of [5000, 0, -6000, 1000, 6000.5, Number.NaN]) {
      assert.throws(
        () =>
          createNoteWindowWriter({
            topic: 'stream-list',
            windowMs: NOTE_WINDOW_MS,
            heartbeatMs,
            newestStored: () => -1,
            write,
            clock,
          }),
        RangeError,
        `heartbeatMs ${heartbeatMs}`,
      );
    }
  });
});
