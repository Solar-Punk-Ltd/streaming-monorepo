/**
 * Something that would take a live stream off the catalogue while an encoder
 * is still pushing to it: an unpublish, or a delete. The viewer would lose the
 * entry it is playing from, and nothing here can stop the broadcast — only the
 * streamer can.
 */
export class StreamLiveError extends Error {
  constructor(public readonly streamId: string) {
    super('Stop the broadcast first.');
    this.name = 'StreamLiveError';
  }
}
