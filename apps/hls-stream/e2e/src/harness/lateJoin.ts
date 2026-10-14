/**
 * Where a late joiner's player started, judged against the live window it was handed.
 *
 * A live playlist is a window of about 4096 bytes, 30 to 50 entries, so a player that started at the window's first
 * entry sits that many segments behind live, and one that started where the client aims sits a few seconds behind.
 * The bound between them is the client's own catch-up limit: hls.js is told to stay within it of the live edge, so a
 * correct start can sit anywhere up to it, and a start at the window's head is far beyond it.
 *
 * ⛔ Position, not latency. The bound comes from the client's configuration and the window from the playlist read at
 * the join, never from a measured figure, so this answers "did it start at the live edge" and promises no number.
 *
 * The three client numbers are mirrored from `packages/client/src/components/SwarmHlsPlayer/playerConfig.ts`, which
 * this package cannot import, and `test/lateJoin.test.ts` reads them back out of that file.
 */

/** The floor of how far behind live the client aims, in seconds. Mirrors `LIVE_SYNC_DURATION_S`. */
export const CLIENT_LIVE_SYNC_FLOOR_S = 6;
/** Segments behind live the client aims at. Mirrors `LIVE_SYNC_SEGMENTS`. */
export const CLIENT_LIVE_SYNC_SEGMENTS = 3;
/** How many times its aim the client lets the player fall behind before catching up. Mirrors `CATCH_UP_LIMIT_FACTOR`. */
export const CLIENT_CATCH_UP_LIMIT_FACTOR = 2;

/** The furthest behind live the client lets a player sit, for a stage cutting segments of this length. */
export function clientCatchUpLimitS(fragmentSeconds: number): number {
  return CLIENT_CATCH_UP_LIMIT_FACTOR * Math.max(CLIENT_LIVE_SYNC_FLOOR_S, CLIENT_LIVE_SYNC_SEGMENTS * fragmentSeconds);
}

/** What the join is judged on: where the player started, and the window it was handed. */
export interface LateJoinReading {
  /** Seconds behind live the player sat as it joined, or null where the arm read none. */
  joinS: number | null;
  /** Seconds of media the rung's live window named at the join: its entries times the segment length. */
  windowSeconds: number;
  fragmentSeconds: number;
}

/**
 * Why the player did not start at the live edge, or null.
 *
 * ⛔ A window no longer than the catch-up limit plus a segment refuses as an instrument that cannot tell, rather than
 * passing: a start at its head and a start at the edge would read the same.
 */
export function lateJoinRefusal({ joinS, windowSeconds, fragmentSeconds }: LateJoinReading): string | null {
  const limit = clientCatchUpLimitS(fragmentSeconds);
  if (windowSeconds <= limit + fragmentSeconds) {
    return (
      `the live window held ${windowSeconds.toFixed(1)}s, no more than the client's ${limit}s catch-up limit and a ` +
      'segment, so a start at its head cannot be told from a start at the live edge and nothing was judged'
    );
  }
  if (joinS === null) {
    return 'the arm read no position at the join, so where the player started is unknown';
  }
  if (joinS > limit) {
    return (
      `the player started ${joinS.toFixed(1)}s behind live, past the client's ${limit}s catch-up limit, in a live ` +
      `window of ${windowSeconds.toFixed(1)}s. It began inside the window rather than at its live edge`
    );
  }
  return null;
}
