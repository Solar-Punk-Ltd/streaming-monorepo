import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

import type { StreamRow } from '../types/index.js';

/** The two states the uploader can report; the rest are this backend's own. */
export type ReportedState = 'live' | 'vod';

/**
 * Where a reported state may be applied from.
 *
 * Reports are fire-and-forget: the uploader retries a failed one and never
 * stops the stream over it, so the same report can arrive twice and must be a
 * no-op the second time. Hence `live → live` and `vod → vod`.
 *
 * `published → vod` is not a mistake either. A broadcast that ends before its
 * `live` report ever got through (the admin API was restarting, the retries
 * ran out) still has a recording worth publishing, and refusing the `vod`
 * would leave the catalogue advertising a stream that is scheduled forever.
 *
 * `vod → live` is a broadcast going live again after it ended. Every feed of a
 * declared stream outlives the sessions written to it — the master on the
 * declared topic, each rung on a topic derived from that topic and the rung
 * name — so an encoder that reconnects continues those same feeds above the
 * previous head, with a discontinuity at the seam. Each new recording opens
 * with the one already at that feed's head, so the recording this row points at
 * carries every session of the broadcast with its seams marked, and the `live`
 * clears what the finished recording left on the row and on the ladder while
 * the next `vod` says where this one ended.
 *
 * What is refused: `draft` (never announced — the uploader is not even
 * supposed to resolve it) and `publishing` (a feed write is in flight; the
 * report would race it).
 */
const ALLOWED_FROM: Record<ReportedState, readonly StreamStatus[]> = {
  live: ['published', 'live', 'vod'],
  vod: ['published', 'live', 'vod'],
};

export function allowedFromFor(state: ReportedState): readonly StreamStatus[] {
  return ALLOWED_FROM[state];
}

export function isStateTransitionAllowed(
  from: StreamStatus,
  to: ReportedState,
): boolean {
  return ALLOWED_FROM[to].includes(from);
}

/** The statuses in which an encoder has already been told where to push. */
export function hasGoneLive(status: StreamStatus): boolean {
  return status === 'live' || status === 'vod';
}

/**
 * Whether an edit would move the scheduled start of a stream that is already
 * running or already recorded. The time is a promise made to viewers on the
 * catalogue entry, and a stream that has started has kept or broken it
 * already; changing it afterwards only rewrites history.
 *
 * An edit that leaves the value alone is not a change — the console PUTs the
 * whole StreamInput back on every save, schedule included.
 *
 * A row with no stored time predates the rule that every stream has one. Such
 * a stream cannot be edited at all while its schedule is locked, because the
 * console will not submit an empty one; giving it a time for the first time
 * is filling a gap, not rewriting a promise, so it is allowed.
 */
export function isScheduleLocked(
  stream: StreamRow,
  scheduledStartTime: string | null,
): boolean {
  if (!hasGoneLive(stream.status)) return false;
  if (stream.scheduled_start_time === null) return false;
  return !sameInstant(stream.scheduled_start_time, scheduledStartTime);
}

function sameInstant(stored: Date | null, incoming: string | null): boolean {
  if (stored === null || incoming === null) return stored === null && incoming === null;
  const parsed = Date.parse(incoming);
  return !Number.isNaN(parsed) && parsed === stored.getTime();
}
