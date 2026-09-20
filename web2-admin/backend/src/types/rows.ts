/**
 * Database row shapes, exactly as node-postgres returns them: snake_case
 * columns, `Date` for TIMESTAMPTZ, `number` for the BIGINT feed index (see the
 * int8 type parser in Database.ts). The API contract in web2-admin-common is
 * camelCase; src/api/presenters.ts is the only place that converts.
 */
import type {
  ManagedLifecycleState,
  ManagedRunPermission,
  MediaType,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  /** May add and remove users and sign anyone out. Migration 005. */
  is_admin: boolean;
  password_changed_at: Date | null;
  /** Null for a user who has never signed in. */
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A stream row without the thumbnail bytes — every query uses STREAM_COLUMNS,
 * which projects `thumbnail IS NOT NULL` instead of the BYTEA itself so list
 * responses do not drag megabytes through the pool.
 */
export interface StreamRow {
  id: string;
  user_id: string;
  topic: string;
  owner: string;
  title: string;
  description: string;
  tags: string[];
  media_type: MediaType;
  scheduled_start_time: Date | null;
  has_thumbnail: boolean;
  thumbnail_mime: string | null;
  thumbnail_ref: string | null;
  status: StreamStatus;
  published_at: Date | null;
  published_feed_index: number | null;
  publish_error: string | null;
  publish_key: string;
  publish_key_rotated_at: Date | null;
  /** What the uploader reported back; null until an encoder connects. */
  manifest_index: number | null;
  duration_seconds: number | null;
  live_since: Date | null;
  ended_at: Date | null;
  lifecycle_version: number | null;
  lifecycle_revision: number;
  current_run_number: number | null;
  completed_run_number: number | null;
  lifecycle_state: ManagedLifecycleState | null;
  lifecycle_permission: ManagedRunPermission | null;
  lifecycle_uploader_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ThumbnailRow {
  thumbnail: Buffer;
  thumbnail_mime: string | null;
}

/**
 * One rung of a stream's ABR ladder, as the uploader last reported it. The
 * wire shape is `Rendition` in web2-admin-common — camelCase, and `index` /
 * `duration` for the two nullable columns; `src/domain/renditions.ts`
 * converts, the way feedEntries.ts does for the entry as a whole.
 */
export interface StreamRenditionRow {
  stream_id: string;
  name: string;
  width: number;
  height: number;
  topic: string;
  bandwidth: number;
  avg_bandwidth: number;
  /** Null until the rung finalizes; set together with `duration_seconds`. */
  manifest_index: number | null;
  duration_seconds: number | null;
  updated_at: Date;
}
