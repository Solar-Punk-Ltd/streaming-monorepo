import { Topic } from '@ethersphere/bee-js';

import type { FollowClock, HeadMarkers } from './following/feedReader';
import { PeriodMarkers } from './following/headMarkers';
import { LadderMarkerReads } from './ladderMarkerReads';
import type { FeedRung } from './newestIndexFinder';
import type { PlayerReader } from './playerReads';

/**
 * The time markers of a rung's ladder, for its follower to wait on while the rung is quiet, or null for
 * a rung of no known ladder. See `packages/shared/src/ladderMarker.ts` for what a marker holds.
 *
 * @param clockOffsetMs What to add to the viewer's clock to read the gateway's. See `GatewayClock`.
 * @param reads Shared with the player's other marker readers, so an address is asked once between them.
 */
export function rungHeadMarkers(
  reader: PlayerReader,
  rung: FeedRung,
  clock: FollowClock,
  clockOffsetMs: () => number,
  reads: LadderMarkerReads = new LadderMarkerReads(reader),
): HeadMarkers | null {
  if (!rung.group) {
    return null;
  }
  const group = new Topic(rung.group);
  const topicHex = rung.topic.toHex();
  return new PeriodMarkers(clock, clockOffsetMs, async (period) => {
    const marker = await reads.read(rung.owner, group, period);
    return marker?.rungs[topicHex] ?? null;
  });
}
