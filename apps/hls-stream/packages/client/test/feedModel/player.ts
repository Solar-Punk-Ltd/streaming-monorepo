/** When the follower delivered a slot, in true time, and the newest segment end it carried. */
export interface Delivery {
  readonly atMs: number;
  readonly newestSegmentEndMs: number;
}

export interface PlayerOutcome {
  readonly stalls: number;
  readonly stalledMs: number;
}

/** How far behind the newest known segment the player starts, as hls.js's live sync does here. */
export const PLAYER_BEHIND_MS = 6_000;
/** How much has to be buffered again before a stalled player resumes. */
const RESUME_BUFFER_MS = 2_000;

/**
 * A player that starts `PLAYER_BEHIND_MS` behind the newest segment it knows of and then plays in real
 * time. It stalls when it reaches the end of what the follower has delivered, and resumes once a
 * segment's worth is there again. Fetching the segments themselves is left out, so every stall here is
 * the follower's: new data that arrived too late.
 */
export function playBehind(
  startMs: number,
  startSegmentEndMs: number,
  deliveries: readonly Delivery[],
  untilMs: number,
): PlayerOutcome {
  let nowMs = startMs;
  let playheadMs = startSegmentEndMs - PLAYER_BEHIND_MS;
  let edgeMs = startSegmentEndMs;
  let stalledSinceMs: number | null = null;
  let stalls = 0;
  let stalledMs = 0;

  const advanceTo = (atMs: number) => {
    if (stalledSinceMs === null) {
      const runOutMs = nowMs + (edgeMs - playheadMs);
      if (runOutMs < atMs) {
        playheadMs = edgeMs;
        stalledSinceMs = runOutMs;
        stalls += 1;
      } else {
        playheadMs += atMs - nowMs;
      }
    }
    nowMs = atMs;
  };

  for (const delivery of deliveries) {
    if (delivery.atMs > untilMs) {
      break;
    }
    advanceTo(delivery.atMs);
    edgeMs = Math.max(edgeMs, delivery.newestSegmentEndMs);
    if (stalledSinceMs !== null && edgeMs - playheadMs >= RESUME_BUFFER_MS) {
      stalledMs += nowMs - stalledSinceMs;
      stalledSinceMs = null;
    }
  }
  advanceTo(untilMs);
  if (stalledSinceMs !== null) {
    stalledMs += untilMs - stalledSinceMs;
  }
  return { stalls, stalledMs };
}
