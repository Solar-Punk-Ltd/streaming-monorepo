import { ARCHIVE_UNKNOWN_REFUSAL } from '@streaming-infra-manager/common';

/**
 * An adopt or a removal of an archive batch the manager refuses, with the sentence the Manager settings card shows:
 * `archiveBatchProblem` and the other refusals of `common/src/archiveBatches.ts`. No sentence repeats a token or an
 * address.
 */
export class ArchiveBatchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveBatchRefusedError';
  }
}

/** A removal of a batch that is no archive batch. */
export class ArchiveBatchNotFoundError extends Error {
  constructor(readonly batchId: string) {
    super(ARCHIVE_UNKNOWN_REFUSAL);
    this.name = 'ArchiveBatchNotFoundError';
  }
}
