/**
 * The admin answered that the stream a report named does not exist, which no retry can change. The
 * rendition report throws it, and a `vod` state report's `STATE_REPORT_STREAM_GONE` becomes it.
 *
 * Told apart from every other refusal because it is the one that is permanent for the broadcast:
 * the stream was deleted on the admin, or was never there. A timeout, a 5xx or a refused connection
 * all heal, and a recovery entry kept through them is how the next boot finishes the recording. A
 * stream the admin has deleted never heals, so an entry kept through this comes back at every boot
 * to be refused again.
 *
 * A class rather than a status the caller string-matches, for the reason `DrainTimeoutError` is one.
 */
export class AdminStreamGoneError extends Error {
  constructor(public readonly adminStreamId: string) {
    super(`The admin has no stream ${adminStreamId}`);
    this.name = 'AdminStreamGoneError';
  }
}
