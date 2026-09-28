import type { CatalogueWriteProblem } from '@streaming-monorepo/web2-admin-common';

/**
 * The catalogue cannot be written: the manager has not designated a catalogue batch, it cleared the designation, or
 * the batch the catalogue is written with is expired or gone. `message` is the sentence the console and the log show,
 * from `catalogueRefusal`.
 *
 * Nothing was written and no row was moved when this is thrown by a publish, an unpublish or a reconcile: the check
 * runs before any of them touches the stream or the feed. The API answers 503, a condition the manager can end, so
 * the uploader retries a state report refused with it as it retries any other failed write.
 */
export class CatalogueStampUnavailableError extends Error {
  constructor(
    public readonly problem: CatalogueWriteProblem,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogueStampUnavailableError';
  }
}
