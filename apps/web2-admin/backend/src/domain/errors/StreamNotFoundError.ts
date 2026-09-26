export class StreamNotFoundError extends Error {
  constructor(public readonly streamId: string) {
    super(`Stream not found: ${streamId}`);
    this.name = 'StreamNotFoundError';
  }
}
