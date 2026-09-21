import type {
  MediaType,
  UploaderMediaProfile,
} from '@streaming-monorepo/web2-admin-common';
import type { PoolClient } from 'pg';

import { ManagedEnrollmentUnavailableError } from './errors/index.js';
import type { UploaderCapabilityRepository } from './UploaderCapabilityRepository.js';

export interface ManagedEnrollmentProof {
  profile: UploaderMediaProfile;
  profileDigest: string;
}

/**
 * Decides whether a stream may enter the managed lifecycle, for a new stream
 * and for a legacy recording alike. The one requirement is a fresh capability
 * record from the configured uploader that offers the stream's media type. The
 * record is filtered on lifecycle version 1, so it also proves the uploader
 * runs a lifecycle-capable release. Nothing here proves which release the
 * viewer runs.
 */
export class ManagedEnrollmentReadiness {
  constructor(
    private readonly uploaderCapabilities: UploaderCapabilityRepository,
  ) {}

  /**
   * Call while holding the stream's row lock, so the ladder returned is the
   * one the enrollment freezes.
   *
   * @throws ManagedEnrollmentUnavailableError with reason
   * `uploader_capability_not_fresh` when no fresh record offers `mediaType`.
   */
  async requireAfterStreamLock(
    client: PoolClient,
    streamId: string,
    mediaType: MediaType,
  ): Promise<ManagedEnrollmentProof> {
    const capability =
      await this.uploaderCapabilities.freshProfileForEnrollment(
        client,
        mediaType,
      );
    if (!capability) {
      throw new ManagedEnrollmentUnavailableError(
        streamId,
        'uploader_capability_not_fresh',
      );
    }
    return { profile: capability.profile, profileDigest: capability.digest };
  }
}
