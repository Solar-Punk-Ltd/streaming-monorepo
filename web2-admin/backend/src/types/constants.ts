import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

/** Session cookie name. httpOnly, sameSite lax, path /, secure from config. */
export const SESSION_COOKIE_NAME = 'web2_admin_session';

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

/** Login attempts per username per window before 429 too_many_attempts. */
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Minimum length of a new password, checked by the yup schema. */
export const PASSWORD_MIN_LENGTH = 8;
