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
 * What is refused: `draft` (never announced — the uploader is not even
 * supposed to resolve it), `publishing` (a feed write is in flight; the report
 * would race it), and `vod → live` (a finished recording does not resume; the
 * next broadcast is a new publish).
 */
const ALLOWED_FROM: Record<ReportedState, readonly StreamStatus[]> = {
  live: ['published', 'live'],
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
 */
export function isScheduleLocked(
  stream: StreamRow,
  scheduledStartTime: string | null,
): boolean {
  if (!hasGoneLive(stream.status)) return false;
  return !sameInstant(stream.scheduled_start_time, scheduledStartTime);
}

function sameInstant(stored: Date | null, incoming: string | null): boolean {
  if (stored === null || incoming === null) return stored === null && incoming === null;
  const parsed = Date.parse(incoming);
  return !Number.isNaN(parsed) && parsed === stored.getTime();
}
