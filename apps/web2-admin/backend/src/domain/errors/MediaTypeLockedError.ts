import type { MediaType } from '@streaming-monorepo/web2-admin-common';

/**
 * A published stream's media type is the `app` half of the ingest stream id
 * (`<mediaType>/<topic>`), so changing it moves the address the streamer has
 * already configured in OBS. Unpublish first.
 */
export class MediaTypeLockedError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly currentMediaType: MediaType,
  ) {
    super('Unpublish the stream before changing its media type; it is part of the OBS stream id.');
    this.name = 'MediaTypeLockedError';
  }
}
