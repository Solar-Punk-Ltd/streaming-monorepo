import { useEffect, useRef, useState } from 'react';

import type { SwarmClient } from '@/swarm/client';

import { watchForLiveMarker } from './watchForLiveMarker';

/**
 * Whether an announced stream's ladder has written its first marker, which says it went live before the
 * stream list can. See {@link watchForLiveMarker}.
 *
 * Remembered per stream, because React Router keeps the page mounted when only the route's parameters
 * change. The client is read through a ref so that a new client object does not restart the wait,
 * which would ask the current period's marker a second time.
 *
 * @param isWaiting Whether the stream list still holds the entry as announced. The markers are read
 *   only then.
 */
export function useIsLiveByMarker(
  swarm: SwarmClient,
  owner: string | undefined,
  topic: string | undefined,
  isWaiting: boolean,
): boolean {
  const streamKey = `${owner}/${topic}`;
  const [liveFor, setLiveFor] = useState<string | null>(null);
  const isLive = liveFor === streamKey;
  const swarmRef = useRef(swarm);
  swarmRef.current = swarm;

  useEffect(() => {
    if (!isWaiting || isLive || !owner || !topic) {
      return;
    }
    return watchForLiveMarker({
      reader: () => swarmRef.current.reader('player'),
      owner,
      topic,
      clockOffsetMs: () => swarmRef.current.clockOffsetMs(),
      onLive: () => setLiveFor(streamKey),
    });
  }, [isWaiting, isLive, owner, topic, streamKey]);

  return isLive;
}
