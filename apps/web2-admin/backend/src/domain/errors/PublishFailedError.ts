/**
 * Anything that went wrong between claiming a stream for publication and
 * recording the feed write. The stream's previous status has been restored and
 * `publish_error` holds this message by the time it is thrown.
 */
export class PublishFailedError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = 'PublishFailedError';
  }
}
