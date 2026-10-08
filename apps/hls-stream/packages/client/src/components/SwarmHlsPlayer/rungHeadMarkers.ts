import { Topic } from '@ethersphere/bee-js';

import { ladderMarkerIdentifier, parseLadderMarker } from '@swarm-hls-stream/shared';

import type { FollowClock, HeadMarkers } from './following/feedReader';
import { PeriodMarkers } from './following/headMarkers';
import type { FeedRung } from './newestIndexFinder';
import { type PlayerReader, servedText } from './playerReads';
import { isSlotNotWrittenYet } from './refusedSlot';

/**
 * The time markers of a rung's ladder, for its follower to wait on while the rung is quiet, or null for
 * a rung of no known ladder. See `packages/shared/src/ladderMarker.ts` for what a marker holds.
 *
 * @param clockOffsetMs What to add to the viewer's clock to read the gateway's. See `GatewayClock`.
 */
export function rungHeadMarkers(
  reader: PlayerReader,
  rung: FeedRung,
  clock: FollowClock,
  clockOffsetMs: () => number,
): HeadMarkers | null {
  if (!rung.group) {
    return null;
  }
  const group = new Topic(rung.group);
  const topicHex = rung.topic.toHex();
  return new PeriodMarkers(clock, clockOffsetMs, async (period) => {
    const identifier = ladderMarkerIdentifier(group, period).toHex();
    let text: string;
    try {
      text = (await servedText(reader.readSoc(rung.owner, identifier), `soc/${rung.owner}/${identifier}`)).text;
    } catch (error) {
      if (isSlotNotWrittenYet(error)) {
        return null;
      }
      throw error;
    }
    return parseLadderMarker(text, period)?.rungs[topicHex] ?? null;
  });
}
