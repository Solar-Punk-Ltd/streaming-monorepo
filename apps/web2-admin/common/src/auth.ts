/**
 * The sign-in values the backend and the console both have to agree on.
 *
 * The password, username, session and lockout rules are the same for every app
 * that signs in, so they live in the shared web-auth package and are re-exported
 * here under the names this app has always used. What stays here is the admin's
 * own: its cookie name and its request header value.
 */

export {
  LAST_SEEN_REFRESH_MS,
  LOGIN_FIRST_LOCKOUT_MS,
  LOGIN_FORGET_MS,
  LOGIN_FREE_ATTEMPTS,
  LOGIN_MAX_LOCKOUT_MS,
  lockoutMsFor,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  REQUESTED_WITH_HEADER,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  USERNAME_MAX_LENGTH,
  USERNAME_MESSAGE,
  USERNAME_RE,
  usernameProblem,
} from '@streaming-monorepo/web-auth/rules';

// ------------------------------------------------------ the request headers

export const SESSION_COOKIE_NAME = 'web2_admin_session';

/**
 * A header no cross-origin page can add without a CORS preflight, which this
 * API never answers. The console's fetch wrapper puts it on every write.
 */
export const REQUESTED_WITH_VALUE = 'web2-admin';
