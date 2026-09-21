import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalLegacyRecordingCandidateJson,
  type LegacyAdoptionCreateRequest,
  type LegacyAdoptionOperation,
  type LegacyAdoptionPreparationRequest,
  type LegacyAdoptionValidation,
  type LegacyMediaFormatTrack,
  type LegacyRecordingCandidate,
  type MediaType,
  type UploaderMediaProfile,
} from '@streaming-monorepo/web2-admin-common';
import type { Pool, PoolClient } from 'pg';

import { ManagedEnrollmentUnavailableError, StreamNotFoundError } from './errors/index.js';
import type { ManagedEnrollmentReadiness } from './ManagedEnrollmentReadiness.js';
import { ManagedLifecycleConflict } from './managedLifecycle.js';
import { managedRungTopicFor } from './managedRungTopic.js';

interface LockedStreamRow {
  id: string;
  topic: string;
  media_type: MediaType;
  status: string;
  lifecycle_version: number | null;
  manifest_index: number | null;
  duration_seconds: number | null;
}

interface LegacyRenditionRow {
  name: string;
  topic: string;
  manifest_index: number | null;
  duration_seconds: number | null;
  width: number;
  height: number;
  bandwidth: number;
  avg_bandwidth: number;
}

interface OperationRow {
  operation_id: string;
  request_id: string;
  stream_id: string;
  topic: string;
  media_type: MediaType;
  assigned_uploader_id: string;
  candidate_digest: string;
  candidate: LegacyRecordingCandidate;
  profile_digest: string;
  revision: number;
  status: LegacyAdoptionOperation['status'];
  preparation_digest: string | null;
  completed_recording: LegacyAdoptionOperation['completedRecording'] | null;
  validation: LegacyAdoptionValidation | null;
  failure: string | null;
  request_digest: string;
}

const OPERATION_SELECT = `
  SELECT operation.operation_id, operation.request_id, operation.stream_id,
         stream.topic, stream.media_type, operation.assigned_uploader_id,
         operation.candidate_digest, operation.candidate,
         operation.profile_digest, operation.revision, operation.status,
         operation.preparation_digest, operation.completed_recording,
         operation.validation, operation.failure, operation.request_digest
    FROM legacy_adoption_operations operation
    JOIN streams stream ON stream.id = operation.stream_id`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function preparationDigest(request: LegacyAdoptionPreparationRequest): string {
  return sha256(JSON.stringify(canonicalValue(request)));
}

function requestDigest(request: LegacyAdoptionCreateRequest): string {
  return sha256(JSON.stringify(canonicalValue(request)));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function compareTracks(left: LegacyMediaFormatTrack, right: LegacyMediaFormatTrack): number {
  if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
  const leftValue = JSON.stringify(canonicalValue(left));
  const rightValue = JSON.stringify(canonicalValue(right));
  return leftValue.localeCompare(rightValue);
}

export interface LegacyAdoptionPreview {
  candidate: LegacyRecordingCandidate;
  candidateDigest: string;
}

export class LegacyAdoptionRepository {
  constructor(
    private readonly pool: Pool,
    private readonly readiness: ManagedEnrollmentReadiness,
    private readonly uploaderId: string,
  ) {}

  async preview(streamId: string, ownerId: string): Promise<LegacyAdoptionPreview> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stream = await this.lockOwnedStream(client, streamId, ownerId);
      const proof = await this.readiness.requireAfterStreamLock(
        client,
        streamId,
        stream.media_type,
      );
      const candidate = await this.readCandidate(client, stream);
      this.assertProfileCompatible(candidate, proof.profile);
      await client.query('COMMIT');
      return {
        candidate,
        candidateDigest: sha256(canonicalLegacyRecordingCandidateJson(candidate)),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async create(
    streamId: string,
    ownerId: string,
    request: LegacyAdoptionCreateRequest,
  ): Promise<LegacyAdoptionOperation> {
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
        await client.query('COMMIT');
        return this.toOperation(existing);
      }
      const proof = await this.readiness.requireAfterStreamLock(
        client,
        streamId,
        stream.media_type,
      );
      const candidate = await this.readCandidate(client, stream);
      this.assertProfileCompatible(candidate, proof.profile);
      const candidateDigest = sha256(canonicalLegacyRecordingCandidateJson(candidate));
      if (candidateDigest !== request.expectedCandidateDigest) {
        throw new ManagedLifecycleConflict('candidate_changed');
      }
      const unresolved = await client.query(
        `SELECT 1 FROM legacy_adoption_operations
          WHERE stream_id = $1 AND status = 'pending'`,
        [streamId],
      );
      if ((unresolved.rowCount ?? 0) > 0) {
        throw new ManagedLifecycleConflict('revision_conflict');
      }
      const operationId = randomUUID();
      await client.query(
        `INSERT INTO legacy_adoption_operations (
           operation_id, stream_id, request_id, request_digest,
           assigned_uploader_id, candidate_digest, candidate, profile_digest,
           revision, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'pending')`,
        [
          operationId,
          streamId,
          request.requestId,
          digest,
          this.uploaderId,
          candidateDigest,
          candidate,
          proof.profileDigest,
        ],
      );
      const operation = await this.lockOperation(client, streamId, operationId);
      await client.query('COMMIT');
      return this.toOperation(operation);
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
  ): Promise<LegacyAdoptionOperation> {
    const result = await this.pool.query<OperationRow>(
      `${OPERATION_SELECT}
        WHERE operation.stream_id = $1 AND operation.operation_id = $2
          AND stream.user_id = $3`,
      [streamId, operationId, ownerId],
    );
    const row = result.rows[0];
    if (!row) throw new StreamNotFoundError(streamId);
    return this.toOperation(row);
  }

  async getCurrent(
    streamId: string,
    ownerId: string,
  ): Promise<LegacyAdoptionOperation | null> {
    const result = await this.pool.query<OperationRow>(
      `${OPERATION_SELECT}
        WHERE operation.stream_id = $1 AND stream.user_id = $2
        ORDER BY operation.created_at DESC LIMIT 1`,
      [streamId, ownerId],
    );
    const row = result.rows[0];
    return row && (row.status === 'pending' || row.status === 'failed')
      ? this.toOperation(row)
      : null;
  }

  async listPending(uploaderId: string): Promise<LegacyAdoptionOperation[]> {
    const result = await this.pool.query<OperationRow>(
      `${OPERATION_SELECT}
        WHERE operation.assigned_uploader_id = $1 AND operation.status = 'pending'
        ORDER BY operation.created_at`,
      [uploaderId],
    );
    return result.rows.map((row) => this.toOperation(row));
  }

  async cancel(
    streamId: string,
    operationId: string,
    ownerId: string,
  ): Promise<LegacyAdoptionOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockOwnedStream(client, streamId, ownerId);
      const row = await this.lockOperation(client, streamId, operationId);
      if (row.status === 'cancelled') {
        await client.query('COMMIT');
        return this.toOperation(row);
      }
      if (row.status !== 'pending') throw new ManagedLifecycleConflict('closed');
      await client.query(
        `UPDATE legacy_adoption_operations
            SET status = 'cancelled', revision = revision + 1
          WHERE operation_id = $1`,
        [operationId],
      );
      const cancelled = await this.lockOperation(client, streamId, operationId);
      await client.query('COMMIT');
      return this.toOperation(cancelled);
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
    request: LegacyAdoptionPreparationRequest,
  ): Promise<LegacyAdoptionOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stream = await this.lockStream(client, streamId);
      const row = await this.lockOperation(client, streamId, operationId);
      if (
        request.uploaderId !== row.assigned_uploader_id ||
        request.candidateDigest !== row.candidate_digest
      ) {
        throw new ManagedLifecycleConflict('assignment_mismatch');
      }
      const digest = preparationDigest(request);
      if (row.status !== 'pending') {
        if (
          (row.status === 'committed' || row.status === 'failed') &&
          row.preparation_digest === digest
        ) {
          await client.query('COMMIT');
          return this.toOperation(row);
        }
        throw new ManagedLifecycleConflict(
          row.status === 'cancelled' ? 'closed' : 'event_conflict',
        );
      }
      if (request.expectedRevision !== row.revision) {
        throw new ManagedLifecycleConflict('revision_conflict');
      }
      if (request.status === 'failed') {
        await client.query(
          `UPDATE legacy_adoption_operations
              SET status = 'failed', revision = revision + 1,
                  preparation_digest = $2, failure = $3
            WHERE operation_id = $1`,
          [operationId, digest, request.failure],
        );
        const failed = await this.lockOperation(client, streamId, operationId);
        await client.query('COMMIT');
        return this.toOperation(failed);
      }

      if (stream.lifecycle_version !== null) {
        throw new ManagedLifecycleConflict('candidate_changed');
      }
      const candidate = await this.readCandidate(client, stream);
      const currentDigest = sha256(canonicalLegacyRecordingCandidateJson(candidate));
      if (
        currentDigest !== row.candidate_digest ||
        !sameValue(candidate, row.candidate)
      ) {
        throw new ManagedLifecycleConflict('candidate_changed');
      }
      const proof = await this.readiness.requireAfterStreamLock(
        client,
        streamId,
        stream.media_type,
      );
      if (proof.profileDigest !== row.profile_digest) {
        throw new ManagedEnrollmentUnavailableError(
          streamId,
          'uploader_profile_changed',
        );
      }
      this.assertProfileCompatible(candidate, proof.profile);
      this.assertReadyProof(candidate, request);

      await client.query(
        `INSERT INTO stream_runs (
           stream_id, run_number, state, permission, assigned_uploader_id,
           revision, close_reason
         ) VALUES ($1, 1, 'closed', 'closed', $2, 1, 'adopted')`,
        [streamId, this.uploaderId],
      );
      for (const rung of [...proof.profile.renditions].sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        await client.query(
          `INSERT INTO stream_run_expected_renditions (
             stream_id, run_number, name, topic, width, height, bandwidth,
             avg_bandwidth
           ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
          [
            streamId,
            rung.name,
            managedRungTopicFor(stream.topic, rung.name),
            rung.width,
            rung.height,
            rung.bandwidth,
            rung.avgBandwidth,
          ],
        );
      }
      const recording = request.completedRecording;
      await client.query(
        `INSERT INTO stream_run_recordings (
           stream_id, run_number, checkpoint_reference, master_topic,
           master_index, master_reference, duration_seconds
         ) VALUES ($1, 1, $2, $3, $4, $5, $6)`,
        [
          streamId,
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
           ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            streamId,
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
      await client.query(
        `UPDATE stream_runs SET state = 'vod'
          WHERE stream_id = $1 AND run_number = 1`,
        [streamId],
      );
      await client.query(
        `UPDATE streams
            SET lifecycle_version = 1, lifecycle_revision = 1,
                current_run_number = 1, completed_run_number = 1,
                enrollment_profile_digest = $2, updated_at = NOW()
          WHERE id = $1`,
        [streamId, proof.profileDigest],
      );
      await client.query(
        `UPDATE legacy_adoption_operations
            SET status = 'committed', revision = revision + 1,
                preparation_digest = $2, completed_recording = $3,
                validation = $4
          WHERE operation_id = $1`,
        [operationId, digest, recording, request.validation],
      );
      const committed = await this.lockOperation(client, streamId, operationId);
      await client.query('COMMIT');
      return this.toOperation(committed);
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
  ): Promise<LockedStreamRow> {
    const result = await client.query<LockedStreamRow>(
      `SELECT id, topic, media_type, status, lifecycle_version,
              manifest_index, duration_seconds
         FROM streams WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [streamId, ownerId],
    );
    const row = result.rows[0];
    if (!row) throw new StreamNotFoundError(streamId);
    return row;
  }

  private async lockStream(
    client: PoolClient,
    streamId: string,
  ): Promise<LockedStreamRow> {
    const result = await client.query<LockedStreamRow>(
      `SELECT id, topic, media_type, status, lifecycle_version,
              manifest_index, duration_seconds
         FROM streams WHERE id = $1 FOR UPDATE`,
      [streamId],
    );
    const row = result.rows[0];
    if (!row) throw new StreamNotFoundError(streamId);
    return row;
  }

  private async readCandidate(
    client: PoolClient,
    stream: LockedStreamRow,
  ): Promise<LegacyRecordingCandidate> {
    if (
      stream.lifecycle_version !== null ||
      stream.status !== 'vod' ||
      stream.manifest_index === null ||
      stream.duration_seconds === null
    ) {
      throw new ManagedLifecycleConflict('closed');
    }
    const result = await client.query<LegacyRenditionRow>(
      `SELECT name, topic, manifest_index, duration_seconds, width, height,
              bandwidth, avg_bandwidth
         FROM stream_renditions WHERE stream_id = $1 ORDER BY name, topic`,
      [stream.id],
    );
    if (
      result.rows.some(
        ({ manifest_index, duration_seconds }) =>
          manifest_index === null || duration_seconds === null,
      )
    ) {
      throw new ManagedLifecycleConflict('closed');
    }
    return {
      streamId: stream.id,
      topic: stream.topic,
      mediaType: stream.media_type,
      master: {
        topic: stream.topic,
        index: stream.manifest_index,
        duration: stream.duration_seconds,
      },
      renditions: result.rows.map((row) => ({
        name: row.name,
        topic: row.topic,
        index: row.manifest_index!,
        duration: row.duration_seconds!,
        width: row.width,
        height: row.height,
        bandwidth: row.bandwidth,
        avgBandwidth: row.avg_bandwidth,
      })),
    };
  }

  private assertProfileCompatible(
    candidate: LegacyRecordingCandidate,
    profile: UploaderMediaProfile,
  ): void {
    const expected = [...profile.renditions].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    if (candidate.renditions.length !== expected.length) {
      throw new ManagedLifecycleConflict('candidate_changed');
    }
    for (let index = 0; index < expected.length; index += 1) {
      const actual = candidate.renditions[index];
      const configured = expected[index];
      if (
        actual.name !== configured.name ||
        actual.topic !== managedRungTopicFor(candidate.topic, configured.name) ||
        actual.width !== configured.width ||
        actual.height !== configured.height
      ) {
        throw new ManagedLifecycleConflict('candidate_changed');
      }
    }
  }

  private assertReadyProof(
    candidate: LegacyRecordingCandidate,
    request: Extract<LegacyAdoptionPreparationRequest, { status: 'ready' }>,
  ): void {
    const recording = request.completedRecording;
    if (
      recording.runNumber !== 1 ||
      !sameValue(recording.master, {
        ...candidate.master,
        reference: recording.master.reference,
      })
    ) {
      throw new ManagedLifecycleConflict('assignment_mismatch');
    }
    const names = candidate.renditions.map(({ name }) => name).sort();
    if (
      !sameValue([...recording.expectedRenditions].sort(), names) ||
      recording.renditions.length !== candidate.renditions.length
    ) {
      throw new ManagedLifecycleConflict('assignment_mismatch');
    }
    for (const expected of candidate.renditions) {
      const actual = recording.renditions.find(({ name }) => name === expected.name);
      if (!actual || !sameValue(actual, { ...expected, reference: actual.reference })) {
        throw new ManagedLifecycleConflict('assignment_mismatch');
      }
    }

    const expectedTopics = (
      candidate.renditions.length > 0
        ? candidate.renditions.map(({ topic }) => topic)
        : [candidate.master.topic]
    ).sort();
    const validation = request.validation;
    const topics = validation.tracks.map(({ topic }) => topic);
    if (
      validation.version !== 1 ||
      validation.mediaReadable !== true ||
      validation.pendingWrites !== 0 ||
      !sameValue(topics, [...topics].sort()) ||
      new Set(topics).size !== topics.length ||
      !sameValue(topics, expectedTopics)
    ) {
      throw new ManagedLifecycleConflict('assignment_mismatch');
    }
    for (const track of validation.tracks) {
      const expectedRendition = candidate.renditions.find(
        ({ topic }) => topic === track.topic,
      );
      const fingerprint = track.formatFingerprint;
      if (
        fingerprint.version !== 1 ||
        fingerprint.container !== 'mpegts' ||
        fingerprint.tracks.length === 0 ||
        !sameValue(fingerprint.tracks, [...fingerprint.tracks].sort(compareTracks))
      ) {
        throw new ManagedLifecycleConflict('assignment_mismatch');
      }
      if (candidate.mediaType === 'video') {
        const video = fingerprint.tracks.find(
          (mediaTrack): mediaTrack is Extract<LegacyMediaFormatTrack, { kind: 'video' }> =>
            mediaTrack.kind === 'video',
        );
        if (
          !video ||
          (expectedRendition !== undefined &&
            (video.width !== expectedRendition.width ||
              video.height !== expectedRendition.height))
        ) {
          throw new ManagedLifecycleConflict('assignment_mismatch');
        }
      } else if (
        !fingerprint.tracks.some(({ kind }) => kind === 'audio') ||
        fingerprint.tracks.some(({ kind }) => kind === 'video')
      ) {
        throw new ManagedLifecycleConflict('assignment_mismatch');
      }
    }
  }

  private async findByRequest(
    client: PoolClient,
    streamId: string,
    requestId: string,
  ): Promise<OperationRow | null> {
    const result = await client.query<OperationRow>(
      `${OPERATION_SELECT}
        WHERE operation.stream_id = $1 AND operation.request_id = $2`,
      [streamId, requestId],
    );
    return result.rows[0] ?? null;
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
    const row = result.rows[0];
    if (!row) throw new StreamNotFoundError(streamId);
    return row;
  }

  private toOperation(row: OperationRow): LegacyAdoptionOperation {
    return {
      lifecycleVersion: 1,
      kind: 'legacy-adoption',
      operationId: row.operation_id,
      requestId: row.request_id,
      streamId: row.stream_id,
      topic: row.topic,
      mediaType: row.media_type,
      uploaderId: row.assigned_uploader_id,
      candidateDigest: row.candidate_digest,
      revision: row.revision,
      status: row.status,
      candidate: row.candidate,
      ...(row.completed_recording
        ? { completedRecording: row.completed_recording }
        : {}),
      ...(row.validation ? { validation: row.validation } : {}),
      ...(row.failure ? { failure: row.failure } : {}),
    };
  }
}
