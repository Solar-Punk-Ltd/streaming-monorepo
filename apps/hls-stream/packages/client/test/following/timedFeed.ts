import type { FeedRead, FeedReader } from '../../src/components/SwarmHlsPlayer/following/feedReader';

import type { VirtualTime } from '../feedModel/virtualTime';

interface TimedFeedShape {
  /** True time at which an index becomes readable, or Infinity for one never published. */
  readonly readableAtMs: (index: number) => number;
  /** The newest segment end an index's playlist carries, on the publisher's clock. */
  readonly segmentEndMs: (index: number) => number;
  readonly roundTripMs: number;
}

/**
 * A feed with exact, known readable times and a fixed round trip, for the rules a strategy must keep
 * whatever the network does. The calibrated model of a real node is `test/feedModel`.
 */
export class TimedFeed implements FeedReader {
  readonly asks = new Map<number, number>();
  readonly earlyAsks = new Map<number, number>();
  readonly askTimes = new Map<number, number[]>();
  maxInFlight = 0;
  private inFlight = 0;

  constructor(
    private readonly time: VirtualTime,
    private readonly shape: TimedFeedShape,
  ) {}

  read(index: number): Promise<FeedRead> {
    this.asks.set(index, (this.asks.get(index) ?? 0) + 1);
    this.askTimes.set(index, [...(this.askTimes.get(index) ?? []), this.time.trueNowMs]);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const readable = this.shape.readableAtMs(index) <= this.time.trueNowMs;
    if (!readable && Number.isFinite(this.shape.readableAtMs(index))) {
      this.earlyAsks.set(index, (this.earlyAsks.get(index) ?? 0) + 1);
    }
    return new Promise((resolve) => {
      this.time.at(this.time.trueNowMs + this.shape.roundTripMs, () => {
        this.inFlight -= 1;
        resolve(
          readable
            ? { found: true, entry: { index, newestSegmentEndMs: this.shape.segmentEndMs(index) } }
            : { found: false },
        );
      });
    });
  }

  /** The newest index readable at true time `atMs`, or -1 when none is. */
  newestAt(atMs: number): number {
    let newest = -1;
    while (this.shape.readableAtMs(newest + 1) <= atMs) {
      newest += 1;
    }
    return newest;
  }
}

/** A feed publishing one index every two seconds from true time zero, each readable `lagMs` after its segment ends. */
export function steadyFeed(
  time: VirtualTime,
  options: { firstIndex?: number; lagMs: number; roundTripMs: number; stopsAfter?: number },
): TimedFeed {
  const firstIndex = options.firstIndex ?? 0;
  const stopsAfter = options.stopsAfter ?? Infinity;
  const segmentEndMs = (index: number) => (index - firstIndex) * 2_000;
  return new TimedFeed(time, {
    segmentEndMs,
    readableAtMs: (index) => (index > stopsAfter ? Infinity : segmentEndMs(index) + options.lagMs),
    roundTripMs: options.roundTripMs,
  });
}
