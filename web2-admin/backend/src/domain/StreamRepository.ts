import type { MediaType, StreamStatus } from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import type { StreamRow, ThumbnailRow } from '../types/index.js';

import type { PublishedStatus } from './streamState.js';
import { CONTENT_EDITED_NOW, STREAM_COLUMNS } from './streamSql.js';

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

  /**
   * Every row that should be on the catalogue, for every user. Unscoped on
   * purpose: `reconcile` compares this against the feed, and a row it could
   * not see would read as an entry with nothing behind it and be removed.
   * `publishing` is excluded — that write is still in flight.
   */
  async listOnFeed(): Promise<StreamRow[]> {
    const result = await this.pool.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM streams
        WHERE status IN ('published', 'live', 'vod')
        ORDER BY created_at`,
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

  /**
   * Null when the row is not in one of `allowedFrom` (or does not exist).
   *
   * `content_edited_at` moves only when a value actually changes. The console
   * PUTs the whole form back on every save, so a save that changed nothing
   * would otherwise ask the operator to republish an entry that is already
   * right. The comparisons read the row as it was, before this SET.
   */
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
              content_edited_at = CASE
                WHEN title IS DISTINCT FROM $4
                  OR description IS DISTINCT FROM $5
                  OR tags IS DISTINCT FROM $6
                  OR media_type IS DISTINCT FROM $7
                  OR scheduled_start_time IS DISTINCT FROM $8
                THEN ${CONTENT_EDITED_NOW}
                ELSE content_edited_at
              END,
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
   * publish to upload the new one. Always an edit, for the same reason: the
   * entry keeps the old reference until a publish uploads this image.
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
              content_edited_at = ${CONTENT_EDITED_NOW},
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, allowedFrom, bytes, mime],
    );
    return this.one(result.rows, result.rowCount);
  }

  /** An edit only when there was an image to remove. */
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
              content_edited_at = CASE
                WHEN thumbnail IS NOT NULL THEN ${CONTENT_EDITED_NOW}
                ELSE content_edited_at
              END,
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
   * `ended_at` is cleared, so a stream that is live is never also ended, and
   * so are `manifest_index` and `duration_seconds`: a stream that is live has
   * no finished recording, and a broadcast coming back after `vod` would
   * otherwise keep listing the previous one while the new session writes over
   * its head.
   *
   * The ladder is un-finished with it, in this one statement rather than
   * through StreamRenditionRepository: a crash between two statements would
   * leave the entry advertising rung recordings that have been superseded.
   * Only a row coming back from `vod` is touched — a repeated `live` report
   * must not throw away rungs that have finalized since, and there is nothing
   * to clear for a broadcast that is starting for the first time. Index and
   * duration go null together, as migration 004 requires.
   *
   * Conditional on `allowedFrom` for the same reason every other transition
   * here is: the check and the write are one statement, so two reports racing
   * cannot both win.
   *
   * ⛔ `locked` is read by `moved`, and that is what makes the lock work.
   * Postgres runs a data-modifying CTE nothing selects from *after* the main
   * query, so a `FOR UPDATE` that only an unreferenced CTE depends on is
   * evaluated once the row has already been written by this same command —
   * which makes it self-modified, skips it, and silently clears no rungs at
   * all. Keeping the lock on the path the returned row depends on evaluates it
   * first, before anything is written, and gives `unfinished` the status the
   * row actually had. Do not reorder these.
   */
  async markLive(
    id: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `WITH locked AS (
         SELECT id, status FROM streams WHERE id = $1 FOR UPDATE
       ), moved AS (
         UPDATE streams
            SET status = 'live',
                live_since = CASE
                  WHEN status = 'live' AND live_since IS NOT NULL THEN live_since
                  ELSE NOW()
                END,
                manifest_index = NULL,
                duration_seconds = NULL,
                ended_at = NULL,
                publish_error = NULL,
                updated_at = NOW()
          WHERE id IN (SELECT id FROM locked WHERE status = ANY($2::text[]))
          RETURNING ${STREAM_COLUMNS}
       ), unfinished AS (
         UPDATE stream_renditions
            SET manifest_index = NULL,
                duration_seconds = NULL,
                updated_at = NOW()
          WHERE stream_id IN (
            SELECT id FROM locked
             WHERE status = 'vod' AND status = ANY($2::text[])
          )
       )
       SELECT * FROM moved`,
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
   *
   * `entryContentEditedAt` is the `content_edited_at` the entry was built
   * from. It is handed in rather than copied from the row, because an edit can
   * land while the write is in flight, and the entry does not carry that one.
   */
  async recordRepublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET published_feed_index = $3,
              publish_error = NULL,
              thumbnail_ref = $4,
              entry_content_edited_at = $5,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, feedIndex, thumbnailRef, entryContentEditedAt],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * A reconcile rebuilt this stream's entry from the row: record which edit it
   * carries now. Unscoped, like the reconcile itself, which rebuilds entries
   * from every user's rows when no user is given.
   */
  async recordEntryRebuilt(
    id: string,
    entryContentEditedAt: Date | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE streams
          SET entry_content_edited_at = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [id, entryContentEditedAt],
    );
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

  /**
   * `entryContentEditedAt` as on `recordRepublish`. `status` is where the
   * publish leaves the row, `vod` for a draft that still holds a recording
   * (`publishedStatusFor`), so the row says what its entry says.
   */
  async finishPublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
    status: PublishedStatus,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = $6,
              published_at = NOW(),
              published_feed_index = $3,
              publish_error = NULL,
              thumbnail_ref = $4,
              entry_content_edited_at = $5,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId, feedIndex, thumbnailRef, entryContentEditedAt, status],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Back to `draft` and off the catalogue, keeping everything the stream has:
   * `thumbnail_ref`, because the upload is still paid for, and what the
   * uploader reported, which is where the recording is, how long it runs,
   * when it was live and its ABR rungs. Publishing the draft again lists it as
   * that recording. Only what described the catalogue entry is cleared.
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
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${STREAM_COLUMNS}`,
      [id, userId],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Releases the publishing claim back to where it came from, with the error.
   * Only for the paths that took the claim — a first publish, an unpublish.
   */
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
   * Records why a feed write failed, and nothing else. For the republish path,
   * which takes no `publishing` claim: the status is whatever the uploader last
   * reported, and putting back the one the caller saw would undo a `live` that
   * landed while the write waited its turn.
   */
  async recordPublishError(
    id: string,
    userId: string,
    message: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE streams
          SET publish_error = $3,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [id, userId, message],
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
