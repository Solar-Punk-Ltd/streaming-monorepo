import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

/** What `Content-Type` a thumbnail PUT may carry. */
export const THUMBNAIL_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/**
 * Statuses a *first* publish may claim. `live` and `vod` are deliberately not
 * here: a republish of a stream that has gone live keeps its state instead of
 * being claimed into `publishing` and coming back as `published`, which would
 * quietly tell the catalogue the broadcast had stopped.
 */
export const PUBLISHABLE_STATUSES: readonly StreamStatus[] = [
  'draft',
  'published',
];

/**
 * Statuses an unpublish may claim. A recording can be taken off the catalogue;
 * a live stream cannot, and is refused with `stream_live` before the claim.
 */
export const UNPUBLISHABLE_STATUSES: readonly StreamStatus[] = [
  'draft',
  'published',
  'vod',
];

/**
 * Statuses whose stream has an entry on the catalogue: what `listOnFeed`
 * selects. `publishing` is not one of them, because that write is in flight.
 */
export const ON_FEED_STATUSES: readonly StreamStatus[] = [
  'published',
  'live',
  'vod',
];

/**
 * Statuses in which the metadata is still editable. A live or recorded stream
 * keeps its title, description, tags and thumbnail editable — only the media
 * type and the schedule are locked, and those are refused by their own rules
 * with a sentence saying why. Only `publishing` is excluded, because a feed
 * write is in flight over exactly this data.
 */
export const EDITABLE_STATUSES: readonly StreamStatus[] = [
  'draft',
  'published',
  'live',
  'vod',
];

/**
 * A user agent is kept on the session row so a revoke can be told which
 * browser it drops. Truncated, because the header is attacker-controlled and
 * this column is not worth a kilobyte a login.
 */
export const USER_AGENT_MAX_LENGTH = 255;
