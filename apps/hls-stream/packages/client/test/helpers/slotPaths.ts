import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath } from '@swarm-hls-stream/shared';

/** A feed slot a path names: the rung's hex topic and the index. */
interface NamedSlot {
  readonly hex: string;
  readonly index: number;
}

/**
 * Every slot path of these feeds up to `count`, so a fake gateway can tell which rung and index a read
 * asks for. A slot's path is a hash that names neither.
 */
export function slotPathsOf(owner: string, topics: readonly Topic[], count = 64): Map<string, NamedSlot> {
  const slots = new Map<string, NamedSlot>();
  for (const topic of topics) {
    for (let index = 0; index < count; index++) {
      slots.set(feedSlotPath(owner, topic, FeedIndex.fromBigInt(BigInt(index))), { hex: topic.toString(), index });
    }
  }
  return slots;
}
