import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';

import type { ReleaseGuardActiveArtifact } from '@streaming-monorepo/web2-admin-common';

import { releaseGuardActiveAdminArtifactSchema } from '../schemas/releaseGuard.js';

export const ACTIVE_ADMIN_ARTIFACT_PATH =
  '/run/streaming-release/active-artifact.json';
const ACTIVE_ARTIFACT_MAX_BYTES = 64 * 1024;

export function loadActiveAdminArtifact(
  path = ACTIVE_ADMIN_ARTIFACT_PATH,
): ReleaseGuardActiveArtifact | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > ACTIVE_ARTIFACT_MAX_BYTES
    ) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    return releaseGuardActiveAdminArtifactSchema.validateSync(parsed, {
      abortEarly: false,
      strict: true,
    }) as ReleaseGuardActiveArtifact;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
