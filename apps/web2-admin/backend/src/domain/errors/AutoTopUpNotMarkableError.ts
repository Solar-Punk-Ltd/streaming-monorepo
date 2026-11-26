/**
 * Refuses a mark for auto top-up of stamps the admin could not top up now, or that the manager does not list, with a
 * sentence for each. Nothing of the request is marked.
 */
export class AutoTopUpNotMarkableError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(problems.join(' '));
    this.name = 'AutoTopUpNotMarkableError';
  }
}
