import { Topic } from '@ethersphere/bee-js';

import type { FollowClock } from './following/feedReader';
import { PeriodMarkers } from './following/headMarkers';
import type { LadderMarkerReads } from './ladderMarkerReads';

/**
 * How long after a player starts it keeps reading its ladder's markers for qualities the stream list
 * did not name. The qualities of one broadcast report a moment apart, up to about 20 s when an encoder
 * reconnects, and a report the admin refused is retried after 1, 3 and then 30 s.
 */
export const LADDER_COMPLETION_WATCH_MS = 60_000;

/**
 * The least time between two calls of `onShort`, half a marker period. The marker read at the start
 * and the first period's can land back to back, and the second must not have the page read the list's
 * slot after the one the first read is fetching.
 */
const SHORT_SPACING_MS = 5_000;

interface LadderCompletionWatch {
  reads: LadderMarkerReads;
  clock: FollowClock;
  /** What to add to the viewer's clock to read the gateway's. See `GatewayClock`. */
  clockOffsetMs: () => number;
  owner: string;
  group: Topic;
  /** The rungs the stream list names now, by hex topic, read again after every marker. */
  listedTopics: () => readonly string[];
  /** A marker named a rung the list does not, so the page should read the list's next slot once. */
  onShort: () => void;
  /** The rungs a marker read at the start names, which the start rung's search reads anyway. */
  startNames?: () => Promise<readonly string[] | null>;
  boundMs?: number;
}

/**
 * Reads the ladder's marker of each 10 s period once, about 4 s into it, for a bounded time after the
 * player started, and says so whenever one names a rung the stream list lacks.
 *
 * A viewer who joined the moment a stream turned live holds an entry naming only the qualities that had
 * reported, and at that moment the marker often names no more. A quality reports to the admin before
 * its first segment, so once a marker names it the list's next slot is normally written, and the read
 * that follows is not early. A list still short is read again only after the next marker says so,
 * never on a timer of its own, because an early ask on the list's slot hides it for a minute.
 *
 * @returns Stops the watch. Nothing is asked after it, nor after the bound.
 */
export function watchLadderCompletion(watch: LadderCompletionWatch): () => void {
  const { reads, clock, owner, group, listedTopics, onShort } = watch;
  const deadline = clock.now() + (watch.boundMs ?? LADDER_COMPLETION_WATCH_MS);
  const markers = new PeriodMarkers<readonly string[]>(clock, watch.clockOffsetMs, async (period) => {
    const marker = await reads.read(owner, group, period);
    return marker === null ? null : Object.keys(marker.rungs);
  });
  let stopped = false;
  let lastShortMs = -Infinity;
  const check = (named: readonly string[] | null) => {
    if (stopped || named === null || clock.now() - lastShortMs < SHORT_SPACING_MS) {
      return;
    }
    const listed = new Set(listedTopics());
    if (named.some((hex) => !listed.has(hex))) {
      lastShortMs = clock.now();
      onShort();
    }
  };

  void (async () => {
    if (watch.startNames) {
      try {
        check(await watch.startNames());
      } catch {
        // A start marker that could not be read leaves the periods to answer.
      }
    }
    while (!stopped) {
      const dueMs = markers.nextDueMs();
      if (dueMs > deadline) {
        return;
      }
      await clock.sleep(Math.max(0, dueMs - clock.now()));
      if (stopped) {
        return;
      }
      let named: readonly string[] | null;
      try {
        named = await markers.readNext();
      } catch {
        continue;
      }
      check(named);
    }
  })();

  return () => {
    stopped = true;
  };
}
