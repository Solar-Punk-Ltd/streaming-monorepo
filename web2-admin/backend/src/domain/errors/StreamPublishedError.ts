import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

/** Refuses to delete a stream that is still in the feed: unpublish it first. */
export class StreamPublishedError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly currentStatus: StreamStatus,
  ) {
    super(
      `Stream ${streamId} is ${currentStatus}; unpublish it before deleting`,
    );
    this.name = 'StreamPublishedError';
  }
}
