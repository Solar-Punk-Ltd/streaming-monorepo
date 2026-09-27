/**
 * The node could not say whether it still holds a thumbnail reference: it was
 * unreachable, the check timed out, or it answered with something other than
 * the file or a 404.
 *
 * Publishing stops instead of guessing. Reading "unreachable" as "missing"
 * would re-upload the image and spend a stamp every time the node hiccups.
 */
export class ThumbnailCheckError extends Error {
  constructor(
    public readonly reference: string,
    public readonly detail: string,
  ) {
    super(`Could not verify thumbnail reference ${reference}: ${detail}`);
    this.name = 'ThumbnailCheckError';
  }
}
