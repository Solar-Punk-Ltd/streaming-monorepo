/** Refuses a viewer address for a stream that is no test stream: only a test stream holds one. */
export class NotTestStreamError extends Error {
  constructor(public readonly streamId: string) {
    super('Only a test stream takes a viewer address.');
    this.name = 'NotTestStreamError';
  }
}
