import type { FeedRead, FeedReader } from '../../src/components/SwarmHlsPlayer/following/feedReader';

import type { VirtualTime } from '../feedModel/virtualTime';

interface TimedFeedShape {
  /** True time at which an index becomes readable, or Infinity for one never published. */
  readonly readableAtMs: (index: number) => number;
  /** The newest segment end an index's playlist carries, on the publisher's clock. */
  readonly segmentEndMs: (index: number) => number;
  /** How long each segment the playlists name lasts. */
  readonly segmentMs: number;
  readonly roundTripMs: number;
  /**
   * Answer as a Bee node answers an address asked before it exists (Bee 2.8.2,
   * `pkg/retrieval/retrieval.go`): each such ask puts one of `peers` peers on a skip list for that
   * address for `skipMs`, and with every peer skipped the address answers not found at once, written
   * or not, and puts nobody else on the list.
   */
  readonly skipList?: { readonly peers: number; readonly skipMs: number };
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
  /** Per index, until when each skipped peer stays skipped. */
  private readonly skippedUntil = new Map<number, number[]>();

  constructor(
    private readonly time: VirtualTime,
    private readonly shape: TimedFeedShape,
  ) {}

  read(index: number): Promise<FeedRead> {
    this.asks.set(index, (this.asks.get(index) ?? 0) + 1);
    this.askTimes.set(index, [...(this.askTimes.get(index) ?? []), this.time.trueNowMs]);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const written = this.shape.readableAtMs(index) <= this.time.trueNowMs;
    if (!written && Number.isFinite(this.shape.readableAtMs(index))) {
      this.earlyAsks.set(index, (this.earlyAsks.get(index) ?? 0) + 1);
    }
    const peerLeft = this.servedPast(index, written);
    const readable = written && peerLeft;
    return new Promise((resolve) => {
      this.time.at(this.time.trueNowMs + this.shape.roundTripMs, () => {
        this.inFlight -= 1;
        resolve(
          readable
            ? {
                found: true,
                entry: { index, newestSegmentEndMs: this.shape.segmentEndMs(index), segmentMs: this.shape.segmentMs },
              }
            : { found: false },
        );
      });
    });
  }

  /** Whether the node still has a peer to ask for this index, and the skip an early ask leaves. */
  private servedPast(index: number, written: boolean): boolean {
    const skipList = this.shape.skipList;
    if (skipList === undefined) {
      return true;
    }
    const now = this.time.trueNowMs;
    const skipped = (this.skippedUntil.get(index) ?? []).filter((until) => until > now);
    const peerLeft = skipped.length < skipList.peers;
    if (peerLeft && !written) {
      skipped.push(now + skipList.skipMs);
    }
    this.skippedUntil.set(index, skipped);
    return peerLeft;
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

/**
 * A feed publishing one index per segment, two seconds unless `segmentMs` says otherwise, from true
 * time zero, each readable `lagMs` after its segment ends.
 */
export function steadyFeed(
  time: VirtualTime,
  options: { firstIndex?: number; lagMs: number; roundTripMs: number; stopsAfter?: number; segmentMs?: number },
): TimedFeed {
  const firstIndex = options.firstIndex ?? 0;
  const stopsAfter = options.stopsAfter ?? Infinity;
  const segmentMs = options.segmentMs ?? 2_000;
  const segmentEndMs = (index: number) => (index - firstIndex) * segmentMs;
  return new TimedFeed(time, {
    segmentEndMs,
    segmentMs,
    readableAtMs: (index) => (index > stopsAfter ? Infinity : segmentEndMs(index) + options.lagMs),
    roundTripMs: options.roundTripMs,
  });
}
