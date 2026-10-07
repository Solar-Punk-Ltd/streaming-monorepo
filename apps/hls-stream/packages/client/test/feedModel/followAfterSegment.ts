import { FeedEntry, FollowContext, SEGMENT_MS } from '../../src/components/SwarmHlsPlayer/following/feedReader';
import {
  pollsTriggerFires,
  probeAhead,
  RefusedSlotTrigger,
} from '../../src/components/SwarmHlsPlayer/following/probeAhead';
import { PROBE_DISTANCES } from '../../src/components/SwarmHlsPlayer/refusedSlot';

import { TODAY_TRIGGER } from './followImmediately';

interface FollowAfterSegmentOptions {
  /**
   * How long after the ask that found a slot before the next one is asked for. A little under a
   * segment, so that a follower which has fallen behind the publisher drifts back to it by itself.
   */
  readonly waitMs: number;
  /** How often a slot that was not there yet is asked again. */
  readonly retryMs: number;
  readonly trigger: RefusedSlotTrigger;
}

const AFTER_SEGMENT_DEFAULTS: FollowAfterSegmentOptions = {
  waitMs: SEGMENT_MS - 200,
  retryMs: 500,
  trigger: TODAY_TRIGGER,
};

/**
 * Wait about one segment after each new slot, then ask, then retry on a short interval.
 *
 * The simplest way to stop asking for a slot the publisher cannot have written yet: the next playlist
 * follows the next segment, and the next segment is a segment away.
 */
export async function followAfterSegment(
  context: FollowContext,
  options: FollowAfterSegmentOptions = AFTER_SEGMENT_DEFAULTS,
): Promise<void> {
  const { reader, clock, onEntry, isStopped } = context;
  let current: FeedEntry = context.from;
  let foundAskMs = clock.now();

  while (!isStopped()) {
    const waitMs = foundAskMs + options.waitMs - clock.now();
    if (waitMs > 0) {
      await clock.sleep(waitMs);
    }
    let unservedPolls = 0;
    while (!isStopped()) {
      const next = current.index + 1;
      const askedMs = clock.now();
      const read = await reader.read(next);
      if (isStopped()) {
        return;
      }
      if (read.found) {
        current = read.entry;
        foundAskMs = askedMs;
        break;
      }
      unservedPolls += 1;
      if (pollsTriggerFires(options.trigger, unservedPolls)) {
        const behind = await probeAhead(reader, next, PROBE_DISTANCES);
        if (behind !== null) {
          current = behind;
          foundAskMs = clock.now();
          break;
        }
      }
      await clock.sleep(options.retryMs);
    }
    if (isStopped()) {
      return;
    }
    onEntry(current);
  }
}
