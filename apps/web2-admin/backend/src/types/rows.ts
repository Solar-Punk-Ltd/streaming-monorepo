/**
 * Database row shapes, exactly as node-postgres returns them: snake_case
 * columns, `Date` for TIMESTAMPTZ, `number` for the BIGINT feed index (see the
 * int8 type parser in Database.ts). The API contract in web2-admin-common is
 * camelCase; src/api/presenters.ts is the only place that converts.
 */
import type {
  AdminTokenKind,
  CatalogueStampRecord,
  StageEngine,
  StageIngest,
  StageKind,
  StageRecord,
} from '@streaming-monorepo/contracts';
import type { MediaType, StreamStatus } from '@streaming-monorepo/web2-admin-common';

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
  /**
   * Who drafted the row; null once that user has been removed (migration
   * 008). Never used to scope anything.
   */
  user_id: string | null;
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
  /** The batch the thumbnail was last uploaded under (migration 014), or null when unknown. */
  thumbnail_batch_id: string | null;
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
  /**
   * When the console last changed something the catalogue entry carries:
   * title, description, tags, media type, scheduled start or thumbnail. Null
   * when nothing has changed since migration 006. Nothing else moves it.
   */
  content_edited_at: Date | null;
  /**
   * The `content_edited_at` of the row this stream's catalogue entry was last
   * rebuilt from. The two differ while the console holds an edit the entry
   * does not carry. Migration 006.
   */
  entry_content_edited_at: Date | null;
  /**
   * The stage the stream is broadcast on, or null until one is picked
   * (migration 011). Changes only while the stream is a draft, and never on
   * a row that holds a recording and a stage.
   */
  stage_id: string | null;
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

/**
 * A stage record as `stages.record` holds it (migration 009): all of it but the SRT passphrase and the uploader's
 * token, which have columns of their own.
 */
export type StoredStageRecord = Omit<StageRecord, 'adminToken' | 'ingest'> & {
  ingest: Omit<StageIngest, 'srtPassphrase'>;
};

/**
 * A stage as every list reads it: no passphrase and no token hash, only whether there is a passphrase and which
 * kind of token the uploader presents.
 */
export interface StageRow {
  stage_id: string;
  manager_id: string;
  name: string;
  kind: StageKind;
  engine: StageEngine;
  owner: string;
  record: StoredStageRecord;
  has_srt_passphrase: boolean;
  admin_token_kind: AdminTokenKind | null;
  observed_at: Date;
  received_at: Date;
  /** When the manager saw the deployment gone, by its clock, or null while the stage is active. */
  retired_observed_at: Date | null;
  /** When that retirement arrived. */
  retired_at: Date | null;
}

/** One stage with the two values no list selects, read only for the stage it is about. */
export interface StageSecretsRow extends StageRow {
  srt_passphrase: string | null;
  admin_token_sha256: string | null;
}

/**
 * The one row of `catalogue_stamp` (migration 010), cleared or not. The record and the two values copied out of it
 * are null only on a row a clear made before any record arrived.
 */
export interface CatalogueStampRow {
  manager_id: string | null;
  batch_id: string | null;
  record: CatalogueStampRecord | null;
  observed_at: Date;
  received_at: Date;
  /** When the manager saw the designation gone, by its clock, or null while one is designated. */
  cleared_observed_at: Date | null;
  /** When that clear arrived. */
  cleared_at: Date | null;
  /**
   * The batch the catalogue is written with (migration 013), or null until a write pins one. It stays what it is when
   * the manager designates another batch or clears the designation.
   */
  active_batch_id: string | null;
  /** The last record the manager pushed for that batch: its node's Bee API address and its readings. */
  active_record: CatalogueStampRecord | null;
  /** When the admin pinned it, by its own clock. */
  active_pinned_at: Date | null;
}

/** The row while a catalogue batch is designated: it has a record, and no clear stands. */
export interface DesignatedCatalogueStamp extends CatalogueStampRow {
  manager_id: string;
  batch_id: string;
  record: CatalogueStampRecord;
  cleared_observed_at: null;
  cleared_at: null;
}

/** Whether the row says a catalogue batch is designated. */
export function isDesignated(row: CatalogueStampRow | null): row is DesignatedCatalogueStamp {
  return row !== null && row.record !== null && row.cleared_observed_at === null;
}
