/**
 * A Finalize on a stream that is already finalized: its key was changed for good, by an earlier Finalize or by the
 * restart window running out. Nothing is changed a second time.
 */
export class StreamFinishedError extends Error {
  constructor(public readonly streamId: string) {
    super('This stream is already finalized: its key has changed.');
    this.name = 'StreamFinishedError';
  }
}
