import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

/**
 * The stream is in a status that cannot take the report at all — `409
 * invalid_state`. A rendition report needs a stream that has been announced:
 * `draft` has told nobody anything, and `publishing` has a catalogue write in
 * flight that the report's own write would race.
 *
 * Distinct from InvalidStateTransitionError, which is about a *state report*
 * moving the stream somewhere it cannot go. A rendition report never moves the
 * status, so there is no transition to refuse — only a stream that is not
 * ready to have a ladder written onto its entry.
 */
export class InvalidStateError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly currentStatus: StreamStatus,
  ) {
    super(`Stream ${streamId} is in status ${currentStatus}`);
    this.name = 'InvalidStateError';
  }
}
