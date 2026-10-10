import type { FeedEntry, FollowContext } from '../../src/components/SwarmHlsPlayer/following/feedReader';
import {
  pollsTriggerFires,
  probeAhead,
  RefusedSlotTrigger,
} from '../../src/components/SwarmHlsPlayer/following/probeAhead';
import { PROBE_DISTANCES } from '../../src/components/SwarmHlsPlayer/refusedSlot';

/** The walk's trigger before the predicted follower: after three unserved polls, and not past thirty. */
export const TODAY_TRIGGER: RefusedSlotTrigger = { kind: 'polls', polls: 3, ceiling: 30 };

interface FollowImmediatelyOptions {
  readonly pollIntervalMs: number;
  readonly trigger: RefusedSlotTrigger;
}

/**
 * The walk `LadderFeedPoller` ran before the predicted follower, kept here as the baseline every other
 * strategy is measured against.
 *
 * A pass reads the next slot, and after a found slot reads the one after at once. A pass that found
 * anything is followed by another pass straight away, so the first miss after a find is asked again
 * at once, and only an empty pass waits the poll interval. Phase 0 shows exactly that shape: half the
 * asks after a miss started within a millisecond of it, the rest about 750 ms after.
 */
export async function followImmediately(
  context: FollowContext,
  options: FollowImmediatelyOptions = { pollIntervalMs: 750, trigger: TODAY_TRIGGER },
): Promise<void> {
  const { reader, clock, onEntry, isStopped } = context;
  let current: FeedEntry = context.from;
  let unservedPolls = 0;

  const deliver = (entry: FeedEntry) => {
    current = entry;
    unservedPolls = 0;
    onEntry(entry);
  };

  while (!isStopped()) {
    let advanced = 0;
    while (!isStopped()) {
      const next = current.index + 1;
      const read = await reader.read(next);
      if (isStopped()) {
        return;
      }
      if (read.found) {
        deliver(read.entry);
        advanced += 1;
        continue;
      }
      unservedPolls += 1;
      if (!pollsTriggerFires(options.trigger, unservedPolls)) {
        break;
      }
      const behind = await probeAhead(reader, next, PROBE_DISTANCES);
      if (isStopped() || behind === null) {
        break;
      }
      deliver(behind);
      advanced += 1;
    }
    if (advanced === 0 && !isStopped()) {
      await clock.sleep(options.pollIntervalMs);
    }
  }
}
