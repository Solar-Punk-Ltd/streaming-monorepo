import type { CatalogueTarget, ThumbnailFile } from '../FeedGateway.js';

/**
 * The stream's image, for the archive: the file the admin holds of it, and the upload that stamps it again.
 * `docs/architecture/web2-admin.md`, "What is copied". Two things use it:
 *
 * - **An archive job**, with its first quality, beside the stream card's frame, to put the image the catalogue entry
 *   names under the job's archive stamp. Its rules are the frame's: it runs on every pass, stays outside the quality's
 *   counts, and a failure is logged and left out, so it never stops a copy.
 * - **A publish that names an image** (`PublishArchiveImages`, which ArchiveService answers), to put that image under
 *   every archive stamp that holds a copy of the stream, can be written, and has no record of that image. It runs
 *   after the publish, one stamp after another, and a failure is logged and that stamp left out, so it never stops or
 *   fails a publish. `ArchiveService.settled()` waits for it, for the tests.
 *
 * Either way the image is recorded as stamped (`ArchiveStore.recordThumbnail`) only when `restamp` answers the
 * reference the stream names; any other answer is logged and left out. A job records who started it, a publish who
 * published.
 */
export interface ArchiveThumbnails {
  /** The image's bytes, name and type as the stream's row holds them, or null when it holds none. */
  fileOf(streamId: string): Promise<ThumbnailFile | null>;
  /**
   * Uploads the image under the target's batch through the target's node, and answers the reference it came out at:
   * from `file` when the admin holds the bytes, otherwise from the file read back from the network at `reference`.
   * The catalogue move's upload, `CatalogueRestamper.restampThumbnail`, is this one.
   */
  restamp(reference: string, file: ThumbnailFile | null, target: CatalogueTarget): Promise<string>;
}
