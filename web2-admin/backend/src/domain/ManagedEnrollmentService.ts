import type { MediaType, StreamStatus } from '@streaming-monorepo/web2-admin-common';
import type { Pool, PoolClient } from 'pg';

import {
  ManagedEnrollmentUnavailableError,
  StreamNotFoundError,
} from './errors/index.js';
import type { ManagedEnrollmentReadiness } from './ManagedEnrollmentReadiness.js';
import { managedRungTopicFor } from './managedRungTopic.js';

interface EnrollmentCandidateRow {
  id: string;
  topic: string;
  media_type: MediaType;
  status: StreamStatus;
  lifecycle_version: number | null;
  manifest_index: number | null;
  duration_seconds: number | null;
  live_since: Date | null;
  ended_at: Date | null;
  has_renditions: boolean;
}

export type ManagedEnrollmentOutcome = 'enrolled' | 'managed' | 'legacy';

export interface ManagedPublisherEnrollment {
  enrollEligiblePlaceholder(
    streamId: string,
    ownerId: string,
  ): Promise<ManagedEnrollmentOutcome>;
}

export class ManagedEnrollmentService implements ManagedPublisherEnrollment {
  constructor(
    private readonly pool: Pool,
    private readonly readiness: ManagedEnrollmentReadiness,
    private readonly uploaderId: string,
  ) {}

  async enrollEligiblePlaceholder(
    streamId: string,
    ownerId: string,
  ): Promise<ManagedEnrollmentOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stream = await this.lockOwnedStream(client, streamId, ownerId);
      if (stream.lifecycle_version === 1) {
        await client.query('COMMIT');
        return 'managed';
      }
      if (!this.isIdlePlaceholder(stream)) {
        await client.query('COMMIT');
        return 'legacy';
      }

      const proof = await this.readiness.readAfterStreamLock(
        client,
        stream.media_type,
      );
      if (!proof) throw new ManagedEnrollmentUnavailableError(streamId);

      await client.query(
        `INSERT INTO stream_runs (
           stream_id, run_number, state, permission, assigned_uploader_id,
           revision
         ) VALUES ($1, 1, 'ready', 'open', $2, 1)`,
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
      await client.query(
        `UPDATE streams
            SET lifecycle_version = 1, lifecycle_revision = 1,
                current_run_number = 1, enrollment_profile_digest = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [streamId, proof.profileDigest],
      );
      await client.query('COMMIT');
      return 'enrolled';
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
  ): Promise<EnrollmentCandidateRow> {
    const result = await client.query<EnrollmentCandidateRow>(
      `SELECT stream.id, stream.topic, stream.media_type, stream.status,
              stream.lifecycle_version, stream.manifest_index,
              stream.duration_seconds, stream.live_since, stream.ended_at,
              EXISTS (
                SELECT 1 FROM stream_renditions rendition
                 WHERE rendition.stream_id = stream.id
              ) AS has_renditions
         FROM streams stream
        WHERE stream.id = $1 AND stream.user_id = $2
        FOR UPDATE OF stream`,
      [streamId, ownerId],
    );
    const stream = result.rows[0];
    if (!stream) throw new StreamNotFoundError(streamId);
    return stream;
  }

  private isIdlePlaceholder(stream: EnrollmentCandidateRow): boolean {
    return (
      (stream.status === 'draft' || stream.status === 'published') &&
      stream.manifest_index === null &&
      stream.duration_seconds === null &&
      stream.live_since === null &&
      stream.ended_at === null &&
      !stream.has_renditions
    );
  }
}
