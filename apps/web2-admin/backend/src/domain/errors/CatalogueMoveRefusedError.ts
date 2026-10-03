import type { CatalogueMoveProblem } from '@streaming-monorepo/web2-admin-common';

/**
 * A move of the catalogue to another batch cannot start: it is not enabled on this installation, there is no batch to
 * move to or nothing to move, the batch is unusable, the history cannot be read, or the page named another batch than
 * the designated one. `message` is the sentence the console shows, from `catalogueMoveRefusal`. Nothing was started.
 * The API answers 409.
 */
export class CatalogueMoveRefusedError extends Error {
  constructor(
    public readonly problem: CatalogueMoveProblem,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogueMoveRefusedError';
  }
}
