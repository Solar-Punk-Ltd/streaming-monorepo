import { isDeepStrictEqual } from 'node:util';

import type {
  MediaType,
  ReleaseGuardActiveArtifact,
  ReleaseGuardReceipt,
  UploaderMediaProfile,
} from '@streaming-monorepo/web2-admin-common';
import type { PoolClient } from 'pg';

import type { ReleaseGuardReceiptRepository } from './ReleaseGuardReceiptRepository.js';
import type { UploaderCapabilityRepository } from './UploaderCapabilityRepository.js';

export interface ManagedEnrollmentProof {
  profile: UploaderMediaProfile;
  profileDigest: string;
  guardReceipts: ReleaseGuardReceipt[];
}

export class ManagedEnrollmentReadiness {
  constructor(
    private readonly releaseGuardReceipts: ReleaseGuardReceiptRepository,
    private readonly uploaderCapabilities: UploaderCapabilityRepository,
    private readonly activeAdminArtifact: ReleaseGuardActiveArtifact | null,
  ) {}

  async readAfterStreamLock(
    client: PoolClient,
    mediaType: MediaType,
  ): Promise<ManagedEnrollmentProof | null> {
    if (!this.activeAdminArtifact) return null;
    const guardReceipts =
      await this.releaseGuardReceipts.readCompleteSetForEnrollment(client);
    if (!guardReceipts) return null;
    const adminReceipt = guardReceipts.find(
      ({ slot }) => slot.role === 'admin' && slot.id === 'default',
    );
    if (!adminReceipt || !this.matchesActiveAdmin(adminReceipt)) return null;

    const capability =
      await this.uploaderCapabilities.freshProfileForEnrollment(
        client,
        mediaType,
      );
    if (!capability) return null;
    return {
      profile: capability.profile,
      profileDigest: capability.digest,
      guardReceipts,
    };
  }

  private matchesActiveAdmin(receipt: ReleaseGuardReceipt): boolean {
    return (
      receipt.installationId === this.activeAdminArtifact?.installationId &&
      receipt.generation === this.activeAdminArtifact.generation &&
      isDeepStrictEqual(receipt.slot, this.activeAdminArtifact.slot) &&
      isDeepStrictEqual(receipt.artifact, this.activeAdminArtifact.artifact)
    );
  }
}
