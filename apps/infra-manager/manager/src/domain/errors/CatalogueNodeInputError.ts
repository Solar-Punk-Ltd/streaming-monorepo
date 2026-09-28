/**
 * A designation of the catalogue node the manager refuses, with one sentence per reason. No sentence repeats a token
 * or an address.
 */
export class CatalogueNodeInputError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(reasons.join(' '));
    this.name = 'CatalogueNodeInputError';
  }
}
