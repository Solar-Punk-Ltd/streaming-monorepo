import {
  sniffThumbnailMime,
  STREAM_LIMITS,
  THUMBNAIL_MIME_TYPES,
  THUMBNAIL_SNIFF_BYTES,
} from '@streaming-monorepo/web2-admin-common';

import { THUMBNAIL_NOT_AN_IMAGE, thumbnailTooLargeMessage, UNSUPPORTED_IMAGE_TYPE } from './errors';

/**
 * Why a picked file cannot be the thumbnail, or null when it can. The same three refusals the
 * thumbnail endpoint makes, checked before the stream is saved so the operator hears about them
 * beside the picker instead of after the row has already gone in.
 */
export async function thumbnailRefusal(file: File): Promise<string | null> {
  if (!(THUMBNAIL_MIME_TYPES as readonly string[]).includes(file.type)) return UNSUPPORTED_IMAGE_TYPE;
  if (file.size > STREAM_LIMITS.THUMBNAIL_MAX_BYTES) return thumbnailTooLargeMessage(file.size);
  const head = new Uint8Array(await file.slice(0, THUMBNAIL_SNIFF_BYTES).arrayBuffer());
  return sniffThumbnailMime(head) ? null : THUMBNAIL_NOT_AN_IMAGE;
}
