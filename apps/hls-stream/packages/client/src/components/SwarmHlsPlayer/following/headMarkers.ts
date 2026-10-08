import { markerPeriodAt, markerPeriodStartMs } from '@swarm-hls-stream/shared';

import type { FollowClock } from './feedReader';

/**
 * How long after its period starts a ladder marker is asked for. The uploader writes it 250 ms into
 * the period, its upload takes up to about a second, and a single-owner chunk nobody asked for early
 * was readable from another node about 1.5 s after its write (measured 2026-10-01).
 */
export const MARKER_READ_DELAY_MS = 4_000;

/**
 * The ladder markers of one feed, one per period, each asked at most once. What a read yields is the
 * caller's: a follower takes the index a marker names for its rung, a page waiting on a broadcast takes
 * only that a marker is there.
 *
 * ⛔ **A marker address is never asked twice.** Asking one again and again before it is written would
 * be the very pile of early asks this exists to avoid, so one found missing is let go and the next
 * period's is waited for. A period whose moment passed while nobody was waiting is skipped, because a
 * newer marker says more.
 * Periods are counted on the gateway's clock, which is the viewer's plus `offsetMs`.
 */
export class PeriodMarkers<T = number> {
  private nextPeriod = 0;

  constructor(
    private readonly clock: FollowClock,
    private readonly offsetMs: () => number,
    /** One read of the marker of `period`, or null when it is missing or says nothing to the caller. */
    private readonly readPeriod: (period: number) => Promise<T | null>,
  ) {}

  nextDueMs(): number {
    return markerPeriodStartMs(this.duePeriod()) + MARKER_READ_DELAY_MS - this.offsetMs();
  }

  readNext(): Promise<T | null> {
    const period = this.duePeriod();
    this.nextPeriod = period + 1;
    return this.readPeriod(period);
  }

  private duePeriod(): number {
    const current = markerPeriodAt(Math.max(0, this.clock.now() + this.offsetMs()));
    this.nextPeriod = Math.max(this.nextPeriod, current);
    return this.nextPeriod;
  }
}
