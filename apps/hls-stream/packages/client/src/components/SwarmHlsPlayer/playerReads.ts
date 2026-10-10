import { FeedIndex } from '@ethersphere/bee-js';

import { FetchTimeoutError } from '@/utils/fetchTimeoutError';
import { contentText, type SwarmAnswer } from '@/swarm/answers';
import type { SwarmReader } from '@/swarm/client';

import { ManifestFetchError, SLOT_NOT_WRITTEN_YET } from './refusedSlot';

/** The reads the player makes: a feed's head, a feed entry by index, and a ladder's time marker. */
export type PlayerReader = Pick<SwarmReader, 'readFeedHead' | 'readFeedEntry' | 'readSoc'>;

/** What the player was served: a playlist or a marker as text, and the index a head lookup resolved to. */
export interface ServedText {
  readonly text: string;
  /** Null for every read but a feed head, and for a head whose node did not say. */
  readonly feedIndex: number | null;
}

/** The status a rate limit is reported under, so it reads as the gateway failing like any other refusal. */
const TOO_MANY_REQUESTS = 429;

/**
 * What the player's followers were built to read: the text of what was served, or the failure they
 * already tell apart. Not found is a {@link ManifestFetchError} with 404, the slot not written yet. A
 * refusing status is a {@link ManifestFetchError} with that status, a rate limit one with 429 and the
 * wait it asked for, a window that ran out a {@link FetchTimeoutError}, and no answer at all the error
 * the request failed with. Every one but 404 is the gateway failing to the code that catches it.
 *
 * @param what Names the read in an error, such as a path, since an answer carries no address.
 */
export async function servedText(read: Promise<SwarmAnswer>, what: string): Promise<ServedText> {
  const answer = await read;
  switch (answer.kind) {
    case 'content':
      return { text: contentText(answer), feedIndex: answer.feedIndex };
    case 'not-found':
      throw new ManifestFetchError(what, SLOT_NOT_WRITTEN_YET);
    case 'rate-limited':
      throw new ManifestFetchError(what, TOO_MANY_REQUESTS, answer.retryAfterMs ?? 0);
    case 'unavailable': {
      const { cause } = answer;
      if (cause.kind === 'status') {
        throw new ManifestFetchError(what, cause.status);
      }
      if (cause.kind === 'timeout') {
        throw new FetchTimeoutError(what, cause.timeoutMs);
      }
      throw cause.error;
    }
    case 'unsupported':
      throw new Error(`No provider can read ${what}`);
    case 'aborted':
      throw new Error(`The read of ${what} was cancelled`);
  }
}

/**
 * The index a head lookup resolved to, which is where a sequential walk has to start. Throws without
 * one, because a walk still choosing its starting slot has nothing better to start from.
 */
export function headIndexOf(served: ServedText): FeedIndex {
  if (served.feedIndex === null) {
    throw new Error('Feed head lookup returned no swarm-feed-index header');
  }
  return FeedIndex.fromBigInt(BigInt(served.feedIndex));
}

/** The wait a failed read asked for before the next, which only a rate limit names. Zero otherwise. */
export function retryAfterMsOf(error: unknown): number {
  return error instanceof ManifestFetchError ? error.retryAfterMs : 0;
}
