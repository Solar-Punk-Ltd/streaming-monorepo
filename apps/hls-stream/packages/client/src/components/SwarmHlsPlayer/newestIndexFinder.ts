import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { extractFeedIndex, nextFeedRequest } from '@swarm-hls-stream/shared';

import { TimedResponse } from '@/utils/fetchWithTimeout';

import { isSlotNotWrittenYet } from './refusedSlot';

/** One rung's feed, as the finder is asked about it. */
export interface FeedRung {
  readonly owner: string;
  readonly topic: Topic;
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
 * ⛔ **The hint is the playing rung's current index, and nothing may rely on it being right.** A
 * rung's index counts the playlists the uploader published to it, and publishes coalesce under load,
 * so the rungs of one ladder drift apart without bound. A search may start from the hint. It may
 * never read the hint as the answer.
 *
 * @returns Null when the feed holds nothing yet. A read the gateway did not answer throws.
 */
export interface NewestIndexFinder {
  findNewest(rung: FeedRung, hint: FeedIndex | null): Promise<NewestIndex | null>;
}

/**
 * The feed head lookup, which is what every rung started with before there was a choice. It ignores
 * the hint.
 */
export class HeadLookupFinder implements NewestIndexFinder {
  constructor(private readonly fetchResource: (path: string) => Promise<TimedResponse>) {}

  async findNewest(rung: FeedRung): Promise<NewestIndex | null> {
    let response: TimedResponse;
    try {
      response = await this.fetchResource(nextFeedRequest(rung.owner, rung.topic, null).path);
    } catch (error) {
      if (isSlotNotWrittenYet(error)) {
        return null;
      }
      throw error;
    }
    return { index: extractFeedIndex(response.headers), playlist: response.text };
  }
}
