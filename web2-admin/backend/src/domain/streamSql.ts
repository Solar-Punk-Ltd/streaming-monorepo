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
  duration_seconds, live_since, ended_at, created_at, updated_at
`;
