import { createHash, randomUUID } from 'node:crypto';

import type {
  ManagedClaimRequest,
  ManagedRunView,
} from '@streaming-monorepo/web2-admin-common';
import type { Pool, PoolClient } from 'pg';

import { ManagedLifecycleConflict } from './managedLifecycle.js';

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
}

const RUN_SELECT = `
  SELECT stream.lifecycle_version, stream.lifecycle_revision,
         stream.current_run_number, run.stream_id, run.run_number,
         run.revision, run.assigned_uploader_id, run.claim_id,
         run.claim_request_id, run.claim_request_digest, run.state,
         run.permission, run.reconnect_deadline, run.close_reason
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

function toView(row: ManagedRunDatabaseRow): ManagedRunView {
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
      return toView(claimed.rows[0]!);
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
    const result = await this.pool.query<ManagedRunDatabaseRow>(
      RUN_SELECT,
      [streamId, runNumber],
    );
    const row = result.rows[0];
    if (!row) throw new ManagedLifecycleConflict('stale_run');
    this.requireCurrent(row, runNumber, uploaderId);
    if (row.claim_id !== claimId) {
      throw new ManagedLifecycleConflict('assignment_mismatch');
    }
    return toView(row);
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
    if (row.lifecycle_version !== 1 || row.current_run_number !== runNumber) {
      throw new ManagedLifecycleConflict('stale_run');
    }
    if (row.assigned_uploader_id !== uploaderId) {
      throw new ManagedLifecycleConflict('assignment_mismatch');
    }
  }
}
