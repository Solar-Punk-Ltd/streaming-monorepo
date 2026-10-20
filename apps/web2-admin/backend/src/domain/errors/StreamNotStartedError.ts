/**
 * A Finalize on a stream that has not ended: a draft, published or publishing stream has no recording to finalize. A
 * draft that holds a recording did go live once, but it is no longer ended: it was unpublished. A live stream is
 * refused with its own error, `StreamLiveError`. The page shows no Finalize button there; this is the answer to a
 * request that raced a change of status.
 */
export class StreamNotStartedError extends Error {
  constructor(public readonly streamId: string) {
    super('Only an ended stream can be finalized.');
    this.name = 'StreamNotStartedError';
  }
}
