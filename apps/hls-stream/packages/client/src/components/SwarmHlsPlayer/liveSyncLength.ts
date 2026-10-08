import type Hls from 'hls.js';
import { Events, type LevelUpdatedData } from 'hls.js';

import { liveLatencyFor } from './playerConfig';
import { medianSegmentMs } from './rungFeedReader';

/**
 * Keeps the live target three segments behind the live edge as each playlist names its segment
 * length, never under the floor `liveLatencyFor` keeps.
 *
 * The target is set once the player is built, before any playlist names a length, so it starts at the
 * floor and moves here. hls.js offers `targetLatency` for a running player and reads
 * `config.liveMaxLatencyDuration` live, so the limit is raised with it, before the target, and the two
 * stay ordered as hls.js requires.
 */
export function attachLiveSyncToSegmentLength(hls: Hls): () => void {
  // Compared against what this last set rather than against the config, so a target moved from
  // outside, as a measurement harness does through `hls.targetLatency`, stands until the length moves.
  let applied = liveLatencyFor(null).liveSyncDuration;
  const onLevelUpdated = (_event: Events.LEVEL_UPDATED, data: LevelUpdatedData) => {
    const latency = liveLatencyFor(medianSegmentMs(data.details.fragments.map((fragment) => fragment.duration)));
    if (latency.liveSyncDuration === applied) {
      return;
    }
    applied = latency.liveSyncDuration;
    hls.config.liveMaxLatencyDuration = latency.liveMaxLatencyDuration;
    hls.targetLatency = latency.liveSyncDuration;
  };
  hls.on(Events.LEVEL_UPDATED, onLevelUpdated);
  return () => {
    hls.off(Events.LEVEL_UPDATED, onLevelUpdated);
  };
}
