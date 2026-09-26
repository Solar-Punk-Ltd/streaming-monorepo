/**
 * The stream was created under a different feed key than the one the gateway
 * signs with now. `streams.owner` is denormalised at create time and is what
 * viewers look the stream up by, so publishing it under the current key would
 * write an entry whose `owner` nobody can resolve.
 *
 * Unpublishing is deliberately still allowed: the entry is removed by the
 * owner stored on the row, which is the one it was written with.
 */
export class FeedOwnerMismatchError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly streamOwner: string,
    public readonly feedOwner: string,
  ) {
    super(
      `This stream was created under feed owner ${streamOwner}, but the backend now signs the stream list feed as ${feedOwner}. Unpublish it, or recreate it, to publish under the current key.`,
    );
    this.name = 'FeedOwnerMismatchError';
  }
}
