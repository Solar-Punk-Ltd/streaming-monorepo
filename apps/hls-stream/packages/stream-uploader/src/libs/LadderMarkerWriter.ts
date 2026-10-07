import { PrivateKey, Topic } from '@ethersphere/bee-js';
import {
  encodeLadderMarker,
  LADDER_MARKER_VERSION,
  ladderMarkerIdentifier,
  markerPeriodAt,
  markerPeriodStartMs,
} from '@swarm-hls-stream/shared';
import PQueue from 'p-queue';

import { backoffDelayMs, getErrorMessage, isRetryableError } from '../utils/common.js';

import { BeePublisherPool } from './BeePublisherPool.js';
import { Clock, systemClock, Timer } from './Clock.js';
import { Logger } from './Logger.js';

/**
 * How long after a period boundary its marker is written. Long enough that a timer firing a little
 * early still lands inside the new period, short enough that a viewer arriving early in a period
 * usually finds its marker already there.
 */
export const MARKER_WRITE_DELAY_MS = 250;

/**
 * How many markers may be in flight at once across ladders. Each ladder has at most one, since a
 * write is abandoned before its own period ends, so this only matters with several ladders live.
 */
const MARKER_WRITE_CONCURRENCY = 4;

const MARKER_RETRY_BASE_MS = 250;
const MARKER_RETRY_CAP_MS = 1_000;

export interface LadderMarkerMetrics {
  recordLadderMarkerWritten(): void;
  recordLadderMarkerFailed(): void;
}

export interface LadderMarkerLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface LadderMarkerWriterOptions {
  publishers: BeePublisherPool;
  /** The ladder's signer, the key the master feed is written with. */
  signer: PrivateKey;
  /** Timers only. Its `now` is monotonic and never decides a period. */
  clock?: Clock;
  /** Unix milliseconds, which is what a period is counted in and what every reader computes from. */
  wallClockMs?: () => number;
  metrics?: LadderMarkerMetrics;
  logger?: LadderMarkerLogger;
}

/** Rung feed topic as bee-js prints it, to the newest index that rung has published. */
type RungHeads = Map<string, number>;

interface LadderState {
  rungs: RungHeads;
  timer: Timer | null;
  /** The newest period a write was started for, so no period is ever written twice. */
  lastPeriod: number | null;
  /** Periods without a marker since the last one that landed, for the one line a recovery logs. */
  failedInARow: number;
}

/**
 * Writes each live ladder's time marker once every period, through the publisher the master is
 * written through. See `@swarm-hls-stream/shared`'s `ladderMarker` for the convention a reader follows.
 *
 * A marker is a shortcut and never a dependency: a viewer that finds none searches the feeds as it
 * always did. So everything here gives way to the playlists. Writes go on a queue of their own, a
 * write that has not finished inside its own period is abandoned and its request cancelled, and a
 * marker is never rewritten, because a single-owner chunk at one address is meant to hold one answer.
 */
export class LadderMarkerWriter {
  private readonly ladders = new Map<string, LadderState>();
  private readonly queue = new PQueue({ concurrency: MARKER_WRITE_CONCURRENCY });
  private readonly clock: Clock;
  private readonly wallClockMs: () => number;
  private readonly logger: LadderMarkerLogger;

  constructor(private readonly options: LadderMarkerWriterOptions) {
    this.clock = options.clock ?? systemClock;
    this.wallClockMs = options.wallClockMs ?? Date.now;
    this.logger = options.logger ?? Logger.getInstance();
  }

  public get owner(): string {
    return this.options.signer.publicKey().address().toHex();
  }

  /**
   * One rung of a ladder published a playlist at `index` of its feed. The first call for a ladder
   * starts its markers, at the next period boundary.
   *
   * @param rungTopic the rung's feed topic as the uploader names it, before hashing
   */
  public recordPublished(group: string, rungTopic: string, index: number): void {
    let ladder = this.ladders.get(group);
    if (!ladder) {
      ladder = { rungs: new Map(), timer: null, lastPeriod: null, failedInARow: 0 };
      this.ladders.set(group, ladder);
    }

    const topic = Topic.fromString(rungTopic).toHex();
    const known = ladder.rungs.get(topic);
    // Manifest publishes of one rung are serialised, but a retired session and its successor can
    // overlap on one feed, so an older index arriving late must not move the marker backwards.
    if (known === undefined || index > known) {
      ladder.rungs.set(topic, index);
    }

    if (ladder.timer === null) {
      this.scheduleNext(group, ladder);
    }
  }

  /** The ladder has ended. No marker is written for it after this, until it publishes again. */
  public endLadder(group: string): void {
    const ladder = this.ladders.get(group);
    ladder?.timer?.cancel();
    this.ladders.delete(group);
  }

  /** Every ladder stops, for a process that is shutting down. */
  public stop(): void {
    for (const group of [...this.ladders.keys()]) {
      this.endLadder(group);
    }
  }

  private scheduleNext(group: string, ladder: LadderState): void {
    const now = this.wallClockMs();
    const nextBoundary = markerPeriodStartMs(markerPeriodAt(now) + 1);
    ladder.timer = this.clock.setTimer(() => this.onPeriod(group, ladder), nextBoundary + MARKER_WRITE_DELAY_MS - now, {
      unref: true,
    });
  }

  private onPeriod(group: string, ladder: LadderState): void {
    if (this.ladders.get(group) !== ladder) {
      return;
    }
    this.scheduleNext(group, ladder);

    const period = markerPeriodAt(this.wallClockMs());
    // A wall clock stepped back by NTP lands on a period already written. Writing it again would
    // put a second answer at an address a reader may already have cached.
    if (ladder.lastPeriod !== null && period <= ladder.lastPeriod) {
      return;
    }
    ladder.lastPeriod = period;

    const rungs = Object.fromEntries(ladder.rungs);
    void this.queue.add(() => this.write(group, ladder, period, rungs));
  }

  private async write(group: string, ladder: LadderState, period: number, rungs: Record<string, number>) {
    const deadline = markerPeriodStartMs(period + 1);
    try {
      const writtenAt = this.wallClockMs();
      if (writtenAt >= deadline) {
        throw new Error('its period ended before the write could start');
      }
      const payload = encodeLadderMarker({ v: LADDER_MARKER_VERSION, period, writtenAt, rungs });
      await this.uploadWithin(ladder, group, period, payload, deadline);
      this.options.metrics?.recordLadderMarkerWritten();
      this.noteWritten(group, ladder, period);
    } catch (error) {
      this.options.metrics?.recordLadderMarkerFailed();
      this.noteFailed(group, ladder, period, error);
    }
  }

  /** The upload, retried while retrying can help, and abandoned with its request cancelled at `deadline`. */
  private async uploadWithin(
    ladder: LadderState,
    group: string,
    period: number,
    payload: Uint8Array,
    deadline: number,
  ): Promise<void> {
    const identifier = ladderMarkerIdentifier(Topic.fromString(group), period);
    const publisher = this.options.publishers.coordinator();

    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - this.wallClockMs();
      if (remaining <= 0 || this.ladders.get(group) !== ladder) {
        throw new Error('its period ended before the write finished');
      }

      const abort = new AbortController();
      const writer = publisher.bee.soc.makeWriter(this.options.signer, { signal: abort.signal });
      try {
        await this.withinMs(writer.upload(publisher.stamp, identifier, payload, { deferred: false }), remaining, () =>
          abort.abort(),
        );
        return;
      } catch (error) {
        if (abort.signal.aborted || !isRetryableError(error)) {
          throw error;
        }
        const pause = backoffDelayMs(attempt, MARKER_RETRY_BASE_MS, MARKER_RETRY_CAP_MS);
        if (pause >= deadline - this.wallClockMs()) {
          throw error;
        }
        await new Promise<void>((resolve) => this.clock.setTimer(resolve, pause, { unref: true }));
      }
    }
  }

  private withinMs<T>(work: Promise<T>, ms: number, onExpiry: () => void): Promise<T> {
    work.catch(() => {});
    let timer: Timer | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = this.clock.setTimer(
        () => {
          onExpiry();
          reject(new Error('its period ended before the write finished'));
        },
        ms,
        { unref: true },
      );
    });
    return Promise.race([work, expiry]).finally(() => timer?.cancel());
  }

  private noteWritten(group: string, ladder: LadderState, period: number): void {
    if (ladder.failedInARow > 0) {
      this.logger.info(
        `[LadderMarkerWriter] Markers for ladder ${group} are written again from period ${period}, ` +
          `after ${ladder.failedInARow} period(s) without one`,
      );
      ladder.failedInARow = 0;
    }
    this.logger.debug(`[LadderMarkerWriter] Marker for ladder ${group} written for period ${period}`);
  }

  /** The first failure of a run warns, and the rest of the run is debug, so a dead node does not log six lines a minute. */
  private noteFailed(group: string, ladder: LadderState, period: number, error: unknown): void {
    ladder.failedInARow += 1;
    const message =
      `[LadderMarkerWriter] No marker for ladder ${group} in period ${period}: ${getErrorMessage(error)}. ` +
      'Viewers search the feeds instead until one lands.';
    if (ladder.failedInARow === 1) {
      this.logger.warn(message);
    } else {
      this.logger.debug(message);
    }
  }
}
