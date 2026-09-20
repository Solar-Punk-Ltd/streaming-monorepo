import { createHash } from 'node:crypto';

import {
  canonicalUploaderProfileJson,
  type MediaType,
  type UploaderCapabilities,
  type UploaderCapabilityReceipt,
  type UploaderMediaProfile,
} from '@streaming-monorepo/web2-admin-common';
import type { Pool } from 'pg';

import { ManagedLifecycleConflict } from './managedLifecycle.js';

const CAPABILITY_FRESHNESS_MS = 30_000;

interface CapabilityRow {
  uploader_id: string;
  lifecycle_version: 1;
  profiles: UploaderMediaProfile[];
  received_at: Date;
}

export interface FreshUploaderProfile {
  profile: UploaderMediaProfile;
  digest: string;
  receivedAt: string;
}

function profileDigest(profile: UploaderMediaProfile): string {
  return createHash('sha256')
    .update(canonicalUploaderProfileJson(profile))
    .digest('hex');
}

export class UploaderCapabilityRepository {
  constructor(
    private readonly pool: Pool,
    private readonly configuredUploaderId: string,
  ) {}

  async record(
    uploaderId: string,
    capability: UploaderCapabilities,
  ): Promise<UploaderCapabilityReceipt> {
    if (uploaderId !== this.configuredUploaderId) {
      throw new ManagedLifecycleConflict('assignment_mismatch');
    }
    const result = await this.pool.query<CapabilityRow>(
      `INSERT INTO uploader_capability_receipts (
         uploader_id, lifecycle_version, durable_checkpoint_store_version,
         legacy_recording_adoption_version, profiles, received_at
       ) VALUES ($1, 1, 1, 1, $2, clock_timestamp())
       ON CONFLICT (uploader_id) DO UPDATE
         SET lifecycle_version = EXCLUDED.lifecycle_version,
             durable_checkpoint_store_version = EXCLUDED.durable_checkpoint_store_version,
             legacy_recording_adoption_version = EXCLUDED.legacy_recording_adoption_version,
             profiles = EXCLUDED.profiles,
             received_at = clock_timestamp()
       RETURNING uploader_id, lifecycle_version, profiles, received_at`,
      [uploaderId, JSON.stringify(capability.profiles)],
    );
    return this.toReceipt(result.rows[0]);
  }

  async freshProfile(mediaType: MediaType): Promise<FreshUploaderProfile | null> {
    const result = await this.pool.query<CapabilityRow>(
      `SELECT uploader_id, lifecycle_version, profiles, received_at
         FROM uploader_capability_receipts
        WHERE uploader_id = $1
          AND lifecycle_version = 1
          AND received_at >= clock_timestamp()
              - ($2::integer * interval '1 millisecond')`,
      [this.configuredUploaderId, CAPABILITY_FRESHNESS_MS],
    );
    const row = result.rows[0];
    if (!row) return null;
    const profile = row.profiles.find((candidate) => candidate.mediaType === mediaType);
    if (!profile) return null;
    return {
      profile,
      digest: profileDigest(profile),
      receivedAt: row.received_at.toISOString(),
    };
  }

  private toReceipt(row: CapabilityRow): UploaderCapabilityReceipt {
    return {
      lifecycleVersion: row.lifecycle_version,
      uploaderId: row.uploader_id,
      receivedAt: row.received_at.toISOString(),
      freshUntil: new Date(
        row.received_at.getTime() + CAPABILITY_FRESHNESS_MS,
      ).toISOString(),
      profileDigests: row.profiles.map((profile) => ({
        mediaType: profile.mediaType,
        digest: profileDigest(profile),
      })),
    };
  }
}
