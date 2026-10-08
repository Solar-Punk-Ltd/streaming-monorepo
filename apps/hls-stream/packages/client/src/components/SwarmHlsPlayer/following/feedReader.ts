/**
 * What following one feed needs from the outside world, and nothing more: a read of one slot by its
 * index and a clock. The strategies in this folder are pure over these two, so the same code runs
 * against a Bee node in the player and against the simulator in `test/feedModel`.
 */

/** How long one segment lasts, which is also how often the publisher starts a new playlist. */
export const SEGMENT_MS = 2_000;

/**
 * The most reads a search keeps open at once. Eight is what Bee's own lookup opens per round, so a
 * search here never asks more of a node at one moment than the lookup it replaces did.
 */
export const MAX_PARALLEL_READS = 8;

/** One slot of a quality feed as a follower needs it. */
export interface FeedEntry {
  readonly index: number;
  /**
   * When the newest segment its playlist names ends, on the publisher's clock: that segment's
   * PROGRAM-DATE-TIME plus its duration. Compared only with other values on the same clock, or as a
   * difference against the viewer's clock that a follower learns rather than trusts.
   */
  readonly newestSegmentEndMs: number;
}

export type FeedRead = { readonly found: true; readonly entry: FeedEntry } | { readonly found: false };

/** A read of one slot by index. A slot not readable yet answers `found: false`, never throws. */
export interface FeedReader {
  read(index: number): Promise<FeedRead>;
}

/** The viewer's own clock, which may be off from the publisher's by any amount. */
export interface FollowClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Where a feed's head stood at fixed moments, written down by its publisher at addresses worked out
 * from the clock. A follower reads these while its feed is quiet, instead of asking again and again for
 * a slot that is not there, which Bee answers by skipping, for a minute, every peer it asked.
 */
export interface HeadMarkers<T = number> {
  /** When the next marker not read yet is worth its one ask, on the follower's clock. */
  nextDueMs(): number;
  /**
   * Reads that marker, and moves on to the one after it. The newest index it names for this feed, or
   * null when it is missing or names none. A read the gateway did not answer throws.
   */
  readNext(): Promise<T | null>;
}

/** Everything a follower is started with. */
export interface FollowContext {
  readonly reader: FeedReader;
  readonly clock: FollowClock;
  /** The newest entry already known, which the follower never asks for again. */
  readonly from: FeedEntry;
  readonly onEntry: (entry: FeedEntry) => void;
  /** Checked before every read and after every wait, so a torn-down follower stops at the next turn. */
  readonly isStopped: () => boolean;
  /** The feed's markers, for a feed whose publisher writes them. Without them a quiet feed is asked on a backoff. */
  readonly markers?: HeadMarkers;
}
