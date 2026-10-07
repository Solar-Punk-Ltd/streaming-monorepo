import { extractFeedIndex, nextFeedRequest } from '@swarm-hls-stream/shared';

import type { NewestIndexFinder } from '../../src/components/SwarmHlsPlayer/newestIndexFinder.js';
import { isSlotNotWrittenYet } from '../../src/components/SwarmHlsPlayer/refusedSlot.js';
import { TimedResponse } from '../../src/utils/fetchWithTimeout.js';

/**
 * A finder that asks the feed head lookup, for a fake gateway that serves a head rather than a run of
 * slots. The player searches by index. This is only for cases about what the walk does once a rung is
 * found.
 */
export function headLookupFinder(fetchResource: (path: string) => Promise<TimedResponse>): NewestIndexFinder {
  return {
    async findNewest(rung) {
      let response: TimedResponse;
      try {
        response = await fetchResource(nextFeedRequest(rung.owner, rung.topic, null).path);
      } catch (error) {
        if (isSlotNotWrittenYet(error)) {
          return null;
        }
        throw error;
      }
      return { index: extractFeedIndex(response.headers), playlist: response.text };
    },
  };
}
