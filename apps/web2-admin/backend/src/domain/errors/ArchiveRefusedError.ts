import type { ArchiveRefusalProblem } from '@streaming-monorepo/web2-admin-common';

/**
 * An archive or a purchase that cannot start, or an action on the archive that cannot be done now: the 409
 * `ArchiveRefusedAnswer`, with the sentence the console shows as it is.
 */
export class ArchiveRefusedError extends Error {
  constructor(
    public readonly problem: ArchiveRefusalProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveRefusedError';
  }
}

/** No archive job, or no purchase, under this id. */
export class ArchiveNotFoundError extends Error {
  constructor(public readonly archiveId: string) {
    super(`No archive ${archiveId}.`);
    this.name = 'ArchiveNotFoundError';
  }
}
