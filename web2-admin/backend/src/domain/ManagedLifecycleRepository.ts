import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalManagedReportJson,
  type InternalCompletedRecordingSnapshot,
  ManagedClaimRequest,
  ManagedRunReport,
  ManagedRunView,
} from '@streaming-monorepo/web2-admin-common';
import type { Pool, PoolClient } from 'pg';

import {
  classifyManagedEvent,
  isManagedRunTransitionAllowed,
  ManagedLifecycleConflict,
} from './managedLifecycle.js';

interface ManagedRunDatabaseRow {
  lifecycle_version: number;
  lifecycle_revision: number;
  current_run_number: number;
  stream_id: string;
  run_number: number;
  revision: number;
  assigned_uploader_id: string;
  claim_id: string | null;
  claim_request_id: string | null;
  claim_request_digest: string | null;
  state: ManagedRunView['state'];
  permission: ManagedRunView['permission'];
  reconnect_deadline: Date | null;
  close_reason: ManagedRunView['closeReason'] | null;
  last_event_sequence: number | null;
  last_event_digest: string | null;
}

interface RecordingDatabaseRow {
  checkpoint_reference: string;
  master_topic: string;
  master_index: string | number;
  master_reference: string;
  duration_seconds: number;
}

interface ExpectedRenditionDatabaseRow {
  name: string;
}

interface RecordedRenditionDatabaseRow {
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

const RUN_SELECT = `
  SELECT stream.lifecycle_version, stream.lifecycle_revision,
         stream.current_run_number, run.stream_id, run.run_number,
         run.revision, run.assigned_uploader_id, run.claim_id,
         run.claim_request_id, run.claim_request_digest, run.state,
         run.permission, run.reconnect_deadline, run.close_reason
         , run.last_event_sequence, run.last_event_digest
    FROM streams stream
    JOIN stream_runs run
      ON run.stream_id = stream.id AND run.run_number = $2
   WHERE stream.id = $1`;

function claimDigest(request: ManagedClaimRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        lifecycleVersion: request.lifecycleVersion,
        expectedRevision: request.expectedRevision,
        uploaderId: request.uploaderId,
        requestId: request.requestId,
      }),
    )
    .digest('hex');
}

function reportDigest(report: ManagedRunReport): string {
  return createHash('sha256')
    .update(canonicalManagedReportJson(report))
    .digest('hex');
}

function toView(
  row: ManagedRunDatabaseRow,
  completedRecording?: InternalCompletedRecordingSnapshot,
): ManagedRunView {
  return {
    lifecycleVersion: 1,
    streamId: row.stream_id,
    runNumber: row.run_number,
    revision: row.lifecycle_revision,
    uploaderId: row.assigned_uploader_id,
    claimId: row.claim_id,
    state: row.state,
    permission: row.permission,
    ...(row.reconnect_deadline
      ? { reconnectDeadline: row.reconnect_deadline.toISOString() }
      : {}),
    ...(row.close_reason ? { closeReason: row.close_reason } : {}),
    ...(row.last_event_sequence != null && row.last_event_digest != null
      ? {
          lastAcceptedEvent: {
            sequence: Number(row.last_event_sequence),
            digest: row.last_event_digest,
          },
        }
      : {}),
    ...(completedRecording ? { completedRecording } : {}),
  };
}

export class ManagedLifecycleRepository {
  constructor(private readonly pool: Pool) {}

  async claim(
    streamId: string,
    runNumber: number,
    request: ManagedClaimRequest,
  ): Promise<ManagedRunView> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.lockRun(client, streamId, runNumber);
      this.requireCurrent(row, runNumber, request.uploaderId);

      if (row.permission === 'closed') {
        throw new ManagedLifecycleConflict('closed');
      }

      const digest = claimDigest(request);
      if (row.claim_request_id === request.requestId) {
        if (row.claim_request_digest !== digest) {
          throw new ManagedLifecycleConflict('request_conflict');
        }
        await client.query('COMMIT');
        return toView(row);
      }
      if (row.permission !== 'open') {
        throw new ManagedLifecycleConflict('revision_conflict');
      }
      if (row.lifecycle_revision !== request.expectedRevision) {
        throw new ManagedLifecycleConflict('revision_conflict');
      }

      const claimId = randomUUID();
      const revision = row.lifecycle_revision + 1;
      const claimed = await client.query<ManagedRunDatabaseRow>(
        `UPDATE stream_runs
            SET state = 'claimed', permission = 'claimed', claim_id = $3,
                claim_request_id = $4, claim_request_digest = $5,
                revision = $6
          WHERE stream_id = $1 AND run_number = $2
          RETURNING $6::bigint AS lifecycle_revision,
                    1::smallint AS lifecycle_version,
                    run_number AS current_run_number, stream_id, run_number,
                    revision, assigned_uploader_id, claim_id,
                    claim_request_id, claim_request_digest, state, permission,
                    reconnect_deadline, close_reason`,
        [streamId, runNumber, claimId, request.requestId, digest, revision],
      );
      await client.query(
        `UPDATE streams SET lifecycle_revision = $2, updated_at = NOW()
          WHERE id = $1`,
        [streamId, revision],
      );
      await client.query('COMMIT');
      return toView(claimed.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async readClaimedRun(
    streamId: string,
    runNumber: number,
    uploaderId: string,
    claimId: string,
  ): Promise<ManagedRunView> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.lockRun(client, streamId, runNumber);
      this.requireAssignedManagedRun(row, uploaderId);
      if (row.claim_id !== claimId) {
        throw new ManagedLifecycleConflict('assignment_mismatch');
      }
      const completedRecording = await this.readRecording(
        client,
        streamId,
        runNumber,
      );
      await client.query('COMMIT');
      return toView(row, completedRecording);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async report(
    streamId: string,
    runNumber: number,
    report: ManagedRunReport,
  ): Promise<ManagedRunView> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.lockRun(client, streamId, runNumber);
      this.requireCurrent(row, runNumber, report.uploaderId);
      if (row.claim_id !== report.claimId) {
        throw new ManagedLifecycleConflict('assignment_mismatch');
      }

      const digest = reportDigest(report);
      const disposition = classifyManagedEvent(
        row.last_event_sequence == null
          ? null
          : {
              sequence: Number(row.last_event_sequence),
              digest: row.last_event_digest!,
            },
        { sequence: report.eventSequence, digest },
      );
      if (disposition === 'duplicate') {
        await client.query('COMMIT');
        return toView(row);
      }
      if (!isManagedRunTransitionAllowed(row.state, report.state)) {
        throw new ManagedLifecycleConflict('event_conflict');
      }

      const revision = row.lifecycle_revision + 1;
      if (report.state === 'vod') {
        await this.storeRecording(client, streamId, runNumber, report);
      }
      const permission =
        report.state === 'closed' || report.state === 'vod'
          ? 'closed'
          : 'claimed';
      const updated = await client.query<ManagedRunDatabaseRow>(
        `UPDATE stream_runs
            SET state = $3, permission = $4, revision = $5,
                last_event_sequence = $6, last_event_digest = $7,
                last_observed_at = $8,
                reconnect_deadline = $9, close_reason = $10,
                empty_checkpoint_reference = $11,
                accepted_media_count = $12
          WHERE stream_id = $1 AND run_number = $2
          RETURNING $5::bigint AS lifecycle_revision,
                    1::smallint AS lifecycle_version,
                    run_number AS current_run_number, stream_id, run_number,
                    revision, assigned_uploader_id, claim_id,
                    claim_request_id, claim_request_digest, state, permission,
                    reconnect_deadline, close_reason,
                    last_event_sequence, last_event_digest`,
        [
          streamId,
          runNumber,
          report.state,
          permission,
          revision,
          report.eventSequence,
          digest,
          report.observedAt,
          report.state === 'waiting' ? report.reconnectDeadline : null,
          report.state === 'closed' ? report.reason : row.close_reason,
          report.state === 'closed'
            ? (report.emptyOutcome?.checkpointReference ?? null)
            : null,
          report.state === 'closed'
            ? (report.emptyOutcome?.acceptedMediaCount ?? null)
            : null,
        ],
      );
      const recording = report.state === 'vod' ? report.completedRecording : null;
      await client.query(
        `UPDATE streams
            SET lifecycle_revision = $2,
                completed_run_number = COALESCE($3, completed_run_number),
                status = CASE
                  WHEN $6 = 'live' THEN 'live'
                  WHEN $3 IS NOT NULL THEN 'vod'
                  ELSE status
                END,
                manifest_index = COALESCE($4, manifest_index),
                duration_seconds = COALESCE($5, duration_seconds),
                live_since = CASE
                  WHEN $6 = 'live' THEN COALESCE(live_since, NOW())
                  ELSE live_since
                END,
                ended_at = CASE WHEN $3 IS NULL THEN ended_at ELSE NOW() END,
                updated_at = NOW()
          WHERE id = $1`,
        [
          streamId,
          revision,
          recording?.runNumber ?? null,
          recording?.master.index ?? null,
          recording?.master.duration ?? null,
          report.state,
        ],
      );
      await client.query('COMMIT');
      return toView(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockRun(
    client: PoolClient,
    streamId: string,
    runNumber: number,
  ): Promise<ManagedRunDatabaseRow> {
    const result = await client.query<ManagedRunDatabaseRow>(
      `${RUN_SELECT} FOR UPDATE OF stream, run`,
      [streamId, runNumber],
    );
    const row = result.rows[0];
    if (!row) throw new ManagedLifecycleConflict('stale_run');
    return row;
  }

  private requireCurrent(
    row: ManagedRunDatabaseRow,
    runNumber: number,
    uploaderId: string,
  ): void {
    this.requireAssignedManagedRun(row, uploaderId);
    if (row.current_run_number !== runNumber) {
      throw new ManagedLifecycleConflict('stale_run');
    }
  }

  private requireAssignedManagedRun(
    row: ManagedRunDatabaseRow,
    uploaderId: string,
  ): void {
    if (row.lifecycle_version !== 1) {
      throw new ManagedLifecycleConflict('stale_run');
    }
    if (row.assigned_uploader_id !== uploaderId) {
      throw new ManagedLifecycleConflict('assignment_mismatch');
    }
  }

  private async storeRecording(
    client: PoolClient,
    streamId: string,
    runNumber: number,
    report: Extract<ManagedRunReport, { state: 'vod' }>,
  ): Promise<void> {
    const recording = report.completedRecording;
    if (recording.runNumber !== runNumber) {
      throw new ManagedLifecycleConflict('stale_run');
    }
    const expected = await client.query<{ name: string }>(
      `SELECT name FROM stream_run_expected_renditions
        WHERE stream_id = $1 AND run_number = $2 ORDER BY name`,
      [streamId, runNumber],
    );
    const expectedNames = expected.rows.map(({ name }) => name);
    const declaredNames = [...recording.expectedRenditions].sort();
    const recordedNames = recording.renditions.map(({ name }) => name).sort();
    if (
      JSON.stringify(expectedNames) !== JSON.stringify(declaredNames) ||
      JSON.stringify(expectedNames) !== JSON.stringify(recordedNames)
    ) {
      throw new ManagedLifecycleConflict('event_conflict');
    }
    await client.query(
      `INSERT INTO stream_run_recordings (
         stream_id, run_number, checkpoint_reference, master_topic,
         master_index, master_reference, duration_seconds
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        streamId,
        runNumber,
        recording.checkpointReference,
        recording.master.topic,
        recording.master.index,
        recording.master.reference,
        recording.master.duration,
      ],
    );
    for (const rendition of recording.renditions) {
      await client.query(
        `INSERT INTO stream_run_recording_renditions (
           stream_id, run_number, name, topic, manifest_index, reference,
           duration_seconds, width, height, bandwidth, avg_bandwidth
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          streamId,
          runNumber,
          rendition.name,
          rendition.topic,
          rendition.index,
          rendition.reference,
          rendition.duration,
          rendition.width,
          rendition.height,
          rendition.bandwidth,
          rendition.avgBandwidth,
        ],
      );
    }
  }

  private async readRecording(
    client: PoolClient,
    streamId: string,
    runNumber: number,
  ): Promise<InternalCompletedRecordingSnapshot | undefined> {
    const recordingResult = await client.query<RecordingDatabaseRow>(
      `SELECT checkpoint_reference, master_topic, master_index,
              master_reference, duration_seconds
         FROM stream_run_recordings
        WHERE stream_id = $1 AND run_number = $2`,
      [streamId, runNumber],
    );
    const recording = recordingResult.rows[0];
    if (!recording) return undefined;

    const expectedResult = await client.query<ExpectedRenditionDatabaseRow>(
      `SELECT name
         FROM stream_run_expected_renditions
        WHERE stream_id = $1 AND run_number = $2
        ORDER BY name`,
      [streamId, runNumber],
    );
    const renditionsResult = await client.query<RecordedRenditionDatabaseRow>(
      `SELECT name, topic, manifest_index, reference, duration_seconds,
              width, height, bandwidth, avg_bandwidth
         FROM stream_run_recording_renditions
        WHERE stream_id = $1 AND run_number = $2
        ORDER BY name`,
      [streamId, runNumber],
    );

    return {
      runNumber,
      checkpointReference: recording.checkpoint_reference,
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
}
