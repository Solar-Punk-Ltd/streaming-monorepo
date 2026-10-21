import { DEFAULT_READ_TIMEOUT_MS } from '@/swarm/provider';

/** How many of the latest misses the typical one is read from. */
const MISSES_KEPT = 16;

/**
 * How many misses a source must have answered before their median judges it. The first misses after a
 * source is picked pay for its connection, its name lookup and its cold cache, and the median of one or
 * two is a single miss, so one slow start would otherwise mark a fast gateway slow, say so to the viewer
 * and have it wait two minutes for a quality it does not hold.
 */
const MISSES_FOR_A_MEDIAN = 5;

/**
 * Before {@link MISSES_FOR_A_MEDIAN}, a source is slow only when at least this many misses were all
 * slow. Without it the light node could not be judged in time: when its first quality's 20 s ran out it
 * had answered two misses, its two time marker reads, each over 5.6 s (2026-10-18), and the level was
 * failed before a fifth arrived.
 */
const MISSES_ALL_SLOW_EARLY = 2;

/**
 * A typical miss slower than this makes a source slow. Full Bee nodes answered a miss in 1.3 to 1.6 s
 * and a freshly started light node in a median of 6 to 7 s (2026-10-17 and 18), so the line sits well
 * clear of both.
 */
const SLOW_SOURCE_MISS_MS = 3_000;

/**
 * How much longer than its typical miss a round of reads made at once lasts on a slow source, since a
 * round ends with its slowest read. The 90th percentile of the light node's misses was 1.3 and 1.45
 * times their median on the two runs measured.
 */
const ROUND_PER_TYPICAL_MISS = 1.5;

/** How many rounds a single read on a slow source may take before it is given up on. */
const READ_WINDOW_ROUNDS = 2;

/**
 * The longest a round is taken to last, so a read on a slow source is never given more than two such
 * rounds, 30 s, and a level request never waits more than about two minutes. Given a longer window the
 * light node's misses stretched to 12 to 18 s, so the cost a source shows depends in part on what it is
 * allowed, and this keeps that from growing without end.
 */
const LONGEST_ROUND_MS = 15_000;

/**
 * How long the source the player reads from takes to say a slot is not there, timed on the player's
 * own reads, and what the player allows a slow one.
 *
 * A miss is what a search for a rung's newest index pays for most, since every round asks for slots
 * past the head, and it is what differs most between sources. Only answered misses count. A read that
 * timed out or failed says nothing about what an answer costs.
 *
 * The median rather than the slowest, so one slow answer from a fast gateway does not make it slow.
 * Nothing changes for a source that is not slow: its reads keep their usual window, and a level request
 * on it waits as it always did.
 */
export class SourceMissCost {
  private misses: number[] = [];
  private readonly listeners = new Set<() => void>();

  record(durationMs: number): void {
    this.misses = [...this.misses, durationMs].slice(-MISSES_KEPT);
    this.notify();
  }

  /** The median of the latest misses, or null before any. */
  typicalMs(): number | null {
    if (this.misses.length === 0) {
      return null;
    }
    const sorted = [...this.misses].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * The miss this source is judged by, or null while too few have been answered to judge it. Early on
   * that is the fastest of misses that were all slow, so a single fast one keeps the source fast.
   */
  private judgedTypicalMs(): number | null {
    if (this.misses.length >= MISSES_FOR_A_MEDIAN) {
      return this.typicalMs();
    }
    if (this.misses.length >= MISSES_ALL_SLOW_EARLY && this.misses.every((missMs) => missMs > SLOW_SOURCE_MISS_MS)) {
      return Math.min(...this.misses);
    }
    return null;
  }

  isSlow(): boolean {
    return this.roundMs() !== null;
  }

  /** How long a round of a search takes on this source when it is slow, or null when it is not. */
  roundMs(): number | null {
    const typicalMs = this.judgedTypicalMs();
    return typicalMs === null || typicalMs <= SLOW_SOURCE_MISS_MS
      ? null
      : Math.min(LONGEST_ROUND_MS, ROUND_PER_TYPICAL_MISS * typicalMs);
  }

  /**
   * The window a read on this source is given when it is slow, or null for the usual one.
   *
   * **A read cut short on a slow source is worse than a long one.** On the light node one read in six
   * to eight ran past the usual 10 s, and a search with one read it could not finish fails whole, backs
   * off and starts again, so it never got through the five or six rounds it needed. Asking the same
   * address again soon after makes Bee skip the peers it asked, which makes the next try slower still.
   */
  readWindowMs(): number | null {
    const roundMs = this.roundMs();
    return roundMs === null ? null : Math.max(DEFAULT_READ_TIMEOUT_MS, READ_WINDOW_ROUNDS * roundMs);
  }

  /** Forgets every miss, for a new source whose cost has not been seen. */
  reset(): void {
    if (this.misses.length === 0) {
      return;
    }
    this.misses = [];
    this.notify();
  }

  /** Told after every change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
