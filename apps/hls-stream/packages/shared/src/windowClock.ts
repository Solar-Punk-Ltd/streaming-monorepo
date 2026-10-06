/**
 * One calibration of a client's clock against the window writers' clocks, shared by every window
 * reader in that client.
 *
 * **Why the calibration is lopsided.** Asking Bee for a chunk before it exists makes Bee skip its peers
 * for that address for about a minute, on the gateway and on every node that forwarded the ask. The
 * skip list belongs to the node, not to the viewer, so one viewer whose clock runs fast poisons a
 * window for every viewer on that gateway, while a viewer who asks late only costs itself. So the
 * correction moves up at once on evidence of an early ask, and comes down only slowly, on a run of
 * found windows, and never below where an early ask last happened.
 *
 * **What it can learn.** The reader's clock reads true time plus an unknown offset `A`, constant
 * between jumps. Each found chunk says when it was written, so `A <= receivedAt - writtenAt`
 * ({@link WindowClock.aheadAtMost}, the chat's `aheadAtMost`). Each window that must exist and was
 * absent says the ask came before the chunk was readable, so `A > askedAt - windowEnd - writeSlack`
 * ({@link WindowClock.aheadMoreThan}). A writer that failed that window gives a false lower bound,
 * which only makes the reader later, never earlier.
 *
 * **What it cannot learn.** A clock running behind true time is never detected. A reader running 5
 * minutes behind asks windows written 5 minutes earlier, finds every one, and plays 5 minutes late.
 * Detecting it would mean asking windows the reader believes are not due yet, which is exactly the
 * early ask that hurts every viewer.
 *
 * **The correction.** A reader asks window `w` at `windowEnd(w) + margin + correctionMs` by its own
 * clock. The correction is held in the terms of the base margin, {@link WINDOW_READ_MARGIN_MS}: an ask
 * made `askedAt - windowEnd - baseMargin` past its base due time is an ask "at" that correction, so
 * evidence from readers with a grown margin compares with the rest.
 *
 * **Jumps.** A wall clock that moves backward is seen by a timer firing early by its own measure, and
 * shifts the whole calibration by the jump. A timer firing late is a forward jump or a sleep, which
 * look alike: the correction stays, so a sleep costs nothing, and the upper side of the bracket opens
 * by the gap, so an absent window then reads as the clock having moved and the correction climbs.
 */

import { STREAM_LIST_NOTE_WINDOW_MS, WINDOW_READ_MARGIN_MS } from './windows.js';

/**
 * How long after a window's end its chunk may take to become readable: the writer's delay and Bee's
 * propagation together. An absent window asked later than this past its end means the reader's clock
 * runs ahead. It must stay below the base margin, or a correct clock would ask too early.
 *
 * Tied to `WINDOW_WRITE_LATE_LIMIT_MS` in `windowWriter.ts`: that limit plus a write (about 120 ms
 * measured) plus propagation (about 300 ms) must stay under the base margin of 1000 ms.
 */
export const WINDOW_WRITE_SLACK_MS = 500;

/**
 * The furthest the correction goes either way: 5 minutes, which the plan asks to survive, plus the
 * longest window in use, the stream list's.
 */
export const WINDOW_CLOCK_LIMIT_MS = 5 * 60_000 + STREAM_LIST_NOTE_WINDOW_MS;

/** How far above the lower bound the correction sits, and how much one run of found windows takes off it. */
export const WINDOW_CLOCK_SAFETY_STEP_MS = 250;

/** A bracket of this width or less between the floor and the best found ask is settled. */
export const WINDOW_CLOCK_SETTLE_WIDTH_MS = 4 * WINDOW_CLOCK_SAFETY_STEP_MS;

/**
 * While unsettled, each found window moves the correction this fraction of the way from the best found
 * ask down to the floor. Small, so an ask below the true need, the one that hurts other viewers, lands
 * close under it: a crossing is at most an eighth of the bracket deep. A reader that finds a window
 * rarely, such as a note reader alone, descends that much more slowly in time.
 */
export const WINDOW_CLOCK_DESCENT_FRACTION = 1 / 8;

/** Found windows in a row, across every reader sharing the clock, before a settled correction steps down. */
export const WINDOW_CLOCK_SHRINK_AFTER_FOUND = 10;

/**
 * How far absent windows the clock cannot explain may lift the correction above the best found ask. A
 * window whose writer failed looks like one asked a hair too early, so each such run lifts it one
 * step, and this cap keeps a stream of writer misses from creeping the reader later and later.
 */
export const WINDOW_CLOCK_WRITER_MISS_CAP_MS = 2 * WINDOW_CLOCK_SAFETY_STEP_MS;

/** How far a timer may fire from its own measure before the wall clock counts as having jumped. */
export const WINDOW_CLOCK_JUMP_TOLERANCE_MS = 1000;

/** The applied jumps a late timer reading is compared against. Timers outlive a handful of jumps at most. */
const JUMP_HISTORY = 16;

/** An absent window explained by the clock running ahead, or not, which leaves a writer or Bee late. */
export type AbsentVerdict = 'clock' | 'writer';

/** What a timer reading showed about the wall clock, in milliseconds it moved beyond the timer's own wait. */
export type ClockJump = { readonly kind: 'none' } | { readonly kind: 'backward' | 'forward'; readonly ms: number };

/** A chunk found, all times by the reader's clock except `writtenAt`, which is the writer's. */
export interface FoundEvidence {
  readonly askedAt: number;
  readonly receivedAt: number;
  readonly windowEnd: number;
  /** Absent when the payload was refused, which proves the chunk exists and says nothing of when it was written. */
  readonly writtenAt?: number;
}

/** A window that must exist, asked and absent. */
export interface AbsentEvidence {
  readonly askedAt: number;
  readonly windowEnd: number;
}

/** A timer as one reader set it and saw it fire, for jump detection. */
export interface TimerReading {
  /** {@link WindowClock.epoch} when the timer was set. */
  readonly epoch: number;
  /** What the timer was set for. */
  readonly expectedMs: number;
  /** How far the reader's clock moved between setting it and its firing. */
  readonly elapsedMs: number;
}

export interface WindowClockOptions {
  /** The base margin the correction is held against, the smallest margin any reader sharing it uses. */
  readonly baseMarginMs?: number;
  readonly writeSlackMs?: number;
  readonly limitMs?: number;
}

interface AppliedJump {
  readonly epoch: number;
  readonly ms: number;
}

/**
 * The shared clock calibration. Feed it every found window and every absent window that must exist,
 * and read {@link WindowClock.correctionMs} when scheduling an ask.
 */
export class WindowClock {
  private readonly baseMarginMs: number;
  private readonly writeSlackMs: number;
  private readonly limitMs: number;

  private correction = 0;
  /** Where the correction would rest with no evidence: 0, the reader's own clock, moved only by jumps. */
  private trusted = 0;
  /** The largest correction an ask was made at and found the chunk not yet readable. */
  private tooEarly = -Infinity;
  /** The smallest correction an ask was made at and found the chunk. */
  private enough = Infinity;
  /** One step above where the last absent window the clock could not explain was asked. */
  private writerMissFloor = -Infinity;
  private upper = Infinity;
  private foundRun = 0;
  private jumpEpoch = 0;
  private readonly jumps: AppliedJump[] = [];

  constructor(options: WindowClockOptions = {}) {
    this.baseMarginMs = options.baseMarginMs ?? WINDOW_READ_MARGIN_MS;
    this.writeSlackMs = options.writeSlackMs ?? WINDOW_WRITE_SLACK_MS;
    this.limitMs = options.limitMs ?? WINDOW_CLOCK_LIMIT_MS;
    if (this.writeSlackMs >= this.baseMarginMs) {
      throw new RangeError('The write slack must be below the base margin, or an accurate clock asks too early');
    }
  }

  /** The milliseconds a reader adds to a window's end and its margin before asking for it. */
  get correctionMs(): number {
    return this.correction;
  }

  /** How far ahead of true time the reader's clock runs at most, from the found chunks' write times. */
  get aheadAtMost(): number {
    return this.upper;
  }

  /** How far ahead of true time the reader's clock runs at least, exclusive, from absent windows. */
  get aheadMoreThan(): number {
    return this.tooEarly + this.baseMarginMs - this.writeSlackMs;
  }

  /**
   * Whether the correction now only moves by single steps: some ask was found, and either no ask was
   * ever early, so the reader's own clock stands, or the bracket between the floor and the best found
   * ask is narrow.
   */
  get settled(): boolean {
    return (
      Number.isFinite(this.enough) &&
      (this.tooEarly === -Infinity || this.enough - this.shrinkFloor <= WINDOW_CLOCK_SETTLE_WIDTH_MS)
    );
  }

  /** Counts the jumps applied, so a reader's timer reading is compared only against jumps since it was set. */
  get epoch(): number {
    return this.jumpEpoch;
  }

  /** A chunk was found: an upper bound from its write time, and the correction it was asked at was enough. */
  found(evidence: FoundEvidence): void {
    this.enough = Math.min(this.enough, this.correctionOf(evidence.askedAt, evidence.windowEnd));
    if (evidence.writtenAt !== undefined) {
      const ahead = evidence.receivedAt - evidence.writtenAt;
      this.upper = Math.min(this.upper, ahead);
      // An ask at the upper bound less the slack lands after the chunk is readable whatever `A` is.
      this.enough = Math.min(this.enough, ahead - this.baseMarginMs + this.writeSlackMs);
    }
    this.foundRun += 1;
    this.settle(true);
    if (this.settled && this.foundRun >= WINDOW_CLOCK_SHRINK_AFTER_FOUND) {
      this.foundRun = 0;
      this.setCorrection(Math.max(this.shrinkFloor, this.correction - WINDOW_CLOCK_SAFETY_STEP_MS));
    }
  }

  /**
   * A window that must exist was absent. Explained by the clock when it was asked below the best found
   * correction by more than a step, and the correction rises above it. Otherwise a writer or Bee was
   * late, or this window took longer than the one found at that correction, which nothing here can
   * tell apart, so the correction rises one step above the ask, within a cap, and does not come back
   * below it.
   */
  absent(evidence: AbsentEvidence): AbsentVerdict {
    const askedAtCorrection = this.correctionOf(evidence.askedAt, evidence.windowEnd);
    this.foundRun = 0;
    if (askedAtCorrection < this.enough - WINDOW_CLOCK_SAFETY_STEP_MS) {
      this.tooEarly = Math.max(this.tooEarly, askedAtCorrection);
      // Back up to the best found correction, the one known to be enough, and descend again from there.
      if (Number.isFinite(this.enough)) {
        this.setCorrection(Math.max(this.floor, this.enough));
      }
      this.settle(false);
      return 'clock';
    }
    this.writerMissFloor = askedAtCorrection + WINDOW_CLOCK_SAFETY_STEP_MS;
    const cap = Math.max(this.enough, this.floor) + WINDOW_CLOCK_WRITER_MISS_CAP_MS;
    this.setCorrection(Math.min(Math.max(this.correction, askedAtCorrection) + WINDOW_CLOCK_SAFETY_STEP_MS, cap));
    return 'writer';
  }

  /**
   * Compares how far the reader's clock moved with how long a timer was set for. Applies what the jumps
   * already applied since the timer was set do not account for, so a jump that several readers' timers
   * all span moves the calibration once. Returns what this timer saw, which the reader acts on itself.
   */
  checkTimer(reading: TimerReading): ClockJump {
    const observed = reading.elapsedMs - reading.expectedMs;
    const applied = this.jumps.filter((jump) => jump.epoch > reading.epoch).reduce((sum, jump) => sum + jump.ms, 0);
    const residual = observed - applied;
    if (residual < -WINDOW_CLOCK_JUMP_TOLERANCE_MS) {
      this.shift(residual);
      this.record(residual);
    } else if (residual > WINDOW_CLOCK_JUMP_TOLERANCE_MS) {
      this.openUpward(residual);
      this.record(residual);
    }
    if (observed < -WINDOW_CLOCK_JUMP_TOLERANCE_MS) {
      return { kind: 'backward', ms: observed };
    }
    if (observed > WINDOW_CLOCK_JUMP_TOLERANCE_MS) {
      return { kind: 'forward', ms: observed };
    }
    return { kind: 'none' };
  }

  private correctionOf(askedAt: number, windowEnd: number): number {
    return askedAt - windowEnd - this.baseMarginMs;
  }

  /** The lowest correction the evidence allows: the lower bound plus a step, or the trusted clock. */
  private get floor(): number {
    return Math.max(this.trusted, this.aheadMoreThan + WINDOW_CLOCK_SAFETY_STEP_MS);
  }

  /** The lowest a settled correction shrinks to: the floor, or just above the last unexplained miss. */
  private get shrinkFloor(): number {
    return Math.max(this.floor, Math.min(this.writerMissFloor, this.enough + WINDOW_CLOCK_WRITER_MISS_CAP_MS));
  }

  /**
   * Moves the correction into the bracket. Unsettled, it descends from the best found ask toward the
   * floor by {@link WINDOW_CLOCK_DESCENT_FRACTION} for each found window, never below the last
   * unexplained miss. Settled, it stays where it is between the shrink floor and the best found ask,
   * so only a writer miss lifts it and only a run of found windows lowers it.
   */
  private settle(descend: boolean): void {
    if (!Number.isFinite(this.enough)) {
      this.setCorrection(Math.max(this.correction, this.floor));
    } else if (!this.settled) {
      // Stepped from the best found ask, not from the current correction: no step is taken twice
      // before an ask has been made, and found, at the last one.
      const floor = this.shrinkFloor;
      const step = descend ? this.enough - (this.enough - floor) * WINDOW_CLOCK_DESCENT_FRACTION : this.correction;
      this.setCorrection(Math.max(floor, Math.min(this.correction, step)));
    } else {
      const shrinkFloor = this.shrinkFloor;
      this.setCorrection(Math.max(shrinkFloor, Math.min(this.correction, Math.max(this.enough, shrinkFloor))));
    }
  }

  private setCorrection(value: number): void {
    this.correction = Math.max(-this.limitMs, Math.min(this.limitMs, Math.round(value)));
  }

  /** A backward jump moves everything the calibration knows by the same amount. */
  private shift(ms: number): void {
    this.trusted += ms;
    this.tooEarly += ms;
    this.enough += ms;
    this.writerMissFloor += ms;
    this.upper += ms;
    this.setCorrection(this.correction + ms);
  }

  /**
   * A forward gap is a sleep, where nothing changed, or a jump of up to its size. What was enough may
   * now fall short by the gap, so the best found ask and the upper bound move up. The lower bounds stay
   * true either way, and the correction stays, so a sleep costs nothing.
   */
  private openUpward(ms: number): void {
    this.enough += ms;
    this.upper += ms;
    this.foundRun = 0;
  }

  private record(ms: number): void {
    this.jumpEpoch += 1;
    this.jumps.push({ epoch: this.jumpEpoch, ms });
    if (this.jumps.length > JUMP_HISTORY) {
      this.jumps.shift();
    }
  }
}
