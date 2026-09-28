/**
 * Shared projection for every stream query. The BYTEA thumbnail is
 * deliberately absent — it is fetched on its own by StreamRepository's
 * thumbnail methods — and replaced by the `has_thumbnail` flag the API
 * contract exposes.
 */
export const STREAM_COLUMNS = `
  id, user_id, topic, owner, title, description, tags, media_type,
  scheduled_start_time, (thumbnail IS NOT NULL) AS has_thumbnail,
  thumbnail_mime, thumbnail_ref, status, published_at, published_feed_index,
  publish_error, publish_key, publish_key_rotated_at, manifest_index,
  duration_seconds, live_since, ended_at, content_edited_at,
  entry_content_edited_at, stage_id, created_at, updated_at
`;

/**
 * What a console edit stamps `content_edited_at` with: now, to the
 * millisecond. The service reads that value into a JavaScript `Date`, which
 * holds milliseconds, and writes it back as `entry_content_edited_at` once the
 * entry carries the edit. Truncating here keeps the two columns equal in the
 * database too, rather than a microsecond apart.
 */
export const CONTENT_EDITED_NOW = `date_trunc('milliseconds', NOW())`;

/**
 * The same, for the rungs of a stream's ABR ladder. Small enough to list, and
 * listed for the same reason: `SELECT *` would start leaking new columns into
 * StreamRenditionRow without anyone saying so.
 */
export const STREAM_RENDITION_COLUMNS = `
  stream_id, name, width, height, topic, bandwidth, avg_bandwidth,
  manifest_index, duration_seconds, updated_at
`;

/**
 * An address column in the form a stream's `owner` is kept in, lower case and
 * without `0x`: `asFeedOwner` in SQL. A stage's owner is stored with `0x`.
 */
export const FEED_OWNER_SQL = (column: string): string => `regexp_replace(lower(${column}), '^0x', '')`;

/** Whether two address columns are one address, whatever their case and prefix: `sameFeedOwner` in SQL. */
export const SAME_OWNER_SQL = (left: string, right: string): string =>
  `${FEED_OWNER_SQL(left)} = ${FEED_OWNER_SQL(right)}`;
