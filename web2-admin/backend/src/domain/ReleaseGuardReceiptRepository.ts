import { isDeepStrictEqual } from 'node:util';

import type {
  ReleaseGuardArtifact,
  ReleaseGuardReceipt,
  ReleaseGuardRole,
} from '@streaming-monorepo/web2-admin-common';
import type { Pool, PoolClient } from 'pg';

export type ReleaseGuardReceiptConflictCode =
  | 'assignment_mismatch'
  | 'installation_conflict'
  | 'stale_generation'
  | 'generation_conflict';

export class ReleaseGuardReceiptConflict extends Error {
  constructor(public readonly code: ReleaseGuardReceiptConflictCode) {
    super(code);
    this.name = 'ReleaseGuardReceiptConflict';
  }
}

interface ReceiptRow {
  role: ReleaseGuardRole;
  slot_id: string;
  installation_id: string;
  generation: number;
  state_digest: string;
  minimum_srs_lifecycle: 1;
  tree_digest: string;
  images: ReleaseGuardArtifact['images'];
}

function toReceipt(row: ReceiptRow): ReleaseGuardReceipt {
  return {
    schemaVersion: 1,
    installationId: row.installation_id,
    generation: row.generation,
    stateDigest: row.state_digest,
    slot: { role: row.role, id: row.slot_id },
    minimums: { srsLifecycle: row.minimum_srs_lifecycle },
    artifact: { treeDigest: row.tree_digest, images: row.images },
  };
}

function exactReceiptMatch(
  current: ReleaseGuardReceipt,
  incoming: ReleaseGuardReceipt,
): boolean {
  return isDeepStrictEqual(current, incoming);
}

export class ReleaseGuardReceiptRepository {
  constructor(
    private readonly pool: Pool,
    private readonly configuredUploaderId: string,
  ) {}

  async record(receipt: ReleaseGuardReceipt): Promise<ReleaseGuardReceipt> {
    this.requireConfiguredSlot(receipt);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (await this.insertIfUnbound(client, receipt)) {
        await client.query('COMMIT');
        return receipt;
      }

      const current = await this.lockSlot(client, receipt.slot.role, receipt.slot.id);
      if (!current) {
        throw new Error('release guard slot disappeared after binding conflict');
      }
      if (current.installationId !== receipt.installationId) {
        throw new ReleaseGuardReceiptConflict('installation_conflict');
      }
      if (receipt.generation < current.generation) {
        throw new ReleaseGuardReceiptConflict('stale_generation');
      }
      if (receipt.generation === current.generation) {
        if (!exactReceiptMatch(current, receipt)) {
          throw new ReleaseGuardReceiptConflict('generation_conflict');
        }
        await client.query('COMMIT');
        return current;
      }
      await this.update(client, receipt);
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async readCompleteSet(): Promise<ReleaseGuardReceipt[] | null> {
    return this.readCompleteSetWith(this.pool);
  }

  async readCompleteSetForEnrollment(
    client: PoolClient,
  ): Promise<ReleaseGuardReceipt[] | null> {
    return this.readCompleteSetWith(client);
  }

  private async readCompleteSetWith(
    queryable: Pool | PoolClient,
  ): Promise<ReleaseGuardReceipt[] | null> {
    const result = await queryable.query<ReceiptRow>(
      `SELECT role, slot_id, installation_id, generation, state_digest,
              minimum_srs_lifecycle, tree_digest, images
         FROM release_guard_receipts
        WHERE (role, slot_id) IN (
          ('manager', 'default'),
          ('admin', 'default'),
          ('viewer', 'default'),
          ('uploader', $1)
        )
        ORDER BY role`,
      [this.configuredUploaderId],
    );
    if (result.rows.length !== 4) return null;
    return result.rows.map(toReceipt);
  }

  private requireConfiguredSlot(receipt: ReleaseGuardReceipt): void {
    const { role, id } = receipt.slot;
    if (
      (role === 'uploader' && id !== this.configuredUploaderId) ||
      (role !== 'uploader' && id !== 'default')
    ) {
      throw new ReleaseGuardReceiptConflict('assignment_mismatch');
    }
  }

  private async lockSlot(
    client: PoolClient,
    role: ReleaseGuardRole,
    id: string,
  ): Promise<ReleaseGuardReceipt | null> {
    const result = await client.query<ReceiptRow>(
      `SELECT role, slot_id, installation_id, generation, state_digest,
              minimum_srs_lifecycle, tree_digest, images
         FROM release_guard_receipts
        WHERE role = $1 AND slot_id = $2
        FOR UPDATE`,
      [role, id],
    );
    return result.rows[0] ? toReceipt(result.rows[0]) : null;
  }

  private async insertIfUnbound(
    client: PoolClient,
    receipt: ReleaseGuardReceipt,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO release_guard_receipts (
         role, slot_id, installation_id, generation, state_digest,
         minimum_srs_lifecycle, tree_digest, images
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
       ON CONFLICT (role, slot_id) DO NOTHING
       RETURNING role`,
      [
        receipt.slot.role,
        receipt.slot.id,
        receipt.installationId,
        receipt.generation,
        receipt.stateDigest,
        receipt.artifact.treeDigest,
        JSON.stringify(receipt.artifact.images),
      ],
    );
    return result.rowCount === 1;
  }

  private async update(
    client: PoolClient,
    receipt: ReleaseGuardReceipt,
  ): Promise<void> {
    await client.query(
      `UPDATE release_guard_receipts
          SET generation = $3, state_digest = $4,
              minimum_srs_lifecycle = 1, tree_digest = $5, images = $6,
              received_at = clock_timestamp()
        WHERE role = $1 AND slot_id = $2`,
      [
        receipt.slot.role,
        receipt.slot.id,
        receipt.generation,
        receipt.stateDigest,
        receipt.artifact.treeDigest,
        JSON.stringify(receipt.artifact.images),
      ],
    );
  }
}
