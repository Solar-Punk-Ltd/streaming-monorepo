import type { MediaType, StreamStatus } from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import type { StreamRow, ThumbnailRow } from '../types/index.js';

import { STREAM_COLUMNS } from './streamSql.js';

export interface StreamInsertData {
  user_id: string;
  topic: string;
  owner: string;
  title: string;
  description: string;
  tags: string[];
  media_type: MediaType;
  /** ISO 8601, or null. Postgres casts it to TIMESTAMPTZ. */
  scheduled_start_time: string | null;
  publish_key: string;
}

export interface StreamUpdateData {
  title: string;
  description: string;
  tags: string[];
  media_type: MediaType;
  scheduled_start_time: string | null;
}

export class StreamRepository {
  constructor(private readonly pool: Pool) {}

  async list(userId: string): Promise<StreamRow[]> {
    const result = await this.pool.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM streams
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  async findById(id: string, userId: string): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM streams WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * By primary key, with no user scope — the internal API acts on the id it
   * handed the uploader, and there is no session behind that call. Session
   * routes use `findById`, which is scoped, and nothing here may replace it.
   */
  async findByIdUnscoped(id: string): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM streams WHERE id = $1`,
      [id],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * By the stream id viewers and encoders use, with no user scope: the
   * internal API resolves a stream from the ingest address an encoder
   * connected to, and there is no session behind that call to scope it by.
   * `topic` is UNIQUE, so this is still one row.
   */
  async findByTopic(topic: string): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM streams WHERE topic = $1`,
      [topic],
    );
    return this.one(result.rows, result.rowCount);
  }

  async insert(data: StreamInsertData): Promise<StreamRow> {
    const result = await this.pool.query<StreamRow>(
      `INSERT INTO streams (
         user_id, topic, owner, title, description, tags, media_type,
         scheduled_start_time, publish_key
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${STREAM_COLUMNS}`,
      [
        data.user_id,
        data.topic,
        data.owner,
        data.title,
        data.description,
        data.tags,
        data.media_type,
        data.scheduled_start_time,
        data.publish_key,
      ],
    );
    return result.rows[0]!;
  }

  /** Null when the row is not in one of `allowedFrom` (or does not exist). */
  async update(
    id: string,
    userId: string,
    data: StreamUpdateData,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET title = $4,
              description = $5,
              tags = $6,
              media_type = $7,
              scheduled_start_time = $8,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [
        id,
        userId,
        allowedFrom,
        data.title,
        data.description,
        data.tags,
        data.media_type,
        data.scheduled_start_time,
      ],
    );
    return this.one(result.rows, result.rowCount);
  }

  /** True when a row was deleted; false when it was not in `allowedFrom`. */
  async deleteById(
    id: string,
    userId: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM streams
        WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[])`,
      [id, userId, allowedFrom],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findThumbnail(
    id: string,
    userId: string,
  ): Promise<ThumbnailRow | null> {
    const result = await this.pool.query<ThumbnailRow>(
      `SELECT thumbnail, thumbnail_mime FROM streams
        WHERE id = $1 AND user_id = $2 AND thumbnail IS NOT NULL`,
      [id, userId],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Stores new image bytes and clears `thumbnail_ref`: the reference now
   * belongs to a different image, and a null ref is what tells the next
   * publish to upload the new one.
   */
  async setThumbnail(
    id: string,
    userId: string,
    bytes: Buffer,
    mime: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET thumbnail = $4,
              thumbnail_mime = $5,
              thumbnail_ref = NULL,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, allowedFrom, bytes, mime],
    );
    return this.one(result.rows, result.rowCount);
  }

  async clearThumbnail(
    id: string,
    userId: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET thumbnail = NULL,
              thumbnail_mime = NULL,
              thumbnail_ref = NULL,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, allowedFrom],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Stores a Swarm reference for the thumbnail on its own, mid-publish: the
   * upload is paid for the moment it succeeds, so it must survive a publish
   * that fails afterwards instead of being uploaded again next time.
   */
  async recordThumbnailRef(
    id: string,
    userId: string,
    thumbnailRef: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE streams
          SET thumbnail_ref = $3,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [id, userId, thumbnailRef],
    );
  }

  async rotatePublishKey(
    id: string,
    userId: string,
    publishKey: string,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET publish_key = $3,
              publish_key_rotated_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, publishKey],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * The uploader's `live` report. `live_since` is set once per live run: a
   * repeated report (the uploader retries) must not keep moving it, and a
   * stream that goes live after having been announced gets a fresh one.
   * `ended_at` is cleared, so a stream that is live is never also ended.
   *
   * Conditional on `allowedFrom` for the same reason every other transition
   * here is: the check and the write are one statement, so two reports racing
   * cannot both win.
   */
  async markLive(
    id: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = 'live',
              live_since = CASE
                WHEN status = 'live' AND live_since IS NOT NULL THEN live_since
                ELSE NOW()
              END,
              ended_at = NULL,
              publish_error = NULL,
              updated_at = NOW()
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [id, allowedFrom],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * The uploader's `vod` report: the broadcast stopped, and this is where the
   * recording is. `live_since` is left alone — it is when this recording
   * started, and the console shows both ends.
   */
  async markVod(
    id: string,
    allowedFrom: readonly StreamStatus[],
    manifestIndex: number,
    durationSeconds: number,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = 'vod',
              manifest_index = $3,
              duration_seconds = $4,
              ended_at = NOW(),
              publish_error = NULL,
              updated_at = NOW()
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [id, allowedFrom, manifestIndex, durationSeconds],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Records a feed write that did not change the status: a republish of a
   * stream that is live or recorded, where the whole point is that it stays
   * where it is. `published_at` is left alone — it is when the stream was
   * first announced, not when its entry was last rewritten.
   */
  async recordRepublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET published_feed_index = $3,
              publish_error = NULL,
              thumbnail_ref = $4,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, feedIndex, thumbnailRef],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Takes the stream into `publishing`, which is the lock the whole publish
   * runs under. Null means someone else holds it (or the row is gone).
   */
  async claimForPublish(
    id: string,
    userId: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = 'publishing',
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, allowedFrom],
    );
    return this.one(result.rows, result.rowCount);
  }

  async finishPublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = 'published',
              published_at = NOW(),
              published_feed_index = $3,
              publish_error = NULL,
              thumbnail_ref = $4,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, feedIndex, thumbnailRef],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Back to `draft`, keeping `thumbnail_ref` — the upload is still paid for.
   * Everything the uploader reported is cleared: the row is a draft again, and
   * a stale `live_since` or manifest index would describe a recording that is
   * no longer on the catalogue.
   */
  async finishUnpublish(
    id: string,
    userId: string,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = 'draft',
              published_at = NULL,
              published_feed_index = NULL,
              publish_error = NULL,
              manifest_index = NULL,
              duration_seconds = NULL,
              live_since = NULL,
              ended_at = NULL,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId],
    );
    return this.one(result.rows, result.rowCount);
  }

  /** Releases the publishing claim back to where it came from, with the error. */
  async failPublish(
    id: string,
    userId: string,
    previousStatus: StreamStatus,
    message: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE streams
          SET status = $3,
              publish_error = $4,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [id, userId, previousStatus, message],
    );
  }

  /**
   * A process that died mid-publish leaves a row claimed forever; nothing else
   * can clear it, because `publishing` is refused by every transition.
   *
   * Where it goes back to is decided by `published_feed_index`: a row that has
   * one was on the feed before this publish began, and calling it a draft
   * would let DELETE remove the row while its entry stays on the feed with
   * nothing left to unpublish it. Such a row goes back to `published`; a
   * first-time publish that was interrupted goes to `draft`.
   */
  async resetOrphanedPublishing(): Promise<StreamRow[]> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = CASE
                WHEN published_feed_index IS NOT NULL THEN 'published'
                ELSE 'draft'
              END,
              publish_error = 'backend restarted while publishing',
              updated_at = NOW()
        WHERE status = 'publishing'
        RETURNING ${STREAM_COLUMNS}`,
    );
    return result.rows;
  }

  private one<T>(rows: T[], rowCount: number | null): T | null {
    return rowCount && rowCount > 0 ? rows[0]! : null;
  }
}
