/**
 * The window reader core: follows one topic and kind of the window convention (`windows.ts`),
 * asking each window once, after it is due, and never again while that ask could still be on Bee's
 * skip list.
 *
 * **The cost that shapes it.** Asking Bee for a chunk before it exists makes Bee skip its peers for
 * that address for about a minute, on the gateway and on the nodes that forwarded the ask, so one
 * early ask delays that window for every viewer on the gateway. Being late only costs the viewer who
 * is late. So the reader is lopsided: it may run a little late, and it keeps its early asks rare and
 * bounded. How late to ask is two separate things kept apart here: the margin, how long propagation
 * takes, which belongs to this reader, and the correction, how far the reader's clock runs ahead,
 * which belongs to the {@link WindowClock} shared by every reader in the client.
 *
 * **A clock running behind cannot be detected.** A reader whose clock runs 5 minutes behind asks
 * windows written 5 minutes earlier, finds them all, and is correct, just that much late.
 *
 * Pure logic: the read, the clock and the timers are injected, and the caller computes the address and
 * checks the owner's signature, so only verified payloads reach it.
 */

import { WINDOW_CLOCK_LIMIT_MS, type AbsentVerdict, type WindowClock } from './windowClock.js';
import { isHeartbeatWindow, WINDOW_READ_MARGIN_MS, type WindowKind, type WindowSlot, windowEnd } from './windows.js';

/**
 * What one read of a window's chunk came back with. `absent` is Bee's 404 or 500 for a single owner
 * chunk it cannot find. `failed` is an unreachable, rate limited or refusing gateway, which says
 * nothing about the window and is not a miss.
 */
export type WindowReadResult =
  | { readonly kind: 'found'; readonly payload: Uint8Array }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly error?: unknown };

/** `silent` is no chunk for longer than the kind's silence: the stream is paused or down. */
export type WindowReaderState = 'idle' | 'opening' | 'live' | 'silent' | 'stopped';

/** Why a window was asked: the opening scan, the steady follow, or the one ask after a sleep or a jump forward. */
export type WindowAskPurpose = 'open' | 'follow' | 'wake';

/** `refused` is a chunk that exists but whose payload the parser refused, which is neither news nor a miss. */
export type WindowAskAnswer = 'found' | 'refused' | 'absent' | 'failed';

/** One ask, as reported to {@link WindowReaderOptions.onAsk} when it is answered. Times by the reader's clock. */
export interface WindowAsk {
  readonly window: number;
  readonly purpose: WindowAskPurpose;
  /** Whether the writer writes this window whatever happens, so its absence is evidence. */
  readonly mustExist: boolean;
  readonly askedAt: number;
  readonly answeredAt: number;
  readonly answer: WindowAskAnswer;
}

/** A found chunk handed to the caller, its payload as the parser returned it. */
export interface WindowFound<T> {
  readonly window: number;
  readonly value: T;
  readonly receivedAt: number;
}

/**
 * How long Bee keeps a peer on its skip list for an address it asked that peer for and did not get,
 * one minute: `skiplistDur` in Bee's `pkg/retrieval/retrieval.go`, re-read in v2.8.2. An ask made
 * this long before another is off the list by then, so asking the window again does no harm.
 */
export const BEE_SKIP_LIST_MS = 60_000;

/** The most asks one window ever gets: the first, and one more once the first is off the skip list. */
export const WINDOW_MAX_ASKS = 2;

/** Windows a `live` reader scans back on opening, newest first. */
export const LIVE_OPEN_SCAN_WINDOWS = 8;

/** Windows asked at once while opening, as the chat's scan does. */
export const WINDOW_OPEN_BATCH = 4;

/** No `live` chunk for this long means the stream is paused or down. */
export const LIVE_SILENCE_MS = 30_000;

/** Must-exist windows absent in a row, unexplained by the clock, before the margin grows. */
export const WINDOW_MARGIN_GROW_AFTER_MISSES = 3;

/** The most the margin grows to. Propagation slower than this is a gateway problem, not a margin to wait out. */
export const WINDOW_READ_MARGIN_MAX_MS = 8000;

/** Found windows in a row before a grown margin halves back toward its base. */
export const WINDOW_MARGIN_SHRINK_AFTER_FOUND = 5;

/**
 * More windows than this due at once, after the correction dropped or the timer ran late, and only the
 * newest is asked. A `live` chunk holds the whole playlist and a note names the newest index, so the
 * newest window carries what the skipped ones would.
 */
export const WINDOW_CATCH_UP_LIMIT = 2;

/** How many asked windows are remembered one by one. Older ones count as closed, so none is asked again. */
const ASKED_MEMORY = 4096;

/** The cadence of what a kind's writer writes, which is what decides which absent windows are evidence. */
export type WindowCadence = { readonly kind: 'live' } | { readonly kind: 'note'; readonly heartbeatMs: number };

/** What a reader needs: what to follow, the shared clock, and the injected read and timers. */
export interface WindowReaderBaseOptions<T extends { readonly writtenAt: number }> {
  readonly topic: string;
  readonly windowMs: number;
  readonly clock: WindowClock;
  /** Reads one window's chunk. The caller computes its address and checks the owner's signature. */
  readonly read: (slot: WindowSlot) => Promise<WindowReadResult>;
  /** `parseLiveWindowPayload` or `parseWindowNote`. A null is a chunk that exists but carries nothing usable. */
  readonly parse: (payload: Uint8Array) => T | null;
  /** The starting margin, {@link WINDOW_READ_MARGIN_MS} unless set. */
  readonly marginMs?: number;
  /**
   * Whether the stream should be live, from what the caller knows, such as the stream list. While it is
   * not, absent windows are no evidence about the clock and no misses.
   */
  readonly isLive?: () => boolean;
  /** The reader's clock in Unix milliseconds, `Date.now` unless set. Fractions are rounded down. */
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** The three callbacks below must not throw: a throw becomes an unhandled rejection. */
  readonly onFound?: (found: WindowFound<T>) => void;
  readonly onState?: (state: WindowReaderState) => void;
  readonly onAsk?: (ask: WindowAsk) => void;
}

/**
 * A reader's options. A `live` writer writes every window while the stream is live. A `note` writer
 * writes a window with news and every aligned heartbeat window, one whose number is a multiple of
 * `heartbeatMs / windowMs`, so only those must exist.
 */
export type WindowReaderOptions<T extends { readonly writtenAt: number }> = WindowReaderBaseOptions<T> & WindowCadence;

/** One answered ask, with what the reader needs to act on it. */
interface Answered<T> {
  readonly window: number;
  readonly answer: WindowAskAnswer;
  readonly value: T | null;
  readonly receivedAt: number;
  readonly mustExist: boolean;
  /** The clock's verdict on an absent must-exist window when it was applied at once, otherwise null. */
  readonly verdict: AbsentVerdict | null;
}

type Evidence =
  | {
      readonly kind: 'found';
      readonly askedAt: number;
      readonly receivedAt: number;
      readonly windowEnd: number;
      readonly writtenAt?: number;
    }
  | { readonly kind: 'absent'; readonly askedAt: number; readonly windowEnd: number };

/** What is known of one asked window, which decides whether it may be asked again. */
interface AskedWindow {
  readonly firstAskedAt: number;
  readonly asks: number;
  /** Null while the ask is still out. */
  answer: WindowAskAnswer | null;
}

/** The reader's timer as set, to tell a wall clock jump or a sleep from the timer's own wait. */
interface TimerSet {
  readonly setAt: number;
  readonly expectedMs: number;
  readonly epoch: number;
}

/**
 * Follows one topic and kind: opens by scanning back and calibrating the shared clock, then asks each
 * window once at `windowEnd + margin + correction` by the reader's clock, in order. A window is asked
 * a second time only when it was not found and its first ask came more than {@link BEE_SKIP_LIST_MS}
 * before it is due by the current calibration, which is how the windows a fast clock asked while
 * opening, minutes before they were written, are still read when they come due. Never a third time.
 *
 * **A known limit: opening during an outage.** A reader opened while no windows are being written, and
 * told the stream is live, cannot tell the outage from a clock running ahead by as long. It takes the
 * newest window it finds, from before the outage, as the newest there is, and may stay that late until
 * reloaded, since a correction never comes back below an early ask. Pass `isLive` from the stream list
 * so absent windows teach the clock nothing while the stream is not live. A direct clock reading from
 * the gateway is the likely fix, a later phase's decision.
 *
 * **Notes alone calibrate slowly.** A note reader learns about its clock only from heartbeat windows,
 * one a minute, so alone with a fast clock it may make one harmful heartbeat ask after its first
 * minutes. Sharing the clock with a live reader removes that.
 *
 * A silence does not open the scan again. Every window it would scan has already been asked, and
 * a clock that stepped forward, which looks exactly like a silence, is caught by the follow loop's own
 * timer instead: a timer that fires late by its own measure is a jump forward or a sleep.
 */
export class WindowReader<T extends { readonly writtenAt: number }> {
  private readonly options: WindowReaderOptions<T>;
  private readonly baseMarginMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly isLive: () => boolean;
  /** Whether a window must exist: every window of a live reader, the heartbeat windows of a note reader. */
  private readonly mustExistWindow: (window: number) => boolean;
  private readonly scanWindows: number;
  private readonly silenceMs: number;

  private current: WindowReaderState = 'idle';
  private margin: number;
  private readonly asked = new Map<number, AskedWindow>();
  private forgottenBelow = 0;
  /** The newest window the follow loop has passed, asked or skipped. */
  private followed = -1;
  private newestExisting: number | null = null;
  private newestDelivered = -1;
  private missRun = 0;
  private marginFoundRun = 0;
  private timer: unknown = null;
  private timerSet: TimerSet | null = null;
  private followAsksInFlight = 0;
  private lastFollowAskAt = -Infinity;
  /** The follow loop is paused until a follow answer arrives, so an unsettled clock gets one probe at a time. */
  private awaitingAnswer = false;
  /** Bumped by stop, so answers that arrive afterwards are dropped. */
  private generation = 0;

  constructor(options: WindowReaderOptions<T>) {
    this.options = options;
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError(`A window length must be a positive whole number of milliseconds, got ${options.windowMs}`);
    }
    this.baseMarginMs = options.marginMs ?? WINDOW_READ_MARGIN_MS;
    this.margin = this.baseMarginMs;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.isLive = options.isLive ?? (() => true);
    if (options.kind === 'note') {
      if (
        !Number.isSafeInteger(options.heartbeatMs) ||
        options.heartbeatMs % options.windowMs !== 0 ||
        options.heartbeatMs <= 0
      ) {
        throw new RangeError(
          `A heartbeat must be a whole number of windows, got ${options.heartbeatMs} for ${options.windowMs}`,
        );
      }
      const { windowMs, heartbeatMs } = options;
      this.mustExistWindow = (window) => isHeartbeatWindow(window, windowMs, heartbeatMs);
      this.scanWindows = Math.ceil(options.heartbeatMs / options.windowMs) + 2;
      this.silenceMs = options.heartbeatMs + 2 * options.windowMs + this.baseMarginMs;
    } else {
      this.mustExistWindow = () => true;
      this.scanWindows = LIVE_OPEN_SCAN_WINDOWS;
      this.silenceMs = LIVE_SILENCE_MS;
    }
  }

  get state(): WindowReaderState {
    return this.current;
  }

  /** The current margin, which grows after misses and shrinks back with found windows. */
  get marginMs(): number {
    return this.margin;
  }

  /** Opens and then follows. Does nothing if already started or stopped. */
  start(): void {
    if (this.current !== 'idle') {
      return;
    }
    this.setState('opening');
    // The read's own failures are caught in ask, so this rejects only if a caller's callback throws.
    void this.open('open', null);
  }

  /** Stops asking. Nothing is asked after this, and answers still on their way are dropped. */
  stop(): void {
    this.generation += 1;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.setState('stopped');
  }

  /**
   * Scans back from the newest due window, newest first, a batch at a time, then widens backward at
   * doubling distances until a chunk is found or the clock limit is passed, so a reader whose clock
   * runs minutes ahead still finds the stream. Hands on the newest found chunk and starts following.
   *
   * On the first opening the evidence is held until a chunk is found, because a stream that is not
   * running looks exactly like a clock far ahead, and must not push the correction up. After a sleep or
   * a forward jump, `first` is the one window asked before anything else, and the evidence counts at
   * once, so an early first ask lifts the correction before the scan goes on.
   */
  private async open(purpose: 'open' | 'wake', first: number | null): Promise<void> {
    const generation = this.generation;
    const held: Evidence[] = [];
    const evidence = purpose === 'wake' ? null : held;
    const origin = first ?? this.newestDue();
    let found: Answered<T>[] = [];
    let scanned = 0;
    const askAll = async (windows: readonly number[]): Promise<boolean> => {
      const answers = await Promise.all(windows.map((window) => this.ask(window, purpose, evidence)));
      if (generation !== this.generation) {
        return false;
      }
      scanned += windows.length;
      found = answers.filter((answer): answer is Answered<T> => answer !== null && exists(answer));
      return true;
    };

    if (first !== null && !(await askAll([first]))) {
      return;
    }
    while (found.length === 0 && scanned < this.scanWindows) {
      const batch = this.unaskedBackFrom(
        this.newestDue(),
        Math.min(WINDOW_OPEN_BATCH, this.scanWindows - scanned),
        origin - this.scanWindows,
      );
      if (batch.length === 0 || !(await askAll(batch))) {
        break;
      }
    }
    const distances = this.wideningDistances();
    for (let i = 0; found.length === 0 && i < distances.length; i += WINDOW_OPEN_BATCH) {
      const batch = distances
        .slice(i, i + WINDOW_OPEN_BATCH)
        .map((distance) => origin - distance)
        .filter((window) => window >= 0 && !this.isClosed(window));
      if (batch.length > 0 && !(await askAll(batch))) {
        break;
      }
    }
    if (generation !== this.generation) {
      return;
    }
    if (found.length > 0) {
      // Found first, so an absent window newer than a found one is judged against what was enough.
      for (const item of [...held].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'found' ? -1 : 1))) {
        this.applyEvidence(item);
      }
      const newest = found.reduce((a, b) => (b.window > a.window ? b : a));
      this.newestExisting = Math.max(this.newestExisting ?? -1, newest.window);
      const delivered = found.filter((answer) => answer.answer === 'found');
      if (delivered.length > 0) {
        this.deliver(delivered.reduce((a, b) => (b.window > a.window ? b : a)));
      }
      this.setState('live');
    } else if (purpose === 'open') {
      this.setState('silent');
    }
    this.followed = Math.max(this.followed, this.newestDue() - 1);
    this.tick();
  }

  /** The follow loop, run by the timer: notices a jump or a sleep, then asks what is due. */
  private tick(): void {
    this.timer = null;
    this.awaitingAnswer = false;
    if (this.current === 'stopped') {
      return;
    }
    const set = this.timerSet;
    this.timerSet = null;
    if (set !== null) {
      const jump = this.options.clock.checkTimer({
        epoch: set.epoch,
        expectedMs: set.expectedMs,
        elapsedMs: this.now() - set.setAt,
      });
      if (jump.kind === 'forward') {
        // A sleep and a jump forward look alike: ask only the newest due window, then open again from it.
        const newest = this.newestDue();
        if (newest > this.followed && !this.isClosed(newest)) {
          this.followed = newest;
          void this.open('wake', newest);
          return;
        }
      }
    }
    const newest = this.newestDue();
    if (newest > this.followed) {
      // While the clock is still being calibrated every ask is a probe, and a probe below the true need
      // hurts every viewer. Asking the next before the last one's answer is in would repeat the same
      // mistake, so one at a time, the newest due.
      const probing = !this.options.clock.settled;
      const waitedMs = this.now() - this.lastFollowAskAt;
      // A read that never answers holds the loop for one window at most.
      if (probing && this.followAsksInFlight > 0 && waitedMs < this.options.windowMs) {
        this.awaitingAnswer = true;
        this.scheduleIn(this.options.windowMs - waitedMs);
        return;
      }
      const from = probing || newest - this.followed > WINDOW_CATCH_UP_LIMIT ? newest : this.followed + 1;
      for (let window = from; window <= newest; window++) {
        if (!this.isClosed(window)) {
          this.followAsksInFlight += 1;
          this.lastFollowAskAt = this.now();
          // ask catches the read's failures, so this rejects only if a caller's callback throws.
          void this.ask(window, 'follow', null).then((answer) => this.onFollowAnswer(answer));
        }
      }
      this.followed = newest;
    }
    this.schedule();
  }

  private schedule(): void {
    this.scheduleIn(this.dueAt(this.followed + 1) - this.now());
  }

  private scheduleIn(ms: number): void {
    if (this.current === 'stopped') {
      return;
    }
    if (this.timer !== null) {
      this.clearTimer(this.timer);
    }
    const expectedMs = Math.max(0, ms);
    this.timerSet = { setAt: this.now(), expectedMs, epoch: this.options.clock.epoch };
    this.timer = this.setTimer(() => this.tick(), expectedMs);
  }

  /** A followed window's answer: acts on it, then resumes the loop if it was waiting for this. */
  private onFollowAnswer(answered: Answered<T> | null): void {
    this.followAsksInFlight -= 1;
    if (answered === null || this.current === 'stopped') {
      return;
    }
    this.actOn(answered);
    if (this.awaitingAnswer) {
      this.awaitingAnswer = false;
      if (this.timer !== null) {
        this.clearTimer(this.timer);
        this.timer = null;
      }
      this.timerSet = null;
      this.tick();
    } else if (this.timer !== null && this.timerSet !== null) {
      // The answer may have lowered the correction, bringing the next window's due time forward.
      const due = this.timerSet.setAt + this.timerSet.expectedMs;
      if (this.dueAt(this.followed + 1) < due) {
        this.schedule();
      }
    }
  }

  /** Acts on a followed window's answer: live, silent, the margin, and handing a found chunk on. */
  private actOn(answered: Answered<T>): void {
    if (exists(answered)) {
      this.missRun = 0;
      this.newestExisting = Math.max(this.newestExisting ?? -1, answered.window);
      if (this.margin > this.baseMarginMs && ++this.marginFoundRun >= WINDOW_MARGIN_SHRINK_AFTER_FOUND) {
        this.margin = Math.max(this.baseMarginMs, this.margin / 2);
        this.marginFoundRun = 0;
      }
      if (answered.answer === 'found') {
        this.deliver(answered);
      }
      this.setState('live');
      return;
    }
    if (answered.answer !== 'absent') {
      return;
    }
    if (answered.verdict === 'writer' && this.current === 'live') {
      this.marginFoundRun = 0;
      if (++this.missRun === WINDOW_MARGIN_GROW_AFTER_MISSES) {
        this.margin = Math.min(WINDOW_READ_MARGIN_MAX_MS, this.margin * 2);
      }
    }
    const quietMs =
      this.newestExisting === null ? Infinity : (answered.window - this.newestExisting) * this.options.windowMs;
    if (this.current === 'live' && quietMs >= this.silenceMs) {
      this.setState('silent');
    }
  }

  /**
   * Asks one window, which {@link isClosed} allowed. Evidence about the clock goes to `held` when given, otherwise to the
   * clock at once. Absent windows count only when they must exist and the stream should be live, and
   * not while silent, when every window is absent and none says anything about the clock.
   */
  private async ask(window: number, purpose: WindowAskPurpose, held: Evidence[] | null): Promise<Answered<T> | null> {
    const generation = this.generation;
    const askedAt = this.now();
    const record = this.remember(window, askedAt);
    const { topic, kind, windowMs } = this.options;
    let result: WindowReadResult;
    try {
      result = await this.options.read({ topic, kind: kind satisfies WindowKind, windowMs, window });
    } catch (error) {
      result = { kind: 'failed', error };
    }
    if (generation !== this.generation) {
      return null;
    }
    const receivedAt = this.now();
    const end = windowEnd(window, windowMs);
    const mustExist = this.mustExistWindow(window);
    const value = result.kind === 'found' ? this.options.parse(result.payload) : null;
    const answer: WindowAskAnswer = result.kind === 'found' ? (value === null ? 'refused' : 'found') : result.kind;
    record.answer = answer;
    let evidence: Evidence | null = null;
    if (answer === 'found' || answer === 'refused') {
      evidence = {
        kind: 'found',
        askedAt,
        receivedAt,
        windowEnd: end,
        ...(value === null ? {} : { writtenAt: value.writtenAt }),
      };
    } else if (answer === 'absent' && mustExist && this.isLive() && this.current !== 'silent') {
      evidence = { kind: 'absent', askedAt, windowEnd: end };
    }
    let verdict: AbsentVerdict | null = null;
    if (evidence !== null) {
      if (held === null) {
        verdict = this.applyEvidence(evidence);
      } else {
        held.push(evidence);
      }
    }
    this.options.onAsk?.({ window, purpose, mustExist, askedAt, answeredAt: receivedAt, answer });
    return { window, answer, value, receivedAt, mustExist, verdict };
  }

  private applyEvidence(evidence: Evidence): AbsentVerdict | null {
    if (evidence.kind === 'found') {
      this.options.clock.found(evidence);
      return null;
    }
    return this.options.clock.absent(evidence);
  }

  private deliver(answered: Answered<T>): void {
    if (answered.value === null || answered.window <= this.newestDelivered) {
      return;
    }
    this.newestDelivered = answered.window;
    this.options.onFound?.({ window: answered.window, value: answered.value, receivedAt: answered.receivedAt });
  }

  private setState(state: WindowReaderState): void {
    if (this.current === state || this.current === 'stopped') {
      return;
    }
    this.current = state;
    this.options.onState?.(state);
  }

  private dueAt(window: number): number {
    return windowEnd(window, this.options.windowMs) + this.margin + this.options.clock.correctionMs;
  }

  /** The newest window due by the corrected clock, or -1 when none is. */
  private newestDue(): number {
    const lastEnd = this.now() - this.margin - this.options.clock.correctionMs;
    return Math.max(-1, Math.floor(lastEnd / this.options.windowMs) - 1);
  }

  /** Up to `count` windows not yet asked, from `newest` back, newest first, none older than `oldest`. */
  private unaskedBackFrom(newest: number, count: number, oldest: number): number[] {
    const windows: number[] = [];
    for (let window = newest; window >= Math.max(0, oldest) && windows.length < count; window--) {
      if (!this.isClosed(window)) {
        windows.push(window);
      }
    }
    return windows;
  }

  /** Doubling distances back from the opening's newest window, up to the first one past the clock limit. */
  private wideningDistances(): number[] {
    const distances: number[] = [];
    for (let distance = 2 * this.scanWindows; ; distance *= 2) {
      distances.push(distance);
      if (distance * this.options.windowMs > WINDOW_CLOCK_LIMIT_MS) {
        return distances;
      }
    }
  }

  /**
   * Whether a window may not be asked now: it was found, its ask is still out, it was asked twice, or
   * its one ask could still be on Bee's skip list when the window is due.
   */
  private isClosed(window: number): boolean {
    if (window < this.forgottenBelow) {
      return true;
    }
    const record = this.asked.get(window);
    if (record === undefined) {
      return false;
    }
    if (
      record.asks >= WINDOW_MAX_ASKS ||
      record.answer === null ||
      record.answer === 'found' ||
      record.answer === 'refused'
    ) {
      return true;
    }
    return this.dueAt(window) - record.firstAskedAt <= BEE_SKIP_LIST_MS;
  }

  private remember(window: number, askedAt: number): AskedWindow {
    const known = this.asked.get(window);
    const record: AskedWindow = {
      firstAskedAt: known?.firstAskedAt ?? askedAt,
      asks: (known?.asks ?? 0) + 1,
      answer: null,
    };
    this.asked.set(window, record);
    if (this.asked.size > ASKED_MEMORY) {
      const sorted = [...this.asked.keys()].sort((a, b) => a - b);
      const keep = new Set(sorted.slice(sorted.length - ASKED_MEMORY / 2));
      this.forgottenBelow = Math.min(...keep);
      for (const old of sorted) {
        if (!keep.has(old)) {
          this.asked.delete(old);
        }
      }
    }
    return record;
  }
}

function exists<T>(answered: Answered<T>): boolean {
  return answered.answer === 'found' || answered.answer === 'refused';
}
