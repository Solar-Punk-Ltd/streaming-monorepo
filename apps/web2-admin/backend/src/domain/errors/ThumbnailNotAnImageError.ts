/**
 * The thumbnail body's own bytes are not a PNG, JPEG, WebP or GIF picture, whatever its
 * `Content-Type` claimed. A text file renamed to `.png` is the usual case.
 */
export class ThumbnailNotAnImageError extends Error {
  constructor(public readonly declared: string) {
    super(`The thumbnail was sent as "${declared}" but its content is not a PNG, JPEG, WebP or GIF picture`);
    this.name = 'ThumbnailNotAnImageError';
  }
}
