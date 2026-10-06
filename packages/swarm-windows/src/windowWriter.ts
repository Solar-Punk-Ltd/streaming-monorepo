/**
 * The writer side of the window convention: one chunk per window, written once at the window's end.
 *
 * **Why the rules are strict.** Bee answers a chunk asked for before it exists by skipping its peers
 * for that address for about a minute, and two different payloads written to one single owner chunk
 * address are as bad as two writers on one feed index. So a window is written once, at its end, and
 * never again. A failed write is left alone, because the next window carries the same news at a new
 * address. A window whose end is long past is left alone too, because a reader asks for it 1 s after
 * its end and a write starting later may land after the reader asked.
 *
 * Two writers share one schedule. The `live` writer publishes a quality's live playlist every window.
 * The `note` writer names a feed's newest stored index when it changes, and in every heartbeat window.
 *
 * Pure logic: the clock, the timers and the write are injected. The caller's `write` signs the single
 * owner chunk with the stream's key and uploads it direct, never deferred, resolving on the storer's
 * receipt and rejecting on any failure.
 */

import {
  encodeLiveWindowPayload,
  encodeWindowNote,
  isHeartbeatWindow,
  LIVE_PLAYLIST_WINDOW_MS,
  WindowChunkTooLargeError,
  windowEnd,
  type WindowKind,
  windowOf,
  type WindowSlot,
} from './windows.js';

/**
 * How long after a window's end its write may still start. Past this the window is skipped as late,
 * since a reader first asks at the end plus 1 s and a write needs time to land.
 *
 * Tied to `WINDOW_WRITE_SLACK_MS` in `windowClock.ts`: this limit plus a write (about 120 ms measured)
 * plus propagation (about 300 ms) must stay under the base read margin, `WINDOW_READ_MARGIN_MS`
 * (1000 ms), or a reader with an accurate clock asks before the chunk is readable.
 */
export const WINDOW_WRITE_LATE_LIMIT_MS = 500;

/**
 * The longest a single timer is armed for. Node fires a timer longer than about 24.8 days after 1 ms,
 * which would turn a large clock step back into a tight loop. An early fire re-arms.
 */
const MAX_TIMER_MS = 60_000;

/** How many window writes may run at once before a window is skipped as busy. */
export const WINDOW_WRITE_MAX_IN_FLIGHT = 2;

/**
 * Why a window was not written. `nothing` is a live writer with no playlist, or a note writer with no
 * news in a window that is not a heartbeat. `tooLarge` is a live playlist over the window chunk limit,
 * which the caller shortens.
 */
type WindowSkipReason = 'nothing' | 'busy' | 'late' | 'clockUntrusted' | 'tooLarge' | 'stopped';

/** The window's chunk was stored. `durationMs` runs from the start of the write to the storer's receipt. */
interface WindowWritten {
  readonly outcome: 'written';
  readonly window: number;
  readonly writtenAt: number;
  readonly durationMs: number;
}

/** The write rejected, or the payload could not be made. The window is never tried again. */
interface WindowWriteFailed {
  readonly outcome: 'failed';
  readonly window: number;
  readonly error: unknown;
  readonly durationMs: number;
}

interface WindowSkipped {
  readonly outcome: 'skipped';
  readonly window: number;
  readonly reason: WindowSkipReason;
}

/**
 * Windows passed over in one go when the clock jumped forward or the process stalled, reported once
 * rather than as a burst of stale writes. Both ends are included.
 */
interface WindowsMissed {
  readonly outcome: 'missed';
  readonly fromWindow: number;
  readonly toWindow: number;
}

/** What happened to a window. Every window the writer reaches gets exactly one, a missed range one in all. */
export type WindowWriteEvent = WindowWritten | WindowWriteFailed | WindowSkipped | WindowsMissed;

/** The clock and timers, `Date.now` and the global timers unless the caller hands its own. */
export interface WindowWriterClock {
  /** Unix milliseconds. A fraction is rounded down by the writer, so `performance`-style clocks are fine. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Signs and uploads one window's chunk direct, resolving on the storer's receipt, rejecting on any failure. */
type WindowWrite = (slot: WindowSlot, payload: Uint8Array) => Promise<void>;

interface WindowWriterOptions {
  readonly topic: string;
  readonly write: WindowWrite;
  /** Must not throw: a throw becomes an unhandled rejection. */
  readonly onEvent?: (event: WindowWriteEvent) => void;
  /** Asked before each write. While it answers false, windows are skipped. */
  readonly clockTrusted?: () => boolean;
  /** Defaults to {@link WINDOW_WRITE_LATE_LIMIT_MS}. */
  readonly lateLimitMs?: number;
  /** Defaults to {@link WINDOW_WRITE_MAX_IN_FLIGHT}. */
  readonly maxInFlight?: number;
  readonly clock?: WindowWriterClock;
}

interface LiveWindowWriterOptions extends WindowWriterOptions {
  /** Defaults to {@link LIVE_PLAYLIST_WINDOW_MS}. */
  readonly windowMs?: number;
  /**
   * The quality's live playlist for a window that just ended, naming only segments whose own upload
   * finished, or null when there is nothing to publish.
   */
  readonly compose: (window: number) => string | null;
}

interface NoteWindowWriterOptions extends WindowWriterOptions {
  /** The stream list's or the chat's note window length. */
  readonly windowMs: number;
  /** A positive whole multiple of `windowMs`. Every window whose number is a multiple of the ratio carries a note. */
  readonly heartbeatMs: number;
  /** The newest feed index whose own write finished, or -1 while none has. */
  readonly newestStored: () => number;
}

interface WindowWriter {
  /** Schedules the end of the current window. Calling it while started does nothing. */
  start(): void;
  /**
   * Clears the timer and starts no new write, so nothing is written once this returns. The promise
   * settles when the writes already running have finished.
   */
  stop(): Promise<void>;
}

const systemClock: WindowWriterClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
  },
};

/** What goes in a window: its bytes and written-at time with what to do once stored, or why nothing does. */
type WindowContent =
  | { readonly payload: Uint8Array; readonly writtenAt: number; readonly onWritten?: () => void }
  | { readonly skip: WindowSkipReason };

interface ScheduleOptions extends WindowWriterOptions {
  readonly kind: WindowKind;
  readonly windowMs: number;
  readonly contentFor: (window: number, now: number) => WindowContent;
}

/**
 * A live playlist writer: every window while started, the composed playlist with its written-at line.
 *
 * @throws RangeError when `windowMs`, `lateLimitMs` or `maxInFlight` is out of range.
 */
export function createLiveWindowWriter(options: LiveWindowWriterOptions): WindowWriter {
  const { compose } = options;
  return scheduleWindows({
    ...options,
    kind: 'live',
    windowMs: options.windowMs ?? LIVE_PLAYLIST_WINDOW_MS,
    contentFor: (window, now) => {
      const playlist = compose(window);
      if (playlist === null) {
        return { skip: 'nothing' };
      }
      try {
        return { payload: encodeLiveWindowPayload(playlist, now), writtenAt: now };
      } catch (error) {
        if (error instanceof WindowChunkTooLargeError) {
          return { skip: 'tooLarge' };
        }
        throw error;
      }
    },
  });
}

/**
 * A note writer: a note `{ newest, writtenAt }` in a window with news and in every heartbeat window.
 *
 * News is a newest index that differs from the one in the last note whose write succeeded, -1 before
 * any has. A note that failed is not news delivered, so the next window writes it again at its own
 * address.
 *
 * @throws RangeError when `heartbeatMs` is not a positive whole multiple of `windowMs`, or another
 * option is out of range.
 */
export function createNoteWindowWriter(options: NoteWindowWriterOptions): WindowWriter {
  const { windowMs, heartbeatMs, newestStored } = options;
  assertWindowMs(windowMs);
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs % windowMs !== 0) {
    throw new RangeError(
      `A heartbeat must be a positive whole multiple of the ${windowMs} ms window, got ${heartbeatMs}`,
    );
  }
  let announced = -1;
  return scheduleWindows({
    ...options,
    kind: 'note',
    contentFor: (window, now) => {
      const newest = newestStored();
      if (newest === announced && !isHeartbeatWindow(window, windowMs, heartbeatMs)) {
        return { skip: 'nothing' };
      }
      return {
        payload: encodeWindowNote({ newest, writtenAt: now }),
        writtenAt: now,
        onWritten: () => {
          announced = Math.max(announced, newest);
        },
      };
    },
  });
}

/** Leans on `windowEnd`, which refuses a window length that is not a positive safe integer. */
function assertWindowMs(windowMs: number): void {
  windowEnd(0, windowMs);
}

function scheduleWindows(options: ScheduleOptions): WindowWriter {
  const { topic, kind, windowMs, write, contentFor } = options;
  const injected = options.clock ?? systemClock;
  const clock: WindowWriterClock = {
    now: () => Math.floor(injected.now()),
    setTimeout: (callback, delayMs) => injected.setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
      injected.clearTimeout(handle);
    },
  };
  const lateLimitMs = options.lateLimitMs ?? WINDOW_WRITE_LATE_LIMIT_MS;
  const maxInFlight = options.maxInFlight ?? WINDOW_WRITE_MAX_IN_FLIGHT;
  const clockTrusted = options.clockTrusted ?? (() => true);
  const report = options.onEvent ?? (() => {});

  assertWindowMs(windowMs);
  if (!Number.isSafeInteger(lateLimitMs) || lateLimitMs < 0) {
    throw new RangeError(`A late limit must be a non-negative whole number of milliseconds, got ${lateLimitMs}`);
  }
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
    throw new RangeError(`The writes allowed at once must be a positive whole number, got ${maxInFlight}`);
  }

  let started = false;
  let timer: unknown = undefined;
  /** The newest window this writer has dealt with, written or not, so that none is ever reached twice. */
  let lastReached = -1;
  const running = new Set<Promise<void>>();

  /** Arms the timer from the clock as it reads now, so that drift never adds up across windows. */
  const armNext = (): void => {
    const now = clock.now();
    const next = Math.max(windowOf(now, windowMs), lastReached + 1);
    timer = clock.setTimeout(
      () => {
        timer = undefined;
        onWindowEnd(next);
      },
      Math.min(windowEnd(next, windowMs) - now, MAX_TIMER_MS),
    );
  };

  const onWindowEnd = (due: number): void => {
    if (!started) {
      return;
    }
    const now = clock.now();
    const ended = windowOf(now, windowMs) - 1;
    if (ended < due) {
      // The clock moved back while the timer waited, so by this clock the window has not ended yet.
      armNext();
      return;
    }
    if (ended > due) {
      report({ outcome: 'missed', fromWindow: due, toWindow: ended - 1 });
    }
    lastReached = ended;
    armNext();
    writeWindow(ended, now);
  };

  const writeWindow = (window: number, now: number): void => {
    if (now - windowEnd(window, windowMs) > lateLimitMs) {
      report({ outcome: 'skipped', window, reason: 'late' });
      return;
    }
    if (running.size >= maxInFlight) {
      report({ outcome: 'skipped', window, reason: 'busy' });
      return;
    }
    let content: WindowContent;
    try {
      if (!clockTrusted()) {
        report({ outcome: 'skipped', window, reason: 'clockUntrusted' });
        return;
      }
      content = contentFor(window, now);
    } catch (error) {
      report({ outcome: 'failed', window, error, durationMs: 0 });
      return;
    }
    if ('skip' in content) {
      report({ outcome: 'skipped', window, reason: content.skip });
      return;
    }
    // The callbacks above may have stopped the writer.
    if (!started) {
      report({ outcome: 'skipped', window, reason: 'stopped' });
      return;
    }
    const startedAt = clock.now();
    let receipt: Promise<void>;
    try {
      receipt = write({ topic, kind, windowMs, window }, content.payload);
    } catch (error) {
      receipt = Promise.reject(error);
    }
    const attempt = receipt
      .then(
        () => {
          content.onWritten?.();
          report({ outcome: 'written', window, writtenAt: content.writtenAt, durationMs: clock.now() - startedAt });
        },
        (error: unknown) => {
          report({ outcome: 'failed', window, error, durationMs: clock.now() - startedAt });
        },
      )
      .finally(() => {
        running.delete(attempt);
      });
    running.add(attempt);
  };

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      armNext();
    },
    async stop() {
      started = false;
      if (timer !== undefined) {
        clock.clearTimeout(timer);
        timer = undefined;
      }
      await Promise.allSettled([...running]);
    },
  };
}
