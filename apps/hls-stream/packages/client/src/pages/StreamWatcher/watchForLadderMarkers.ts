import { Topic } from '@ethersphere/bee-js';

import { ladderMarkerIdentifier, parseLadderMarker } from '@swarm-hls-stream/shared';

import { PeriodMarkers } from '@/components/SwarmHlsPlayer/following/headMarkers';
import type { PlayerReader } from '@/components/SwarmHlsPlayer/playerReads';
import { contentText } from '@/swarm/answers';

interface LadderMarkerWatch {
  /** Read when each marker is asked, so a gateway switch while waiting reaches the next ask. */
  readonly reader: () => Pick<PlayerReader, 'readSoc'>;
  /** The entry's owner, who signs the ladder and writes its markers. */
  readonly owner: string;
  /** The entry's topic, the ladder's master feed topic as the stream list names it. */
  readonly topic: string;
  /** What to add to the viewer's clock to read the gateway's. See `GatewayClock`. */
  readonly clockOffsetMs: () => number;
  /** Called for every marker found. The wait goes on to the next period until stopped. */
  readonly onMarker: () => void;
  readonly now?: () => number;
}

/**
 * Waits on an announced stream's ladder markers, which the uploader writes once its broadcast has
 * started, and calls `onMarker` for each one found.
 *
 * ⛔ **Not the stream list's next slot.** A waiting page that asks the list's unwritten slot every few
 * seconds gets every peer of its node skipped for that address, so the slot saying live reaches it up
 * to a minute late. A marker address is computed from the clock and asked once, about four seconds
 * into its period, so no address collects early asks. A read the gateway does not answer is let go
 * like a missing one, and the next period's marker is waited for.
 *
 * @returns Stops the wait.
 */
export function watchForLadderMarkers(watch: LadderMarkerWatch): () => void {
  const now = watch.now ?? (() => Date.now());
  const group = Topic.fromString(watch.topic);
  const markers = new PeriodMarkers<true>(
    { now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    watch.clockOffsetMs,
    async (period) => {
      const identifier = ladderMarkerIdentifier(group, period).toHex();
      const answer = await watch.reader().readSoc(watch.owner, identifier);
      return answer.kind === 'content' && parseLadderMarker(contentText(answer), period) !== null ? true : null;
    },
  );

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleNext = () => {
    timer = setTimeout(
      async () => {
        const found = await markers.readNext().catch(() => null);
        if (stopped) {
          return;
        }
        if (found) {
          watch.onMarker();
        }
        scheduleNext();
      },
      Math.max(0, markers.nextDueMs() - now()),
    );
  };
  scheduleNext();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
