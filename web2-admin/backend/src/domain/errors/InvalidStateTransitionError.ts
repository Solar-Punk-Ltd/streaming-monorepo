import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

import type { ReportedState } from '../streamState.js';

/**
 * The uploader reported a state this stream cannot be in from where it is —
 * `live` for a draft that was never announced, say. Reports are retried, so
 * the idempotent repeats (live→live, vod→vod) are allowed and only a genuinely
 * impossible move lands here.
 */
export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly from: StreamStatus,
    public readonly to: ReportedState,
  ) {
    super(`Stream ${streamId} cannot go from ${from} to ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}
