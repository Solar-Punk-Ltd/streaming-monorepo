import { programDateTimeMs, type Segment } from '@swarm-hls-stream/shared';

import { isKnownSegmentMs, LIVE_SYNC_DURATION_S, LIVE_SYNC_SEGMENTS } from './playerConfig';

/** The least time a rung has to show a new index, the live target's own floor. */
const RUNG_PROGRESS_FLOOR_MS = LIVE_SYNC_DURATION_S * 1000;

/**
 * How long a rung cutting segments of `segmentMs` has to show a new index before it is called not
 * live: the same three segments and the same six second floor as the live target, so a stage cutting
 * very short segments keeps the six seconds the player has always given a rung. A length not known
 * yet answers the floor.
 *
 * ⛔ **Liveness is a rung's own progress, never a comparison with another rung.** A rung's feed index
 * counts the playlists the uploader published to it, publishes coalesce under load, and late starts,
 * failed uploads and resumed feeds move each rung on its own. So the rungs of one ladder drift apart
 * without bound, and no index or stamp of one says where another should be.
 */
export function rungProgressBoundMs(segmentMs: number | null | undefined): number {
  if (!isKnownSegmentMs(segmentMs)) {
    return RUNG_PROGRESS_FLOOR_MS;
  }
  return Math.max(RUNG_PROGRESS_FLOOR_MS, LIVE_SYNC_SEGMENTS * segmentMs);
}

/**
 * How far a rung's newest segment may sit behind the playing rung's, by PROGRAM-DATE-TIME, before a
 * switch to it is refused at once.
 *
 * Stamps come from one anchor the whole ladder shares, but a rung that started late or held back its
 * opening segments carries stamps up to about ten seconds off its siblings' (read from the uploader's
 * code, not measured). Thirty seconds is three times that, so only a rung that has clearly stopped is
 * refused here. Anything closer is let through, and if it then shows no new index the playing-rung rule
 * deals with it.
 */
export const STALE_RUNG_LAG_MS = 30_000;

/** When a segment was presented, or null when the playlist did not stamp it. */
function startMsOf(segment: Segment | undefined): number | null {
  return segment?.programDateTime ? programDateTimeMs(segment.programDateTime) : null;
}

/** When the oldest segment of a playlist was presented, or null when it carries no stamp. */
export function firstSegmentStartMs(segments: readonly Segment[]): number | null {
  return startMsOf(segments[0]);
}

/** When the newest segment of a playlist was presented, or null when it carries no stamp. */
function newestSegmentStartMs(segments: readonly Segment[]): number | null {
  return startMsOf(segments[segments.length - 1]);
}

/** What a switch target and the playing rung are compared on. */
interface RungSnapshot {
  readonly segments: readonly Segment[];
  readonly isFinalized: boolean;
}

/**
 * Why a switch to `target` should be refused at once, or null when it may go ahead.
 *
 * Only a rung that has clearly stopped is refused: one whose newest playlist is finished while the
 * playing rung is live, or whose newest segment is more than {@link STALE_RUNG_LAG_MS} behind.
 */
export function switchRefusal(target: RungSnapshot, playing: RungSnapshot): string | null {
  if (target.isFinalized && !playing.isFinalized) {
    return 'its newest playlist is finished while the playing quality is live';
  }
  const targetNewest = newestSegmentStartMs(target.segments);
  const playingNewest = newestSegmentStartMs(playing.segments);
  if (targetNewest === null || playingNewest === null) {
    return null;
  }
  const behindMs = playingNewest - targetNewest;
  if (behindMs > STALE_RUNG_LAG_MS) {
    return `its newest segment is ${Math.round(behindMs / 1000)}s behind the playing quality's`;
  }
  return null;
}

/**
 * Whether an older playlist joins onto a newer one without a hole, which is a segment the two share.
 * Windows of one rung step forward together, so a shared segment means everything between is held.
 */
export function joinsOnto(older: readonly Segment[], newer: readonly Segment[]): boolean {
  const newerUris = new Set(newer.map((segment) => segment.uri));
  return older.some((segment) => newerUris.has(segment.uri));
}
