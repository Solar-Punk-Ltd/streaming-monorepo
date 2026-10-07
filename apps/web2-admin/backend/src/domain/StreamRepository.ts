import type { MediaType, StreamStatus } from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import type { StreamRow, ThumbnailRow } from '../types/index.js';

import { SUPPORTED_STAGE_ENGINES } from './StageService.js';
import type { PublishedStatus } from './streamState.js';
import { CONTENT_EDITED_NOW, FEED_OWNER_SQL, NO_RECORDING_SQL, SAME_OWNER_SQL, STREAM_COLUMNS } from './streamSql.js';

export interface StreamInsertData {
  /**
   * Who drafted the row. Recorded, and never used to scope a query: a stream
   * belongs to the installation, and every signed-in operator shares it.
   * Always an operator's id on insert; the column goes null when that user
   * is removed (migration 008).
   */
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
  /** The stage picked in the form, or null. The service has checked it takes streams. */
  stage_id: string | null;
}

export interface StreamUpdateData {
  title: string;
  description: string;
  tags: string[];
  media_type: MediaType;
  scheduled_start_time: string | null;
  /**
   * The stage to set, null to clear it, or absent to leave it as it is. A
   * change is written only while the row may take one; see `update`.
   */
  stage_id?: string | null;
  /**
   * The owner the stream takes with its new stage, or absent to leave it. Set
   * only with a stage change, and written only while the row holds no
   * recording, since a recording is signed as the owner it was made under.
   */
  owner?: string;
}

/** A thumbnail a stream names, as moving the catalogue uploads it again: its bytes are null once the row lost them. */
export interface StoredThumbnail {
  reference: string;
  thumbnail: Buffer | null;
  thumbnail_mime: string | null;
  topic: string;
}

/** What a thumbnail clear left on the row, and whether it removed an image. */
export interface ClearedThumbnail {
  stream: StreamRow;
  /** Whether the row held an image when the clear took its lock. */
  removed: boolean;
}

export class StreamRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<StreamRow[]> {
    const result = await this.pool.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM streams
        ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  /**
   * Every row that should be on the catalogue. `reconcile` compares this
   * against the feed, and a row it could not see would read as an entry with
   * nothing behind it and be removed. `publishing` is excluded — that write is
   * still in flight.
   */
  async listOnFeed(): Promise<StreamRow[]> {
    const result = await this.pool.query<StreamRow>(
      `SELECT ${STREAM_COLUMNS} FROM streams
        WHERE status IN ('published', 'live', 'vod')
        ORDER BY created_at`,
    );
    return result.rows;
  }

  /**
   * By primary key. Nothing here is scoped to a user: a stream belongs to the
   * installation, so every signed-in operator acts on the same rows, and the
   * internal API acts on the id it handed the uploader with no session at all.
   */
  async findById(id: string): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(`SELECT ${STREAM_COLUMNS} FROM streams WHERE id = $1`, [id]);
    return this.one(result.rows, result.rowCount);
  }

  /**
   * By the stream id viewers and encoders use: the internal API resolves a
   * stream from the ingest address an encoder connected to. `topic` is
   * UNIQUE, so this is still one row.
   */
  async findByTopic(topic: string): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(`SELECT ${STREAM_COLUMNS} FROM streams WHERE topic = $1`, [topic]);
    return this.one(result.rows, result.rowCount);
  }

  async insert(data: StreamInsertData): Promise<StreamRow> {
    const result = await this.pool.query<StreamRow>(
      `INSERT INTO streams (
         user_id, topic, owner, title, description, tags, media_type,
         scheduled_start_time, publish_key, stage_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        data.stage_id,
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
   * right. The comparisons read the row as it was, before this SET. A stage
   * is not on the catalogue entry, so it never moves `content_edited_at`.
   *
   * A stage change is refused here as well as in the service, so an edit and
   * a publish racing cannot leave a published stream on another stage: the
   * row takes one only while it is a draft, and never while it holds both a
   * recording and a stage, and only a stage that can take streams: one the
   * stages table holds, not retired, on a supported engine. A save that leaves
   * the stage alone, or names the one it has, is not a change. A row that
   * holds a recording and no stage, one older than stages, takes only a stage
   * that signs as the row's owner, since its recording is signed as that.
   *
   * `owner` is written with the stage, and never on a row that holds a
   * recording.
   */
  async update(id: string, data: StreamUpdateData, allowedFrom: readonly StreamStatus[]): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET title = $3,
              description = $4,
              tags = $5,
              media_type = $6,
              scheduled_start_time = $7,
              content_edited_at = CASE
                WHEN title IS DISTINCT FROM $3
                  OR description IS DISTINCT FROM $4
                  OR tags IS DISTINCT FROM $5
                  OR media_type IS DISTINCT FROM $6
                  OR scheduled_start_time IS DISTINCT FROM $7
                THEN ${CONTENT_EDITED_NOW}
                ELSE content_edited_at
              END,
              stage_id = CASE WHEN $9 THEN $8::uuid ELSE stage_id END,
              owner = CASE
                WHEN $11::text IS NOT NULL AND ${NO_RECORDING_SQL()} THEN $11::text
                ELSE owner
              END,
              updated_at = NOW()
        WHERE id = $1 AND status = ANY($2::text[])
          AND (
            NOT $9
            OR stage_id IS NOT DISTINCT FROM $8::uuid
            OR (
              status = 'draft'
              AND (${NO_RECORDING_SQL()} OR stage_id IS NULL)
              AND (
                $8::uuid IS NULL
                OR EXISTS (
                  SELECT 1 FROM stages
                   WHERE stages.stage_id = $8::uuid
                     AND stages.retired_observed_at IS NULL
                     AND stages.engine = ANY($10::text[])
                     AND (
                       ${NO_RECORDING_SQL()}
                       OR ${SAME_OWNER_SQL('stages.owner', 'streams.owner')}
                     )
                )
              )
            )
          )
        RETURNING ${STREAM_COLUMNS}`,
      [
        id,
        allowedFrom,
        data.title,
        data.description,
        data.tags,
        data.media_type,
        data.scheduled_start_time,
        data.stage_id ?? null,
        data.stage_id !== undefined,
        SUPPORTED_STAGE_ENGINES,
        data.owner ?? null,
      ],
    );
    return this.one(result.rows, result.rowCount);
  }

  /** True when a row was deleted; false when it was not in `allowedFrom`. */
  async deleteById(id: string, allowedFrom: readonly StreamStatus[]): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM streams
        WHERE id = $1 AND status = ANY($2::text[])`,
      [id, allowedFrom],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findThumbnail(id: string): Promise<ThumbnailRow | null> {
    const result = await this.pool.query<ThumbnailRow>(
      `SELECT thumbnail, thumbnail_mime FROM streams
        WHERE id = $1 AND thumbnail IS NOT NULL`,
      [id],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Every thumbnail a stream names by its upload reference, published or not, with the stored bytes when the row
   * still holds them and the topic its file was named by: moving the catalogue uploads each again under the new
   * batch. A row whose image changed since has cleared its reference, so it never answers for the old one.
   */
  async listStoredThumbnails(): Promise<StoredThumbnail[]> {
    const result = await this.pool.query<StoredThumbnail>(
      `SELECT DISTINCT ON (thumbnail_ref) thumbnail_ref AS reference, thumbnail, thumbnail_mime, topic
         FROM streams
        WHERE thumbnail_ref IS NOT NULL
        ORDER BY thumbnail_ref, (thumbnail IS NOT NULL) DESC, updated_at DESC`,
    );
    return result.rows;
  }

  /** Records that the thumbnail `reference` names is under `batchId` now, on every stream that names it. */
  async recordThumbnailBatch(reference: string, batchId: string): Promise<void> {
    await this.pool.query(`UPDATE streams SET thumbnail_batch_id = $2 WHERE thumbnail_ref = $1`, [reference, batchId]);
  }

  /**
   * Stores new image bytes and clears `thumbnail_ref`: the reference now
   * belongs to a different image, and a null ref is what tells the next
   * publish to upload the new one. Always an edit, for the same reason: the
   * entry keeps the old reference until a publish uploads this image.
   */
  async setThumbnail(
    id: string,
    bytes: Buffer,
    mime: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET thumbnail = $3,
              thumbnail_mime = $4,
              thumbnail_ref = NULL,
              thumbnail_batch_id = NULL,
              content_edited_at = ${CONTENT_EDITED_NOW},
              updated_at = NOW()
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [id, allowedFrom, bytes, mime],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * An edit only when there was an image to remove, and the answer says
   * whether there was. The statement finds that out itself, from the row as
   * it locks it: an image another operator set a moment earlier is one this
   * clear removes, and a read made before the statement would have missed it.
   *
   * `locked` is what the UPDATE joins its row through, so the lock is taken
   * before anything is written. It waits for a write that already holds the
   * row and then reads the row as that write committed it, where a plain
   * read in this same statement would still see the statement's snapshot.
   * Its columns are named apart from the table's, which RETURNING lists
   * unqualified.
   */
  async clearThumbnail(id: string, allowedFrom: readonly StreamStatus[]): Promise<ClearedThumbnail | null> {
    const result = await this.pool.query<StreamRow & { had_thumbnail: boolean }>(
      `WITH locked AS (
         SELECT id AS locked_id, (thumbnail IS NOT NULL) AS had_thumbnail
           FROM streams
          WHERE id = $1 AND status = ANY($2::text[])
            FOR UPDATE
       )
       UPDATE streams
          SET thumbnail = NULL,
              thumbnail_mime = NULL,
              thumbnail_ref = NULL,
              thumbnail_batch_id = NULL,
              content_edited_at = CASE
                WHEN locked.had_thumbnail THEN ${CONTENT_EDITED_NOW}
                ELSE content_edited_at
              END,
              updated_at = NOW()
         FROM locked
        WHERE streams.id = locked.locked_id
        RETURNING ${STREAM_COLUMNS}, locked.had_thumbnail`,
      [id, allowedFrom],
    );
    const row = this.one(result.rows, result.rowCount);
    if (!row) return null;
    const { had_thumbnail: removed, ...stream } = row;
    return { stream, removed };
  }

  /**
   * Stores a Swarm reference for the thumbnail on its own, mid-publish: the
   * upload is paid for the moment it succeeds, so it must survive a publish
   * that fails afterwards instead of being uploaded again next time.
   */
  async recordThumbnailRef(id: string, thumbnailRef: string, batchId: string | null = null): Promise<void> {
    await this.pool.query(
      `UPDATE streams
          SET thumbnail_ref = $2,
              thumbnail_batch_id = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [id, thumbnailRef, batchId],
    );
  }

  async rotatePublishKey(id: string, publishKey: string): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET publish_key = $2,
              publish_key_rotated_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${STREAM_COLUMNS}`,
      [id, publishKey],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * The uploader's `live` report. `live_since` is set once per live run: a
   * repeated report (the uploader retries) must not keep moving it, and a
   * stream that goes live after having been announced gets a fresh one.
   * `ended_at` is cleared, so a stream that is live is never also ended, and
   * so are `recording_ref` and `duration_seconds`: a stream
   * that is live has no finished recording, and a broadcast coming back after
   * `vod` would otherwise keep listing the previous one while the new session
   * writes over its head.
   *
   * The ladder is un-finished with it, in this one statement rather than
   * through StreamRenditionRepository: a crash between two statements would
   * leave the entry advertising rung recordings that have been superseded.
   * Only a row coming back from `vod` is touched. A repeated `live` report
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
  async markLive(id: string, allowedFrom: readonly StreamStatus[]): Promise<StreamRow | null> {
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
                recording_ref = NULL,
                duration_seconds = NULL,
                ended_at = NULL,
                publish_error = NULL,
                updated_at = NOW()
          WHERE id IN (SELECT id FROM locked WHERE status = ANY($2::text[]))
          RETURNING ${STREAM_COLUMNS}
       ), unfinished AS (
         UPDATE stream_renditions
            SET recording_ref = NULL,
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
    recordingRef: string,
    durationSeconds: number,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = 'vod',
              recording_ref = $3,
              duration_seconds = $4,
              ended_at = NOW(),
              publish_error = NULL,
              updated_at = NOW()
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING ${STREAM_COLUMNS}`,
      [id, allowedFrom, recordingRef, durationSeconds],
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
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET published_feed_index = $2,
              publish_error = NULL,
              thumbnail_batch_id = CASE WHEN thumbnail_ref IS DISTINCT FROM $3 THEN NULL ELSE thumbnail_batch_id END,
              thumbnail_ref = $3,
              entry_content_edited_at = $4,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${STREAM_COLUMNS}`,
      [id, feedIndex, thumbnailRef, entryContentEditedAt],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * A reconcile rebuilt this stream's entry from the row and wrote it at
   * `feedIndex`: record where the entry is now and which edit it carries.
   * `published_at` is left alone, as on `recordRepublish`.
   */
  async recordEntryRebuilt(id: string, feedIndex: number, entryContentEditedAt: Date | null): Promise<void> {
    await this.pool.query(
      `UPDATE streams
          SET published_feed_index = $2,
              entry_content_edited_at = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [id, feedIndex, entryContentEditedAt],
    );
  }

  /**
   * Takes the stream into `publishing`, which is the lock the whole publish
   * runs under. Null means someone else holds it, the row is gone, or, with
   * `draftNeedsStage`, it is a draft with no stage: a publish checks that
   * before it claims, and this holds it against an edit that clears the stage
   * in between.
   *
   * A publish's claim, the one with `draftNeedsStage`, gives a draft that
   * holds no recording its stage's owner, read in the same statement: the
   * manager may have rotated the stage's key since the stage was picked, and
   * the entry this publish writes names the owner the stage signs as now. A
   * row that holds a recording keeps its owner, and a publish's claim takes
   * it only while its stage signs as that owner, since its feeds resolve under
   * it alone; null then too. It keeps its owner, and so does every row that is
   * not a draft, since publishing fixed it, and every row an unpublish
   * claims, which takes an entry off by the owner it was written with.
   */
  async claimForPublish(
    id: string,
    allowedFrom: readonly StreamStatus[],
    draftNeedsStage = false,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = 'publishing',
              owner = CASE
                WHEN $3 AND status = 'draft' AND ${NO_RECORDING_SQL()} THEN COALESCE(
                  (SELECT ${FEED_OWNER_SQL('stages.owner')} FROM stages WHERE stages.stage_id = streams.stage_id),
                  owner
                )
                ELSE owner
              END,
              updated_at = NOW()
        WHERE id = $1 AND status = ANY($2::text[])
          AND (NOT $3 OR status <> 'draft' OR stage_id IS NOT NULL)
          AND (
            NOT $3 OR status <> 'draft' OR ${NO_RECORDING_SQL()} OR stage_id IS NULL
            OR EXISTS (
              SELECT 1 FROM stages
               WHERE stages.stage_id = streams.stage_id
                 AND ${SAME_OWNER_SQL('stages.owner', 'streams.owner')}
            )
          )
        RETURNING ${STREAM_COLUMNS}`,
      [id, allowedFrom, draftNeedsStage],
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
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
    status: PublishedStatus,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = $5,
              published_at = NOW(),
              published_feed_index = $2,
              publish_error = NULL,
              thumbnail_batch_id = CASE WHEN thumbnail_ref IS DISTINCT FROM $3 THEN NULL ELSE thumbnail_batch_id END,
              thumbnail_ref = $3,
              entry_content_edited_at = $4,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${STREAM_COLUMNS}`,
      [id, feedIndex, thumbnailRef, entryContentEditedAt, status],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * A publish or a hand republish that found its entry on the catalogue head
   * already and wrote nothing: what `finishPublish` or `recordRepublish` would
   * record, except `published_at` and `published_feed_index`. Nothing was
   * published, so neither the stream's first announcement nor the write that
   * last carried its entry moved. `status` releases a publish's claim; null,
   * for a stream that is live or recorded, leaves the one the uploader last
   * reported, as `recordRepublish` does.
   */
  async finishWithoutWrite(
    id: string,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
    status: PublishedStatus | null,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = COALESCE($4::text, status),
              publish_error = NULL,
              thumbnail_batch_id = CASE WHEN thumbnail_ref IS DISTINCT FROM $2 THEN NULL ELSE thumbnail_batch_id END,
              thumbnail_ref = $2,
              entry_content_edited_at = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${STREAM_COLUMNS}`,
      [id, thumbnailRef, entryContentEditedAt, status],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Back to `draft` and off the catalogue, keeping everything the stream has:
   * `thumbnail_ref`, because the upload is still paid for, and what the
   * uploader reported, which is where the recording is, how long it runs,
   * when it was live and its ABR rungs. Publishing the draft again lists it as
   * that recording.
   */
  async finishUnpublish(id: string): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET status = 'draft',
              published_at = NULL,
              published_feed_index = NULL,
              publish_error = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${STREAM_COLUMNS}`,
      [id],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Releases the publishing claim back to where it came from, with the error.
   * Only for the paths that took the claim — a first publish, an unpublish.
   */
  async failPublish(id: string, previousStatus: StreamStatus, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE streams
          SET status = $2,
              publish_error = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [id, previousStatus, message],
    );
  }

  /**
   * Records why a feed write failed, and nothing else. For the republish path,
   * which takes no `publishing` claim: the status is whatever the uploader last
   * reported, and putting back the one the caller saw would undo a `live` that
   * landed while the write waited its turn.
   */
  async recordPublishError(id: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE streams
          SET publish_error = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [id, message],
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
