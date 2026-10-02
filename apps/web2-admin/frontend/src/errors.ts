/**
 * Shown both as the edit form's helper text, so the radio explains why it is
 * locked, and as the answer to the backend's `media_type_locked` — one
 * sentence for one rule.
 */
export const MEDIA_TYPE_LOCKED = 'Unpublish the stream to change the media type; it is part of the OBS ' + 'stream id.';

/**
 * Shown as the schedule field's helper text once the stream has gone live, and
 * as the answer to the backend's `stream_locked` — the same sentence the
 * backend puts in the error, so the console never contradicts it.
 */
export const SCHEDULE_LOCKED = 'The schedule cannot change once the stream has gone live.';

/**
 * The stage field's helper text once the stage is fixed: the same sentences
 * the backend's `stage_locked` carries for two of its three reasons, the two
 * the form tells from the stream alone. The console shows the backend's
 * sentence as it comes, whatever the reason.
 */
export const STAGE_LOCKED = {
  published: 'Unpublish the stream to change its stage; publishing fixed it.',
  recording: 'This stream holds a recording made on its stage, so it keeps that stage.',
} as const;

/**
 * The same sentence for the backend's `unsupported_media_type` and for the
 * form's own check, which rejects the file before it is ever sent.
 */
export const UNSUPPORTED_IMAGE_TYPE = 'That image type is not supported. Use PNG, JPEG, WebP or GIF.';

/**
 * The API answers with snake_case codes. Showing "invalid_credentials" to an
 * operator is not an error message, so the codes the console can actually
 * provoke get sentences. Anything unmapped falls through as-is, which keeps
 * a new backend code visible rather than swallowed.
 */
const FRIENDLY: Record<string, string> = {
  invalid_credentials: 'Wrong username or password.',
  too_many_attempts: 'Too many login attempts for this username. Try again in a few minutes.',
  unauthenticated: 'Your session ended. Log in again.',
  no_users: 'No users yet. Create the first one on the host.',
  invalid_password: 'Your current password is not correct.',
  // A write that reached the API without the header the console puts on every
  // one of them. Either something else sent it, or a proxy stripped it.
  cross_site_request: 'That request was refused as cross-site. Reload the console and try again.',
  admin_required: 'Only an admin can do that.',
  user_exists: 'That username is taken.',
  user_not_found: 'That user no longer exists. Reload the list.',
  cannot_remove_user: 'That user cannot be removed: it is the last one, the last admin, or your own account.',
  stream_busy: 'This stream is being published right now. Try again in a moment.',
  stream_published: 'Unpublish the stream before deleting it.',
  media_type_locked: MEDIA_TYPE_LOCKED,
  stream_locked: SCHEDULE_LOCKED,
  stream_live: 'Stop the broadcast first: a live stream stays on the feed.',
  invalid_state_transition:
    'The uploader reported a state this stream cannot be in. Reload to see where it actually is.',
  payload_too_large: 'The thumbnail is larger than the 5MB limit.',
  unsupported_media_type: UNSUPPORTED_IMAGE_TYPE,
  not_found: 'Not found.',
  internal_error: 'The server hit an unexpected error.',
};

/** The sentence for this code, or null when the console has none for it. */
export function mappedApiError(code: string): string | null {
  return FRIENDLY[code] ?? null;
}

export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
