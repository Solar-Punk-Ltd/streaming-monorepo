import { useEffect, useRef } from 'react';

import type { SwarmClient } from '@/swarm/client';

import { watchForLadderMarkers } from './watchForLadderMarkers';

/**
 * Reads the stream list once at each ladder marker of an announced stream, which is how a waiting page
 * learns the stream went live without asking the list's next slot on a short timer.
 *
 * ⭐ **One read per marker, never a retry of its own.** The admin writes the live entry when the first
 * quality reports, before that quality's first segment and so before any marker, so the read at the
 * first marker normally finds it. When it does not, the next marker prompts the next read, ten seconds
 * on, which keeps the list's next slot clear of early asks the skip rule would punish. The wait ends
 * when the list no longer holds the entry as announced. See {@link watchForLadderMarkers}.
 *
 * The client and the read are taken through refs, so that new objects on a render do not restart the
 * wait, which would ask the current period's marker a second time.
 *
 * @param isWaiting Whether the stream list holds the entry as announced. The markers are read only then.
 * @param readList One read of the stream list, applied to the list on screen.
 */
export function useListReadAtMarkers(
  swarm: SwarmClient,
  owner: string | undefined,
  topic: string | undefined,
  isWaiting: boolean,
  readList: () => Promise<void>,
): void {
  const swarmRef = useRef(swarm);
  swarmRef.current = swarm;
  const readListRef = useRef(readList);
  readListRef.current = readList;

  useEffect(() => {
    if (!isWaiting || !owner || !topic) {
      return;
    }
    return watchForLadderMarkers({
      reader: () => swarmRef.current.reader('player'),
      owner,
      topic,
      clockOffsetMs: () => swarmRef.current.clockOffsetMs(),
      onMarker: () => void readListRef.current(),
    });
  }, [isWaiting, owner, topic]);
}
