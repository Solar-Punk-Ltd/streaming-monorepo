/**
 * Something refused on a live stream while an encoder is still pushing to it:
 * an unpublish or a delete, which would take it off the catalogue, so the
 * viewer would lose the entry it is playing from, or a Finalize, which would
 * change its key under a broadcast that goes on. Nothing here can stop the
 * broadcast — only the streamer can.
 */
export class StreamLiveError extends Error {
  constructor(public readonly streamId: string) {
    super('Stop the broadcast first.');
    this.name = 'StreamLiveError';
  }
}
