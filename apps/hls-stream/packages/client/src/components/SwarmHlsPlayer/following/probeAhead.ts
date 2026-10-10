import type { FeedEntry, FeedReader } from './feedReader';

/**
 * When a follower looks past the slot it is waiting on.
 *
 * `polls` is the rule from before the polling study: after that many unanswered asks in a row, below
 * a ceiling. The study still compares the player against it. `time` looks once, when the slot is that
 * many segments late past the moment it was expected to appear, so the trigger does not depend on how
 * often the follower happens to ask.
 */
export type RefusedSlotTrigger =
  | { readonly kind: 'polls'; readonly polls: number; readonly ceiling: number }
  | { readonly kind: 'time'; readonly lateSegments: number };

export function pollsTriggerFires(trigger: RefusedSlotTrigger, unservedPolls: number): boolean {
  return trigger.kind === 'polls' && unservedPolls >= trigger.polls && unservedPolls < trigger.ceiling;
}

/**
 * Read past `missing` at each distance in turn and return the first entry that answers. Sequential
 * on purpose: the common case is +1, and stopping there costs one read.
 */
export async function probeAhead(
  reader: FeedReader,
  missing: number,
  distances: readonly number[],
): Promise<FeedEntry | null> {
  for (const distance of distances) {
    const read = await reader.read(missing + distance);
    if (read.found) {
      return read.entry;
    }
  }
  return null;
}
