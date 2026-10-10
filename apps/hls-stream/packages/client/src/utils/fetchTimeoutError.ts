/** Raised for a read whose window ran out, so a caller can tell a timeout from a cancelled request. */
export class FetchTimeoutError extends Error {
  /**
   * Whatever the request actually rejected with. Declared rather than passed to `super`, because the
   * options form of the `Error` constructor is newer than this bundle's `build.target` and would be
   * dropped in silence on the older engines that target promises.
   */
  readonly cause?: unknown;

  constructor(
    readonly url: string,
    readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
    this.cause = cause;
  }
}
