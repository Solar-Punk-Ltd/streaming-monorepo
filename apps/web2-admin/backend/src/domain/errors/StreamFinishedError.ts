/**
 * A Finish on a stream that is already finished: its key was changed for good, by an earlier Finish or by the restart
 * window running out. Nothing is changed a second time.
 */
export class StreamFinishedError extends Error {
  constructor(public readonly streamId: string) {
    super('This stream is already finished: its key has changed.');
    this.name = 'StreamFinishedError';
  }
}
