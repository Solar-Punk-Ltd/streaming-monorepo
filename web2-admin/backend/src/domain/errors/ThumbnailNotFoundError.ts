export class ThumbnailNotFoundError extends Error {
  constructor(public readonly streamId: string) {
    super(`Stream ${streamId} has no thumbnail`);
    this.name = 'ThumbnailNotFoundError';
  }
}
