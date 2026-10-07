import { FeedIndex, Topic } from '@ethersphere/bee-js';

import { TimedResponse } from '@/utils/fetchWithTimeout';

import type { FollowClock } from './following/feedReader';
import { findNewestFromHint, type SwitchHint } from './following/findNewestFromHint';
import { findNewestFromScratch } from './following/findNewestFromScratch';
import { RungFeedReader } from './rungFeedReader';

export type { SwitchHint };

/** One rung's feed, as the finder is asked about it. */
export interface FeedRung {
  readonly owner: string;
  readonly topic: Topic;
  /**
   * The ladder's master feed topic in hex, which is where its time markers are found, or null for a
   * rung of no known ladder. The rung's owner is the ladder's signer, who writes the markers too.
   */
  readonly group?: string | null;
}

/** A rung's newest index and the playlist published at it. */
export interface NewestIndex {
  readonly index: FeedIndex;
  readonly playlist: string;
}

/**
 * Finds the newest index of a rung the player is about to follow.
 *
 * The only place a rung's walk may skip indexes. Everything after it is walked slot by slot.
 *
 * ⛔ **The hint is the playing rung's newest slot, and nothing may rely on it being right.** A rung's
 * index counts the playlists the uploader published to it, and publishes coalesce under load, so the
 * rungs of one ladder drift apart without bound. A search may start from the hint. It may never read
 * the hint as the answer.
 *
 * Injected, so the owner's decision 34 can move to Bee's own lookup at the start (option b) or to a
 * latest index the stream list carries (option c) without touching the walk.
 *
 * @returns Null when the feed holds nothing yet. A read the gateway did not answer throws.
 */
export interface NewestIndexFinder {
  findNewest(rung: FeedRung, hint: SwitchHint | null): Promise<NewestIndex | null>;
}

/**
 * The searches by index from the polling study (decision 34, option a): from nothing at the start,
 * and from the playing rung's newest slot at a switch, a failover and the check of an end. Neither
 * reads the feed head lookup, which measured the slowest request this deployment has.
 */
export class IndexSearchFinder implements NewestIndexFinder {
  constructor(
    private readonly fetchResource: (path: string) => Promise<TimedResponse>,
    private readonly clock: FollowClock,
  ) {}

  async findNewest(rung: FeedRung, hint: SwitchHint | null): Promise<NewestIndex | null> {
    const reader = new RungFeedReader(this.fetchResource, rung.owner, rung.topic, this.clock.now);
    const { newest } =
      hint === null
        ? await findNewestFromScratch(reader, this.clock)
        : await findNewestFromHint(reader, this.clock, hint);
    const playlist = newest === null ? undefined : reader.playlistOf(newest);
    if (newest === null || playlist === undefined) {
      return null;
    }
    return { index: FeedIndex.fromBigInt(BigInt(newest.index)), playlist };
  }
}
