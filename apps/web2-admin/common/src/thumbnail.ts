/** The picture formats a stream thumbnail may be, as `PUT /streams/:id/thumbnail` accepts them. */
export const THUMBNAIL_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type ThumbnailMime = (typeof THUMBNAIL_MIME_TYPES)[number];

/** How many leading bytes `sniffThumbnailMime` needs to tell the four formats apart. */
export const THUMBNAIL_SNIFF_BYTES = 12;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38]; // "GIF8", shared by GIF87a and GIF89a
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_FORM = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at offset 8 of a RIFF file

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * Which thumbnail format the file's own leading bytes say it is, or null when they are none of the
 * four. A file name or a declared `Content-Type` is only a claim: a text file renamed to `.png`
 * arrives as `image/png` and would be stored and served as a picture no browser can draw.
 */
export function sniffThumbnailMime(head: Uint8Array): ThumbnailMime | null {
  if (startsWith(head, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(head, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(head, GIF_SIGNATURE)) return 'image/gif';
  if (startsWith(head, RIFF_SIGNATURE) && startsWith(head, WEBP_FORM, 8)) return 'image/webp';
  return null;
}
