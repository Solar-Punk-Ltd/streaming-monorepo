import type { FeedEntry, FeedRead, FeedReader } from '../../src/components/SwarmHlsPlayer/following/feedReader';

import type { NodeProfile } from './profiles';
import type { QualityFeed } from './publisher';
import type { Random } from './random';
import type { VirtualTime } from './virtualTime';

/** The longest round trip phase 0 saw for a playlist read, tails at start included. */
const MAX_ROUND_TRIP_MS = 8_000;

/** How long Bee keeps skipping the peers that failed to deliver an address, `pkg/retrieval/retrieval.go:128`. */
export const SKIP_LIST_MS = 60_000;

/**
 * The early-ask penalty. Bee skips a peer that failed to deliver an address for one minute, so an
 * address asked for before it existed often enough is not found for a while after it does. The model:
 * once an address has been asked early `asks` times, it becomes readable only `SKIP_LIST_MS` after its
 * first early ask (`first`), or after its latest one (`latest`, the harsher reading where every failed
 * ask renews the skip). `asks: null` turns the penalty off.
 */
export interface EarlyAskPenalty {
  readonly asks: number | null;
  readonly from: 'first' | 'latest';
}

export const NO_PENALTY: EarlyAskPenalty = { asks: null, from: 'first' };

interface AddressHistory {
  earlyAsks: number;
  firstEarlyMs: number;
  latestEarlyMs: number;
}

/** What one node saw of one feed, for the tables. */
export interface NodeTally {
  reads: number;
  found: number;
  earlyAsks: number;
  /** Reads that missed a slot already published, because it was penalised. */
  penalisedMisses: number;
}

/**
 * One Bee node serving one feed: reads by index with the profile's round trips, the early-ask
 * penalty, and Bee's own feed lookup.
 */
export class SimNode implements FeedReader {
  readonly tally: NodeTally = { reads: 0, found: 0, earlyAsks: 0, penalisedMisses: 0 };
  /** Early asks per address, for "early asks per index". */
  readonly earlyAsksBySlot = new Map<number, number>();
  /** Every read by address, a follower's and a finder's alike. */
  readonly readsBySlot = new Map<number, number>();
  private readonly history = new Map<number, AddressHistory>();

  constructor(
    private readonly time: VirtualTime,
    readonly feed: QualityFeed,
    private readonly profile: NodeProfile,
    private readonly random: Random,
    private readonly penalty: EarlyAskPenalty,
  ) {}

  read(index: number): Promise<FeedRead> {
    this.tally.reads += 1;
    this.readsBySlot.set(index, (this.readsBySlot.get(index) ?? 0) + 1);
    const decideAtMs = this.time.trueNowMs + this.profile.decideAfterMs;
    const found = this.retrievable(index, decideAtMs);
    const spread = found ? this.profile.foundMs : this.profile.missingMs;
    const roundTripMs = Math.min(
      MAX_ROUND_TRIP_MS,
      Math.max(this.profile.decideAfterMs, this.random.logNormal(spread.median, spread.sigma)),
    );
    if (found) {
      this.tally.found += 1;
    }
    return new Promise((resolve) => {
      this.time.at(this.time.trueNowMs + roundTripMs, () =>
        resolve(found ? { found: true, entry: this.feed.entry(index) } : { found: false }),
      );
    });
  }

  /**
   * Whether a retrieval of `index` decided at `atMs` succeeds, recording an early ask if not. Every
   * read and every probe of Bee's own lookup goes through here, since both are retrievals.
   */
  private retrievable(index: number, atMs: number): boolean {
    const readableMs = this.feed.readableAt(index);
    const history = this.history.get(index);
    if (readableMs <= atMs) {
      if (history === undefined || this.penalty.asks === null || history.earlyAsks < this.penalty.asks) {
        return true;
      }
      const sinceMs = this.penalty.from === 'first' ? history.firstEarlyMs : history.latestEarlyMs;
      if (atMs >= sinceMs + SKIP_LIST_MS) {
        return true;
      }
      this.tally.penalisedMisses += 1;
      if (this.penalty.from === 'latest') {
        history.latestEarlyMs = atMs;
      }
      return false;
    }
    if (!Number.isFinite(readableMs)) {
      return false;
    }
    this.tally.earlyAsks += 1;
    this.earlyAsksBySlot.set(index, (this.earlyAsksBySlot.get(index) ?? 0) + 1);
    if (history === undefined) {
      this.history.set(index, { earlyAsks: 1, firstEarlyMs: atMs, latestEarlyMs: atMs });
    } else {
      history.earlyAsks += 1;
      history.latestEarlyMs = atMs;
    }
    return false;
  }

  /**
   * `GET /feeds/{owner}/{topic}` as Bee 2.8.2 answers it, `pkg/feeds/sequence/sequence.go:140-238`.
   *
   * Slot 0 first, then rounds of probes at `base + 2^l - 1` for l from the interval's level down,
   * each with a one second timeout. A chunk that is not there comes back as an empty answer as soon
   * as the retrieval gives up, which the timeout caps at a second. Results are handled in the
   * order they arrive, exactly as the finder's channel loop does, and a round whose top probe hits
   * starts the next one at once. Probes still running when it answers are left to finish, as Bee
   * leaves them, and still count as asks.
   */
  async lookup(): Promise<{ newest: FeedEntry | null; probes: number; rounds: number }> {
    const LEVELS = 8;
    const TIMEOUT_MS = 1_000;
    let probes = 0;
    let rounds = 0;

    const probe = (index: number): Promise<boolean> => {
      probes += 1;
      this.tally.reads += 1;
      const startMs = this.time.trueNowMs;
      const foundMs = this.random.logNormal(
        this.profile.lookupProbeFoundMs.median,
        this.profile.lookupProbeFoundMs.sigma,
      );
      const found = foundMs < TIMEOUT_MS && this.retrievable(index, startMs + foundMs);
      const answeredMs = found
        ? foundMs
        : Math.min(
            TIMEOUT_MS,
            this.random.logNormal(this.profile.lookupProbeMissingMs.median, this.profile.lookupProbeMissingMs.sigma),
          );
      return new Promise((resolve) => this.time.at(startMs + answeredMs, () => resolve(found)));
    };

    if (!(await probe(0))) {
      return { newest: null, probes, rounds };
    }

    interface Result {
      interval: Interval;
      level: number;
      index: number;
      found: boolean;
    }
    interface Found {
      index: number;
      level: number;
    }
    interface Interval {
      base: number;
      level: number;
      notFound: number;
      found: Found;
    }

    const queue: Result[] = [];
    let wake: (() => void) | null = null;
    const launch = (interval: Interval, minLevel: number) => {
      rounds += 1;
      for (let level = interval.level; level > minLevel; level -= 1) {
        const index = interval.base + 2 ** level - 1;
        void probe(index).then((found) => {
          queue.push({ interval, level, index, found });
          wake?.();
        });
      }
    };
    const next = (interval: Interval): Interval => {
      const level = interval.found.level;
      interval.found.level = 0;
      return { base: interval.found.index, level, notFound: level, found: interval.found };
    };

    const first: Interval = { base: 0, level: LEVELS, notFound: LEVELS, found: { index: 0, level: 0 } };
    launch(first, 0);
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      const result = queue.shift()!;
      const interval = result.interval;
      if (!result.found) {
        if (interval.notFound < result.level) {
          continue;
        }
        interval.notFound = result.level - 1;
      } else {
        if (interval.found.level > result.level) {
          continue;
        }
        if (interval.level === result.level && result.level < LEVELS) {
          return { newest: this.feed.entry(result.index), probes, rounds };
        }
        interval.found = { index: result.index, level: result.level };
      }
      if (interval.found.level === interval.notFound) {
        if (interval.found.level === 0) {
          return { newest: this.feed.entry(interval.found.index), probes, rounds };
        }
        launch(next(interval), 0);
      }
      if (interval.notFound < interval.found.level) {
        const retry = next(interval);
        retry.level = interval.level;
        retry.notFound = interval.level;
        launch(retry, interval.found.level);
      }
    }
  }
}
