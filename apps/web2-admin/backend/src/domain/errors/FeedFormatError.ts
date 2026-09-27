/**
 * The stream list feed held something other than a JSON array. Publishing
 * stops rather than replacing it: whatever is there was written by someone,
 * and a rewrite would drop it.
 */
export class FeedFormatError extends Error {
  constructor(public readonly detail: string) {
    super(`Unexpected stream list feed payload: ${detail}`);
    this.name = 'FeedFormatError';
  }
}
