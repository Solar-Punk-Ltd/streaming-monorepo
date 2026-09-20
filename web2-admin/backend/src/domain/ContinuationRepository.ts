import { createHash, randomUUID } from 'node:crypto';

import type {
  ContinuationCreateRequest,
  ContinuationOperation,
  ContinuationPreparationRequest,
  InternalCompletedRecordingSnapshot,
  MediaType,
} from '@streaming-monorepo/web2-admin-common';
import type { Pool, PoolClient } from 'pg';

import { StreamNotFoundError } from './errors/index.js';
import { ManagedLifecycleConflict } from './managedLifecycle.js';

interface CurrentStreamRow {
  topic: string;
  media_type: MediaType;
  lifecycle_version: number | null;
  lifecycle_revision: number;
  current_run_number: number;
  completed_run_number: number | null;
  state: string;
  permission: string;
  assigned_uploader_id: string;
  close_reason: string | null;
  empty_checkpoint_reference: string | null;
  accepted_media_count: number | null;
}

type LockedStreamRow = Omit<
  CurrentStreamRow,
  | 'state'
  | 'permission'
  | 'assigned_uploader_id'
  | 'close_reason'
  | 'empty_checkpoint_reference'
  | 'accepted_media_count'
>;

type LockedRunRow = Pick<
  CurrentStreamRow,
  | 'state'
  | 'permission'
  | 'assigned_uploader_id'
  | 'close_reason'
  | 'empty_checkpoint_reference'
  | 'accepted_media_count'
>;

interface OperationRow {
  operation_id: string;
  request_id: string;
  stream_id: string;
  topic: string;
  media_type: MediaType;
  assigned_uploader_id: string;
  previous_run_number: number;
  next_run_number: number;
  retained_run_number: number | null;
  revision: number;
  status: ContinuationOperation['status'];
  checkpoint_reference: string | null;
  failure: string | null;
  request_digest: string;
}

interface RecordingRow {
  checkpoint_reference: string;
  master_topic: string;
  master_index: number;
  master_reference: string;
  duration_seconds: number;
}

interface RenditionRow {
  name: string;
  topic: string;
  manifest_index: number;
  reference: string;
  duration_seconds: number;
  width: number;
  height: number;
  bandwidth: number;
  avg_bandwidth: number;
}

interface EmptyOutcomeRow {
  empty_checkpoint_reference: string;
  accepted_media_count: 0;
}

const OPERATION_SELECT = `
  SELECT operation.operation_id, operation.request_id, operation.stream_id,
         stream.topic, stream.media_type, operation.assigned_uploader_id,
         operation.previous_run_number, operation.next_run_number,
         operation.retained_run_number, operation.revision, operation.status,
         operation.checkpoint_reference, operation.failure,
         operation.request_digest
    FROM continuation_operations operation
    JOIN streams stream ON stream.id = operation.stream_id`;

function requestDigest(request: ContinuationCreateRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        expectedRevision: request.expectedRevision,
        requestId: request.requestId,
      }),
    )
    .digest('hex');
}

export class ContinuationRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    streamId: string,
    ownerId: string,
    request: ContinuationCreateRequest,
  ): Promise<ContinuationOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stream = await this.lockOwnedStream(client, streamId, ownerId);
      const existing = await this.findByRequest(client, streamId, request.requestId);
      const digest = requestDigest(request);
      if (existing) {
        if (existing.request_digest !== digest) {
          throw new ManagedLifecycleConflict('request_conflict');
        }
        const operation = await this.toOperation(client, existing);
        await client.query('COMMIT');
        return operation;
      }
      if (
        stream.lifecycle_version !== 1 ||
        stream.lifecycle_revision !== request.expectedRevision
      ) {
        throw new ManagedLifecycleConflict('revision_conflict');
      }
      const canContinueVod =
        stream.state === 'vod' && stream.permission === 'closed';
      const canContinueEmpty =
        stream.state === 'closed' &&
        stream.permission === 'closed' &&
        stream.close_reason === 'empty' &&
        stream.empty_checkpoint_reference !== null &&
        stream.accepted_media_count === 0;
      if (!canContinueVod && !canContinueEmpty) {
        throw new ManagedLifecycleConflict('closed');
      }
      const unresolved = await client.query(
        `SELECT 1 FROM continuation_operations
          WHERE stream_id = $1 AND status IN ('pending', 'ready')`,
        [streamId],
      );
      if ((unresolved.rowCount ?? 0) > 0) {
        throw new ManagedLifecycleConflict('revision_conflict');
      }
      const allocation = await client.query<{ next_run_number: number }>(
        `SELECT GREATEST(
                  $2::int,
                  COALESCE(MAX(next_run_number), $2::int)
                ) + 1 AS next_run_number
           FROM continuation_operations
          WHERE stream_id = $1`,
        [streamId, stream.current_run_number],
      );
      const nextRunNumber = allocation.rows[0].next_run_number;
      const alreadyAllocated = await client.query(
        `SELECT 1 FROM continuation_operations
          WHERE stream_id = $1 AND next_run_number = $2`,
        [streamId, nextRunNumber],
      );
      if ((alreadyAllocated.rowCount ?? 0) > 0) {
        throw new ManagedLifecycleConflict('revision_conflict');
      }

      const revision = stream.lifecycle_revision + 1;
      const operationId = randomUUID();
      await client.query(
        `INSERT INTO continuation_operations (
           operation_id, stream_id, request_id, request_digest,
           assigned_uploader_id, previous_run_number, next_run_number,
           retained_run_number, revision, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
        [
          operationId,
          streamId,
          request.requestId,
          digest,
          stream.assigned_uploader_id,
          stream.current_run_number,
          nextRunNumber,
          stream.completed_run_number,
          revision,
        ],
      );
      await client.query(
        `UPDATE streams SET lifecycle_revision = $2, updated_at = NOW()
          WHERE id = $1`,
        [streamId, revision],
      );
      const row = await this.lockOperation(client, streamId, operationId);
      const operation = await this.toOperation(client, row);
      await client.query('COMMIT');
      return operation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(
    streamId: string,
    operationId: string,
    ownerId: string,
  ): Promise<ContinuationOperation> {
    const client = await this.pool.connect();
    try {
      const row = await client.query<OperationRow>(
        `${OPERATION_SELECT}
          WHERE operation.stream_id = $1
            AND operation.operation_id = $2
            AND stream.user_id = $3`,
        [streamId, operationId, ownerId],
      );
      if (!row.rows[0]) throw new StreamNotFoundError(streamId);
      return await this.toOperation(client, row.rows[0]);
    } finally {
      client.release();
    }
  }

  async getCurrent(
    streamId: string,
    ownerId: string,
  ): Promise<ContinuationOperation | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<OperationRow>(
        `${OPERATION_SELECT}
          WHERE operation.stream_id = $1
            AND stream.user_id = $2
            AND (
              operation.status IN ('pending', 'ready')
              OR (
                operation.status = 'claimed'
                AND EXISTS (
                  SELECT 1 FROM stream_runs run
                   WHERE run.stream_id = operation.stream_id
                     AND run.run_number = operation.next_run_number
                     AND run.permission = 'claimed'
                )
              )
            )
          ORDER BY operation.next_run_number DESC
          LIMIT 1`,
        [streamId, ownerId],
      );
      return result.rows[0] ? await this.toOperation(client, result.rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async listPending(uploaderId: string): Promise<ContinuationOperation[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<OperationRow>(
        `${OPERATION_SELECT}
          WHERE operation.assigned_uploader_id = $1
            AND operation.status = 'pending'
          ORDER BY operation.created_at, operation.operation_id`,
        [uploaderId],
      );
      const operations = [];
      for (const row of result.rows) {
        operations.push(await this.toOperation(client, row));
      }
      await client.query('COMMIT');
      return operations;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async prepare(
    streamId: string,
    operationId: string,
    request: ContinuationPreparationRequest,
  ): Promise<ContinuationOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.lockOperationWithStream(client, streamId, operationId);
      if (row.assigned_uploader_id !== request.uploaderId) {
        throw new ManagedLifecycleConflict('assignment_mismatch');
      }
      if (this.isPreparationRetry(row, request)) {
        const operation = await this.toOperation(client, row);
        await client.query('COMMIT');
        return operation;
      }
      if (row.status !== 'pending') {
        throw new ManagedLifecycleConflict('closed');
      }
      if (row.revision !== request.expectedRevision) {
        throw new ManagedLifecycleConflict('revision_conflict');
      }
      const revision = row.revision + 1;
      if (request.status === 'failed') {
        await client.query(
          `UPDATE continuation_operations
              SET status = 'failed', failure = $3, revision = $4
            WHERE stream_id = $1 AND operation_id = $2`,
          [streamId, operationId, request.failure, revision],
        );
      } else {
        await client.query(
          `INSERT INTO stream_runs (
             stream_id, run_number, state, permission, assigned_uploader_id,
             revision
           ) VALUES ($1, $2, 'ready', 'open', $3, $4)`,
          [streamId, row.next_run_number, request.uploaderId, revision],
        );
        await client.query(
          `INSERT INTO stream_run_expected_renditions (
             stream_id, run_number, name, topic, width, height, bandwidth,
             avg_bandwidth
           )
           SELECT stream_id, $3, name, topic, width, height, bandwidth,
                  avg_bandwidth
             FROM stream_run_expected_renditions
            WHERE stream_id = $1 AND run_number = $2`,
          [streamId, row.previous_run_number, row.next_run_number],
        );
        await client.query(
          `UPDATE continuation_operations
              SET status = 'ready', checkpoint_reference = $3, revision = $4
            WHERE stream_id = $1 AND operation_id = $2`,
          [streamId, operationId, request.checkpointReference, revision],
        );
        await client.query(
          `UPDATE streams
              SET current_run_number = $2, lifecycle_revision = $3,
                  updated_at = NOW()
            WHERE id = $1`,
          [streamId, row.next_run_number, revision],
        );
      }
      if (request.status === 'failed') {
        await client.query(
          `UPDATE streams SET lifecycle_revision = $2, updated_at = NOW()
            WHERE id = $1`,
          [streamId, revision],
        );
      }
      const updated = await this.lockOperation(client, streamId, operationId);
      const operation = await this.toOperation(client, updated);
      await client.query('COMMIT');
      return operation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(
    streamId: string,
    operationId: string,
    ownerId: string,
  ): Promise<ContinuationOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockOwnedStream(client, streamId, ownerId);
      const row = await this.lockOperation(client, streamId, operationId);
      if (row.status === 'cancelled') {
        const operation = await this.toOperation(client, row);
        await client.query('COMMIT');
        return operation;
      }
      if (row.status !== 'pending' && row.status !== 'ready') {
        throw new ManagedLifecycleConflict('closed');
      }
      const revision = row.revision + 1;
      if (row.status === 'ready') {
        if (row.checkpoint_reference === null) {
          throw new ManagedLifecycleConflict('closed');
        }
        const closed = await client.query(
          `UPDATE stream_runs
              SET state = 'closed', permission = 'closed',
                  close_reason = 'empty', empty_checkpoint_reference = $3,
                  accepted_media_count = 0, revision = $4
            WHERE stream_id = $1 AND run_number = $2
              AND permission = 'open' AND claim_id IS NULL`,
          [
            streamId,
            row.next_run_number,
            row.checkpoint_reference,
            revision,
          ],
        );
        if ((closed.rowCount ?? 0) !== 1) {
          throw new ManagedLifecycleConflict('closed');
        }
      }
      await client.query(
        `UPDATE continuation_operations
            SET status = 'cancelled', revision = $3
          WHERE stream_id = $1 AND operation_id = $2`,
        [streamId, operationId, revision],
      );
      await client.query(
        `UPDATE streams SET lifecycle_revision = $2, updated_at = NOW()
          WHERE id = $1`,
        [streamId, revision],
      );
      const updated = await this.lockOperation(client, streamId, operationId);
      const operation = await this.toOperation(client, updated);
      await client.query('COMMIT');
      return operation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockOwnedStream(
    client: PoolClient,
    streamId: string,
    ownerId: string,
  ): Promise<CurrentStreamRow> {
    const streamResult = await client.query<LockedStreamRow>(
      `SELECT stream.topic, stream.media_type, stream.lifecycle_version,
              stream.lifecycle_revision, stream.current_run_number,
              stream.completed_run_number
         FROM streams stream
        WHERE stream.id = $1 AND stream.user_id = $2
        FOR UPDATE /* continuation_lock_owned_stream */`,
      [streamId, ownerId],
    );
    const stream = streamResult.rows[0];
    if (!stream) throw new StreamNotFoundError(streamId);
    const runResult = await client.query<LockedRunRow>(
      `SELECT state, permission, assigned_uploader_id, close_reason,
              empty_checkpoint_reference, accepted_media_count
         FROM stream_runs
        WHERE stream_id = $1 AND run_number = $2
        FOR UPDATE`,
      [streamId, stream.current_run_number],
    );
    const run = runResult.rows[0];
    if (!run) throw new ManagedLifecycleConflict('stale_run');
    return { ...stream, ...run };
  }

  private async findByRequest(
    client: PoolClient,
    streamId: string,
    requestId: string,
  ): Promise<OperationRow | undefined> {
    const result = await client.query<OperationRow>(
      `${OPERATION_SELECT}
        WHERE operation.stream_id = $1 AND operation.request_id = $2`,
      [streamId, requestId],
    );
    return result.rows[0];
  }

  private async lockOperation(
    client: PoolClient,
    streamId: string,
    operationId: string,
  ): Promise<OperationRow> {
    const result = await client.query<OperationRow>(
      `${OPERATION_SELECT}
        WHERE operation.stream_id = $1 AND operation.operation_id = $2
        FOR UPDATE OF operation`,
      [streamId, operationId],
    );
    if (!result.rows[0]) throw new ManagedLifecycleConflict('stale_run');
    return result.rows[0];
  }

  private async lockOperationWithStream(
    client: PoolClient,
    streamId: string,
    operationId: string,
  ): Promise<OperationRow> {
    const result = await client.query<OperationRow>(
      `${OPERATION_SELECT}
        WHERE operation.stream_id = $1 AND operation.operation_id = $2
        FOR UPDATE OF stream, operation`,
      [streamId, operationId],
    );
    if (!result.rows[0]) throw new ManagedLifecycleConflict('stale_run');
    return result.rows[0];
  }

  private isPreparationRetry(
    row: OperationRow,
    request: ContinuationPreparationRequest,
  ): boolean {
    if (request.expectedRevision !== row.revision - 1) return false;
    if (request.status === 'ready') {
      return (
        row.status === 'ready' &&
        row.checkpoint_reference === request.checkpointReference
      );
    }
    return row.status === 'failed' && row.failure === request.failure;
  }

  private async toOperation(
    client: PoolClient,
    row: OperationRow,
  ): Promise<ContinuationOperation> {
    const retainedRecording =
      row.retained_run_number === null
        ? undefined
        : await this.readRecording(client, row.stream_id, row.retained_run_number);
    const previousEmptyOutcome = await this.readEmptyOutcome(
      client,
      row.stream_id,
      row.previous_run_number,
    );
    return {
      lifecycleVersion: 1,
      operationId: row.operation_id,
      requestId: row.request_id,
      streamId: row.stream_id,
      topic: row.topic,
      mediaType: row.media_type,
      uploaderId: row.assigned_uploader_id,
      previousRunNumber: row.previous_run_number,
      nextRunNumber: row.next_run_number,
      revision: row.revision,
      status: row.status,
      ...(retainedRecording ? { retainedRecording } : {}),
      ...(previousEmptyOutcome ? { previousEmptyOutcome } : {}),
      ...(row.failure ? { failure: row.failure } : {}),
    };
  }

  private async readEmptyOutcome(
    client: PoolClient,
    streamId: string,
    runNumber: number,
  ): Promise<ContinuationOperation['previousEmptyOutcome']> {
    const result = await client.query<EmptyOutcomeRow>(
      `SELECT empty_checkpoint_reference, accepted_media_count
         FROM stream_runs
        WHERE stream_id = $1 AND run_number = $2
          AND state = 'closed' AND permission = 'closed'
          AND close_reason = 'empty'
          AND empty_checkpoint_reference IS NOT NULL
          AND accepted_media_count = 0`,
      [streamId, runNumber],
    );
    const outcome = result.rows[0];
    if (!outcome) return undefined;
    return {
      runNumber,
      checkpointReference: outcome.empty_checkpoint_reference,
      acceptedMediaCount: outcome.accepted_media_count,
    };
  }

  private async readRecording(
    client: PoolClient,
    streamId: string,
    runNumber: number,
  ): Promise<InternalCompletedRecordingSnapshot | undefined> {
    const recordingResult = await client.query<RecordingRow>(
      `SELECT checkpoint_reference, master_topic, master_index,
              master_reference, duration_seconds
         FROM stream_run_recordings
        WHERE stream_id = $1 AND run_number = $2`,
      [streamId, runNumber],
    );
    const recording = recordingResult.rows[0];
    if (!recording) return undefined;
    const expected = await client.query<{ name: string }>(
      `SELECT name FROM stream_run_expected_renditions
        WHERE stream_id = $1 AND run_number = $2 ORDER BY name`,
      [streamId, runNumber],
    );
    const renditions = await client.query<RenditionRow>(
      `SELECT name, topic, manifest_index, reference, duration_seconds,
              width, height, bandwidth, avg_bandwidth
         FROM stream_run_recording_renditions
        WHERE stream_id = $1 AND run_number = $2 ORDER BY name`,
      [streamId, runNumber],
    );
    return {
      runNumber,
      checkpointReference: recording.checkpoint_reference,
      master: {
        topic: recording.master_topic,
        index: recording.master_index,
        reference: recording.master_reference,
        duration: recording.duration_seconds,
      },
      expectedRenditions: expected.rows.map(({ name }) => name),
      renditions: renditions.rows.map((rendition) => ({
        name: rendition.name,
        topic: rendition.topic,
        index: rendition.manifest_index,
        reference: rendition.reference,
        duration: rendition.duration_seconds,
        width: rendition.width,
        height: rendition.height,
        bandwidth: rendition.bandwidth,
        avgBandwidth: rendition.avg_bandwidth,
      })),
    };
  }
}
