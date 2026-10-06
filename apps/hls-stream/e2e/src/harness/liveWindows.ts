/**
 * The newest live playlist a quality published, read the way a viewer reads it: from the time window
 * chunks the uploader writes every two seconds, through the gateway's `/chunks/` route.
 *
 * A live playlist is no longer the head of a feed. Each window of `LIVE_PLAYLIST_WINDOW_MS` has its
 * own chunk, addressed from the quality's topic, the window number and the owner, so the newest
 * playlist is the newest window that holds one. A window is read only once it has ended
 * `WINDOW_READ_MARGIN_MS` ago, the same margin the player keeps, because the window being written may
 * not have landed yet and a read that comes back empty is not a fact about the writer.
 */

import {
  LIVE_PLAYLIST_WINDOW_MS,
  parseLiveWindowPayload,
  WINDOW_READ_MARGIN_MS,
  windowChunkPath,
  windowOf,
} from '@swarm-hls-stream/shared';

import type { Host, ServiceTarget } from './host.js';

/**
 * How far back a read looks for a window before saying there is none. Longer than a segment and a
 * slow upload together, so a quality between two segment landings still has a window in reach.
 */
export const LIVE_WINDOW_LOOKBACK_MS = 30_000;

/** How long one chunk read is given. */
const CHUNK_READ_TIMEOUT_S = 10;

/** The statuses a gateway answers for a chunk nobody wrote, rather than for a fault. */
const ABSENT_STATUSES: ReadonlySet<number> = new Set([404, 500]);

/** The newest live window of a topic that held a playlist. */
interface LiveWindowRead {
  readonly window: number;
  /** The playlist as the uploader composed it, without the written-at line. */
  readonly playlist: string;
  readonly writtenAt: number;
}

/**
 * The live windows a read at `nowMs` asks for, newest first: every window that ended at least the
 * read margin ago, back across {@link LIVE_WINDOW_LOOKBACK_MS}.
 */
export function liveWindowsToRead(nowMs: number): number[] {
  const newest = windowOf(nowMs - WINDOW_READ_MARGIN_MS, LIVE_PLAYLIST_WINDOW_MS) - 1;
  const count = LIVE_WINDOW_LOOKBACK_MS / LIVE_PLAYLIST_WINDOW_MS;
  return Array.from({ length: count }, (_, back) => newest - back).filter((window) => window >= 0);
}

/**
 * The newest live window of `topic` the gateway holds, or the reason none was read.
 *
 * One window at a time, newest first, and it stops at the first that answers. A window that answers
 * with something that is not a live window payload stops the read too, because that is a fault in
 * the writer a suite must see rather than skip past to an older window.
 */
export async function readNewestLiveWindow(
  host: Host,
  gateway: ServiceTarget,
  owner: string,
  topic: string,
  nowMs: number,
): Promise<LiveWindowRead | { readonly reason: string }> {
  let lastFault: string | null = null;
  for (const window of liveWindowsToRead(nowMs)) {
    const path = `/${windowChunkPath({ topic, kind: 'live', windowMs: LIVE_PLAYLIST_WINDOW_MS, window }, owner)}`;
    const { status, payload } = await host.localChunkPayload(gateway, path, CHUNK_READ_TIMEOUT_S);
    if (payload !== null) {
      const parsed = parseLiveWindowPayload(new TextEncoder().encode(payload));
      if (parsed === null) {
        return { reason: `window ${window} of ${topic} holds a chunk that is not a live window` };
      }
      return { window, playlist: parsed.playlist, writtenAt: parsed.writtenAt };
    }
    if (!ABSENT_STATUSES.has(status)) {
      lastFault = `the gateway answered ${status} for window ${window}`;
    }
  }
  const lookbackS = LIVE_WINDOW_LOOKBACK_MS / 1000;
  return {
    reason: `no live window of ${topic} in the last ${lookbackS} s${lastFault === null ? '' : `, and ${lastFault}`}`,
  };
}
