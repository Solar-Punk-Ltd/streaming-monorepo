import type {
  CompletedRecordingSnapshot,
  ManagedLifecycleState,
  ManagedOwnerLifecycle,
  ManagedRunPermission,
  MediaType,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';
import { Pool, type PoolClient } from 'pg';

import type {
  StreamRenditionRow,
  StreamRow,
  ThumbnailRow,
} from '../types/index.js';

import type { ManagedCatalogueState } from './feedEntries.js';
import { STREAM_COLUMNS, STREAM_RENDITION_COLUMNS } from './streamSql.js';

type Queryable = Pool | PoolClient;

interface ManagedCatalogueDatabaseRow {
  lifecycle_version: number | null;
  lifecycle_revision: number;
  current_run_number: number | null;
  completed_run_number: number | null;
  state: ManagedLifecycleState | null;
  permission: ManagedRunPermission | null;
  reconnect_remaining_ms: number | null;
  close_reason: ManagedOwnerLifecycle['closeReason'] | null;
  empty_checkpoint_reference: string | null;
  accepted_media_count: string | number | null;
  last_received_at: Date | null;
  observation_age_ms: number | null;
}

export interface ManagedOwnerState {
  lifecycle: ManagedOwnerLifecycle;
  completedRecording?: CompletedRecordingSnapshot;
}

export interface CatalogueStreamSnapshot {
  stream: StreamRow;
  renditions: StreamRenditionRow[];
  managedState?: ManagedCatalogueState;
}

interface PublicRecordingDatabaseRow {
  master_topic: string;
  master_index: string | number;
  master_reference: string;
  duration_seconds: number;
}

interface PublicRenditionDatabaseRow {
  name: string;
  topic: string;
  manifest_index: string | number;
  reference: string;
  duration_seconds: number;
  width: number;
  height: number;
  bandwidth: string | number;
  avg_bandwidth: string | number;
}

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
          AND (lifecycle_version IS DISTINCT FROM 1 OR published_at IS NOT NULL)
        ORDER BY created_at`,
    );
    return result.rows;
  }

  async catalogueSnapshot(
    streamId: string,
  ): Promise<CatalogueStreamSnapshot | null> {
    return this.inCatalogueSnapshot(async (client) => {
      const result = await client.query<StreamRow>(
        `SELECT ${STREAM_COLUMNS} FROM streams WHERE id = $1`,
        [streamId],
      );
      const stream = this.one(result.rows, result.rowCount);
      return stream ? this.readCatalogueSnapshot(client, stream) : null;
    });
  }

  async catalogueSnapshotsOnFeed(): Promise<CatalogueStreamSnapshot[]> {
    return this.inCatalogueSnapshot(async (client) => {
      const result = await client.query<StreamRow>(
        `SELECT ${STREAM_COLUMNS} FROM streams
          WHERE status IN ('published', 'live', 'vod')
            AND (lifecycle_version IS DISTINCT FROM 1 OR published_at IS NOT NULL)
          ORDER BY created_at`,
      );
      const snapshots: CatalogueStreamSnapshot[] = [];
      for (const stream of result.rows) {
        snapshots.push(await this.readCatalogueSnapshot(client, stream));
      }
      return snapshots;
    });
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

  async managedCatalogueState(
    streamId: string,
  ): Promise<ManagedCatalogueState | null> {
    const ownerState = await this.managedOwnerState(streamId);
    if (!ownerState) return null;
    const { version, revision, runNumber, state } = ownerState.lifecycle;
    return {
      lifecycle: { version, revision, runNumber, state },
      ...(ownerState.completedRecording
        ? { completedRecording: ownerState.completedRecording }
        : {}),
    };
  }

  async managedOwnerState(streamId: string): Promise<ManagedOwnerState | null> {
    return this.readManagedOwnerState(this.pool, streamId);
  }

  private async readManagedOwnerState(
    queryable: Queryable,
    streamId: string,
  ): Promise<ManagedOwnerState | null> {
    const stateResult = await queryable.query<ManagedCatalogueDatabaseRow>(
      `SELECT stream.lifecycle_version, stream.lifecycle_revision,
              stream.current_run_number, stream.completed_run_number,
              run.state, run.permission,
              run.close_reason, run.empty_checkpoint_reference,
              run.accepted_media_count, run.last_received_at,
              CASE WHEN run.last_received_at IS NULL THEN NULL
                   ELSE GREATEST(
                     0,
                     EXTRACT(EPOCH FROM (clock_timestamp() - run.last_received_at)) * 1000
                   )::double precision
              END AS observation_age_ms,
              CASE WHEN run.reconnect_deadline IS NULL
                     OR run.last_observed_at IS NULL
                     OR run.last_received_at IS NULL
                   THEN NULL
                   ELSE LEAST(
                     60000,
                     GREATEST(
                       0,
                       EXTRACT(EPOCH FROM (
                         run.reconnect_deadline - run.last_observed_at
                       )) * 1000
                       - EXTRACT(EPOCH FROM (
                         clock_timestamp() - run.last_received_at
                       )) * 1000
                     )
                   )::double precision
              END AS reconnect_remaining_ms
         FROM streams stream
         LEFT JOIN stream_runs run
           ON run.stream_id = stream.id
          AND run.run_number = stream.current_run_number
        WHERE stream.id = $1`,
      [streamId],
    );
    const state = this.one(stateResult.rows, stateResult.rowCount);
    if (
      state?.lifecycle_version !== 1 ||
      state.current_run_number === null ||
      state.state === null ||
      state.permission === null
    ) {
      return null;
    }

    const lifecycle: ManagedOwnerLifecycle = {
      version: 1,
      revision: state.lifecycle_revision,
      runNumber: state.current_run_number,
      state: state.state,
      permission: state.permission,
      canContinue:
        state.permission === 'closed' &&
        ((state.state === 'vod' &&
          state.completed_run_number === state.current_run_number) ||
          (state.state === 'closed' &&
            state.close_reason === 'empty' &&
            state.empty_checkpoint_reference !== null &&
            state.accepted_media_count !== null &&
            Number(state.accepted_media_count) === 0)),
      ...(state.close_reason ? { closeReason: state.close_reason } : {}),
      ...(state.state === 'waiting' && state.reconnect_remaining_ms !== null
        ? { reconnectRemainingMs: state.reconnect_remaining_ms }
        : {}),
      ...(state.last_received_at &&
      state.observation_age_ms !== null &&
      (state.state === 'claimed' ||
        state.state === 'live' ||
        state.state === 'waiting')
        ? {
            receivedAt: state.last_received_at.toISOString(),
            observationAgeMs: state.observation_age_ms,
          }
        : {}),
    };
    if (state.completed_run_number === null) return { lifecycle };

    return {
      lifecycle,
      completedRecording: await this.completedRecording(
        queryable,
        streamId,
        state.completed_run_number,
      ),
    };
  }

  private async completedRecording(
    queryable: Queryable,
    streamId: string,
    runNumber: number,
  ): Promise<CompletedRecordingSnapshot> {
    const [recordingResult, expectedResult, renditionsResult] =
      await Promise.all([
        queryable.query<PublicRecordingDatabaseRow>(
          `SELECT master_topic, master_index, master_reference, duration_seconds
             FROM stream_run_recordings
            WHERE stream_id = $1 AND run_number = $2`,
          [streamId, runNumber],
        ),
        queryable.query<{ name: string }>(
          `SELECT name
             FROM stream_run_expected_renditions
            WHERE stream_id = $1 AND run_number = $2
            ORDER BY name`,
          [streamId, runNumber],
        ),
        queryable.query<PublicRenditionDatabaseRow>(
          `SELECT name, topic, manifest_index, reference, duration_seconds,
                  width, height, bandwidth, avg_bandwidth
             FROM stream_run_recording_renditions
            WHERE stream_id = $1 AND run_number = $2
            ORDER BY name, topic`,
          [streamId, runNumber],
        ),
      ]);
    const recording = this.one(recordingResult.rows, recordingResult.rowCount);
    if (!recording) {
      throw new Error(
        `managed stream ${streamId} names missing completed run ${runNumber}`,
      );
    }
    return {
      runNumber,
      master: {
        topic: recording.master_topic,
        index: Number(recording.master_index),
        reference: recording.master_reference,
        duration: recording.duration_seconds,
      },
      expectedRenditions: expectedResult.rows.map(({ name }) => name),
      renditions: renditionsResult.rows.map((rendition) => ({
        name: rendition.name,
        topic: rendition.topic,
        index: Number(rendition.manifest_index),
        reference: rendition.reference,
        duration: rendition.duration_seconds,
        width: rendition.width,
        height: rendition.height,
        bandwidth: Number(rendition.bandwidth),
        avgBandwidth: Number(rendition.avg_bandwidth),
      })),
    };
  }

  private async readCatalogueSnapshot(
    client: PoolClient,
    stream: StreamRow,
  ): Promise<CatalogueStreamSnapshot> {
    const managed = stream.lifecycle_version === 1;
    if (managed && stream.current_run_number === null) {
      throw new Error(`managed stream ${stream.id} has no current run number`);
    }
    const renditionResult = managed
      ? await client.query<StreamRenditionRow>(
          `SELECT stream_id, name, width, height, topic, bandwidth,
                  avg_bandwidth, manifest_index, duration_seconds, updated_at
             FROM stream_run_renditions
            WHERE stream_id = $1 AND run_number = $2
            ORDER BY height ASC, name ASC`,
          [stream.id, stream.current_run_number],
        )
      : await client.query<StreamRenditionRow>(
          `SELECT ${STREAM_RENDITION_COLUMNS} FROM stream_renditions
            WHERE stream_id = $1
            ORDER BY height ASC, name ASC`,
          [stream.id],
        );
    if (!managed) {
      return { stream, renditions: renditionResult.rows };
    }
    const ownerState = await this.readManagedOwnerState(client, stream.id);
    if (!ownerState) {
      throw new Error(`managed stream ${stream.id} has no current run state`);
    }
    const { permission: _permission, ...lifecycle } = ownerState.lifecycle;
    return {
      stream,
      renditions: renditionResult.rows,
      managedState: {
        lifecycle,
        ...(ownerState.completedRecording
          ? { completedRecording: ownerState.completedRecording }
          : {}),
      },
    };
  }

  private async inCatalogueSnapshot<T>(
    read: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const result = await read(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    return result.rows[0];
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
   * `ended_at` is cleared, so a stream that is live is never also ended, and
   * so are `manifest_index` and `duration_seconds`: a stream that is live has
   * no finished recording, and a broadcast coming back after `vod` would
   * otherwise keep listing the previous one while the new session writes over
   * its head.
   *
   * The ladder is un-finished with it, in this one statement rather than
   * through StreamRenditionRepository, for the reason `finishUnpublish` clears
   * it in its own: a crash between two statements would leave the entry
   * advertising rung recordings that have been superseded. Only a row coming
   * back from `vod` is touched — a repeated `live` report must not throw away
   * rungs that have finalized since, and there is nothing to clear for a
   * broadcast that is starting for the first time. Index and duration go null
   * together, as migration 004 requires.
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
         SELECT id, status, lifecycle_version
           FROM streams WHERE id = $1 FOR UPDATE
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
          WHERE id IN (
            SELECT id FROM locked
             WHERE status = ANY($2::text[])
               AND lifecycle_version IS DISTINCT FROM 1
          )
          RETURNING ${STREAM_COLUMNS}
       ), unfinished AS (
         UPDATE stream_renditions
            SET manifest_index = NULL,
                duration_seconds = NULL,
                updated_at = NOW()
          WHERE stream_id IN (
            SELECT id FROM locked
             WHERE status = 'vod' AND status = ANY($2::text[])
               AND lifecycle_version IS DISTINCT FROM 1
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
        WHERE id = $1
          AND status = ANY($2::text[])
          AND lifecycle_version IS DISTINCT FROM 1
        RETURNING ${STREAM_COLUMNS}`,
      [id, allowedFrom, manifestIndex, durationSeconds],
    );
    return this.one(result.rows, result.rowCount);
  }

  /**
   * Records a feed write that did not change the status: a republish of a
   * stream that is live or recorded, where the whole point is that it stays
   * where it is. A hidden managed recording gets a new `published_at` when
   * its owner restores it. Other entries keep the time they were announced.
   */
  async recordRepublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET published_at = CASE
                WHEN lifecycle_version = 1 THEN COALESCE(published_at, NOW())
                ELSE published_at
              END,
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
   *
   * The ABR ladder goes with it, in this one statement rather than through
   * StreamRenditionRepository: the rungs are part of what the uploader
   * reported, and a crash between two statements would leave a draft that
   * carries a ladder from a broadcast nobody can play any more onto the next
   * entry it is published with. The delete is scoped through `owned` so it
   * cannot touch another user's stream when the UPDATE itself would not.
   */
  async finishUnpublish(
    id: string,
    userId: string,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `WITH owned AS (
         SELECT id FROM streams WHERE id = $1 AND user_id = $2
       ), cleared AS (
         DELETE FROM stream_renditions
          WHERE stream_id IN (SELECT id FROM owned)
       )
       UPDATE streams
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

  async hideManagedFromCatalogue(
    id: string,
    userId: string,
  ): Promise<StreamRow | null> {
    const result = await this.pool.query<StreamRow>(
      `UPDATE streams
          SET published_at = NULL,
              published_feed_index = NULL,
              publish_error = NULL,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND lifecycle_version = 1
          AND EXISTS (
            SELECT 1 FROM stream_runs current_run
             WHERE current_run.stream_id = streams.id
               AND current_run.run_number = streams.current_run_number
               AND current_run.permission = 'closed'
               AND current_run.state IN ('closed', 'vod')
          )
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
    return rowCount && rowCount > 0 ? rows[0] : null;
  }
}
