/**
 * A deterministic simulated network for the window reader: true time, a reader clock that runs at
 * true time plus an offset, writers that write each window shortly after its end, and a gateway that
 * remembers an early ask the way Bee does.
 *
 * The gateway rule is the one fact the reader is built around. Asking Bee for a chunk before it is
 * readable makes it skip its peers for that address for about a minute, so an ask made while the
 * chunk is not yet readable, when the chunk then becomes readable within 60 s, poisons the window
 * until 60 s after the ask: every ask in that time answers absent, even after the write. Such an ask
 * is counted as harmful, because it delays the window for every viewer on that gateway.
 *
 * Time is fake and event driven, so a run of many minutes takes milliseconds. Timers and answers are
 * events on one queue in true time. A stall holds every event in its span until it ends, which is
 * what a sleeping laptop or a hidden tab does to timers and to the answers waiting behind them.
 */

import {
  encodeLiveWindowPayload,
  encodeWindowNote,
  LIVE_PLAYLIST_WINDOW_MS,
  windowEnd,
  type WindowSlot,
} from '../src/windows.js';
import type { WindowReadResult } from '../src/windowReader.js';

/** Bee's skip list for an address asked too early, measured on the chat at about a minute. */
export const POISON_MS = 60_000;

/** A fixed true start, a whole number of 10 s windows, so runs are reproducible. */
export const SIM_START_MS = 1_793_793_600_000;

/** The writer's delay after a window's end, and how long Bee then takes to make the chunk readable. */
const WRITE_DELAY_MS: Range = [20, 150];
const READABLE_DELAY_MS: Range = [100, 300];
/** How long the gateway takes to answer. */
const ANSWER_DELAY_MS: Range = [50, 300];

type Range = readonly [number, number];

/** Mulberry32, small and seeded, so every run of a scenario draws the same delays. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimEvent {
  at: number;
  readonly seq: number;
  readonly run: () => void;
  cancelled: boolean;
}

/** One ask as the gateway saw it. */
export interface SimAsk {
  readonly topic: string;
  readonly window: number;
  readonly windowEnd: number;
  readonly readerAskedAt: number;
  readonly trueAskedAt: number;
  readonly trueAnsweredAt: number;
  readonly answer: 'found' | 'absent';
  /** Asked before the chunk was readable, for a chunk that is written at some point. */
  readonly early: boolean;
  /** Early by less than {@link POISON_MS}, so it poisoned the window for every viewer. */
  readonly harmful: boolean;
  /** For a found ask, how long after the window's end the answer arrived, in true time. */
  readonly trueDelay: number | null;
}

/** When one window becomes readable, and its payload. */
interface WrittenWindow {
  readonly writtenAt: number;
  readonly readableAt: number;
  readonly payload: Uint8Array;
}

export type WriterPlan =
  | {
      readonly kind: 'live';
      /** Windows the writer never writes. */
      readonly skip?: ReadonlySet<number>;
      /** Extra delay before the write of a window, in ms. */
      readonly late?: ReadonlyMap<number, number>;
      /** True time spans during which nothing is written, `[from, to)`. */
      readonly stopped?: readonly (readonly [number, number])[];
    }
  | {
      readonly kind: 'note';
      readonly heartbeatMs: number;
      /** Windows that carry news, and so a note, besides the aligned heartbeat ones. */
      readonly news: ReadonlySet<number>;
    };

/** The fake world: true time, the reader's clock, the timers and the gateway. */
export class SimWorld {
  trueNow: number;
  /** The reader's clock reads true time plus this. */
  offsetMs = 0;
  readonly asks: SimAsk[] = [];
  private readonly queue: SimEvent[] = [];
  private seq = 0;
  private stall: { from: number; to: number } | null = null;
  private readonly poisonedUntil = new Map<string, number>();
  private readonly topics = new Map<string, Map<number, WrittenWindow>>();
  private readonly random: () => number;

  constructor(seed: number, startMs = SIM_START_MS) {
    this.trueNow = startMs;
    this.random = seededRandom(seed);
  }

  /** The reader's clock. */
  readonly now = (): number => this.trueNow + this.offsetMs;

  readonly setTimeout = (callback: () => void, ms: number): SimEvent =>
    this.schedule(this.trueNow + Math.max(0, ms), callback);

  readonly clearTimeout = (handle: unknown): void => {
    (handle as SimEvent).cancelled = true;
  };

  /** Holds every timer and answer due in `[from, from + ms)` until the span ends. */
  holdEvents(from: number, ms: number): void {
    this.stall = { from, to: from + ms };
  }

  /** Runs the queue until a true time, letting every promise settle after each event. */
  async runUntil(trueMs: number): Promise<void> {
    for (;;) {
      const next = this.popDue(trueMs);
      if (next === null) {
        break;
      }
      this.trueNow = Math.max(this.trueNow, next.at);
      next.run();
      await settle();
    }
    this.trueNow = Math.max(this.trueNow, trueMs);
  }

  /** Runs a function at a true time, such as a clock jump. */
  at(trueMs: number, run: () => void): void {
    this.schedule(trueMs, run);
  }

  /**
   * Writes a topic's windows over a true time span, as its writer would: each one shortly after the
   * window's end, readable a little later.
   */
  writeTopic(topic: string, windowMs: number, fromMs: number, toMs: number, plan: WriterPlan): void {
    const written = this.topics.get(topic) ?? new Map<number, WrittenWindow>();
    this.topics.set(topic, written);
    let newest = 0;
    for (let w = Math.floor(fromMs / windowMs); windowEnd(w, windowMs) <= toMs; w++) {
      const end = windowEnd(w, windowMs);
      if (plan.kind === 'live') {
        if (plan.skip?.has(w) === true || plan.stopped?.some(([a, b]) => end >= a && end < b) === true) {
          continue;
        }
        const writtenAt = end + this.draw(WRITE_DELAY_MS) + (plan.late?.get(w) ?? 0);
        const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${w}\n#EXTINF:2.000,\nseg-${w}.ts\n`;
        written.set(w, {
          writtenAt,
          readableAt: writtenAt + this.draw(READABLE_DELAY_MS),
          payload: encodeLiveWindowPayload(playlist, writtenAt),
        });
      } else {
        const heartbeat = w % (plan.heartbeatMs / windowMs) === 0;
        const news = plan.news.has(w);
        if (news) {
          newest += 1;
        }
        if (!heartbeat && !news) {
          continue;
        }
        const writtenAt = end + this.draw(WRITE_DELAY_MS);
        written.set(w, {
          writtenAt,
          readableAt: writtenAt + this.draw(READABLE_DELAY_MS),
          payload: encodeWindowNote({ newest, writtenAt }),
        });
      }
    }
  }

  /** The injected read: what the gateway answers for a slot asked now, after its answer delay. */
  readonly read = (slot: WindowSlot): Promise<WindowReadResult> => {
    const trueAskedAt = this.trueNow;
    const readerAskedAt = this.now();
    const key = `${slot.topic}/${slot.window}`;
    const chunk = this.topics.get(slot.topic)?.get(slot.window);
    const poisoned = (this.poisonedUntil.get(key) ?? -Infinity) > trueAskedAt;
    const readable = chunk !== undefined && trueAskedAt >= chunk.readableAt;
    const earlyBy = chunk === undefined ? 0 : chunk.readableAt - trueAskedAt;
    const early = earlyBy > 0;
    const harmful = early && earlyBy < POISON_MS;
    if (harmful) {
      this.poisonedUntil.set(key, Math.max(this.poisonedUntil.get(key) ?? 0, trueAskedAt + POISON_MS));
    }
    const found = readable && !poisoned;
    const trueAnsweredAt = trueAskedAt + this.draw(ANSWER_DELAY_MS);
    const end = windowEnd(slot.window, slot.windowMs);
    this.asks.push({
      topic: slot.topic,
      window: slot.window,
      windowEnd: end,
      readerAskedAt,
      trueAskedAt,
      trueAnsweredAt,
      answer: found ? 'found' : 'absent',
      early,
      harmful,
      trueDelay: found ? trueAnsweredAt - end : null,
    });
    return new Promise((resolve) => {
      this.schedule(trueAnsweredAt, () =>
        resolve(found && chunk !== undefined ? { kind: 'found', payload: chunk.payload } : { kind: 'absent' }),
      );
    });
  };

  private draw([low, high]: Range): number {
    return Math.round(low + (high - low) * this.random());
  }

  private schedule(at: number, run: () => void): SimEvent {
    const event: SimEvent = { at, seq: this.seq++, run, cancelled: false };
    this.queue.push(event);
    return event;
  }

  private popDue(limit: number): SimEvent | null {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const event = this.queue[i];
        const current = best === -1 ? undefined : this.queue[best];
        if (event !== undefined && (current === undefined || before(event, current))) {
          best = i;
        }
      }
      const event = best === -1 ? undefined : this.queue[best];
      if (event === undefined || event.at > limit) {
        return null;
      }
      this.queue.splice(best, 1);
      if (event.cancelled) {
        continue;
      }
      if (this.stall !== null && event.at >= this.stall.from && event.at < this.stall.to) {
        event.at = this.stall.to;
        this.queue.push(event);
        continue;
      }
      return event;
    }
  }
}

function before(a: SimEvent, b: SimEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

/** Lets every promise continuation queued by an event run before the next event. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export const LIVE_MS = LIVE_PLAYLIST_WINDOW_MS;
