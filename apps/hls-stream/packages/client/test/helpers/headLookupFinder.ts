import type { NewestIndexFinder } from '../../src/components/SwarmHlsPlayer/newestIndexFinder.js';
import { headIndexOf, type PlayerReader, servedText } from '../../src/components/SwarmHlsPlayer/playerReads.js';
import { isSlotNotWrittenYet } from '../../src/components/SwarmHlsPlayer/refusedSlot.js';

/**
 * A finder that asks the feed head lookup, for a fake gateway that serves a head rather than a run of
 * slots. The player searches by index. This is only for cases about what the walk does once a rung is
 * found.
 */
export function headLookupFinder(reader: PlayerReader): NewestIndexFinder {
  return {
    async findNewest(rung) {
      try {
        const served = await servedText(reader.readFeedHead(rung.owner, rung.topic), 'the feed head');
        return { index: headIndexOf(served), playlist: served.text };
      } catch (error) {
        if (isSlotNotWrittenYet(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}
