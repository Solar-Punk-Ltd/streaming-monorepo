import { ON_FEED_STATUSES, type StreamRow } from '../types/index.js';

/**
 * Whether the console holds an edit this stream's catalogue entry does not
 * carry: the title, description, tags, media type, scheduled start or
 * thumbnail changed after the last write that rebuilt the entry from the row.
 * That is what the console's "Edited since it was published" notice means,
 * and a republish is what clears it.
 *
 * `updated_at` cannot answer this. The uploader's live and vod reports, a key
 * rotation, thumbnail bookkeeping and a publish error all move it, and none of
 * them is an edit the operator has to republish. Only a stream on the
 * catalogue has an entry to fall behind, so anything else answers false.
 */
export function hasUnpublishedEdits(stream: StreamRow): boolean {
  if (!ON_FEED_STATUSES.includes(stream.status)) return false;
  return !sameInstant(stream.content_edited_at, stream.entry_content_edited_at);
}

/**
 * An image stored for the stream but not uploaded yet: storing one clears the
 * reference, and only a publish or a republish uploads it. An entry rebuilt
 * from such a row without that upload goes out with no thumbnail at all.
 */
export function hasPendingThumbnail(stream: StreamRow): boolean {
  return stream.has_thumbnail && stream.thumbnail_ref === null;
}

/** By instant: node-postgres hands back a new `Date` for every read. */
function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}
