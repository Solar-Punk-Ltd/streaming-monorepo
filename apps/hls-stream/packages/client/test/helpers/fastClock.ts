import { setTimeout as sleep } from 'node:timers/promises';

import type { FollowClock } from '../../src/components/SwarmHlsPlayer/following/feedReader.js';

/**
 * A follow clock that runs `speed` times faster than real time, so a follower that waits for two
 * second segments can be driven by a test on real timers. Its reading starts at zero, which the
 * strategies tolerate because they only ever learn the difference between it and a playlist's stamps.
 */
export function fastClock(speed = 1_000): FollowClock {
  const startedAtMs = performance.now();
  return {
    now: () => (performance.now() - startedAtMs) * speed,
    sleep: (ms) => sleep(ms / speed),
  };
}
