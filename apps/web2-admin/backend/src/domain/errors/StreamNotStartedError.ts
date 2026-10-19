/**
 * A Finish on a stream that is neither live nor ended: a draft, published or publishing stream has no broadcast to
 * finish. A draft that holds a recording did go live once, but it is no longer ended: it was unpublished. The page
 * shows no Finish button there; this is the answer to a request that raced a change of status.
 */
export class StreamNotStartedError extends Error {
  constructor(public readonly streamId: string) {
    super('Only a live or ended stream can be finished.');
    this.name = 'StreamNotStartedError';
  }
}
