/**
 * The sign-in shapes and values that the manager, the frontend and the offline
 * mock all have to agree on.
 *
 * The password, username, session and lockout rules are the same for every app
 * that signs in, so they live in the shared web-auth package and are re-exported
 * here under the names this app has always used. What stays here is the
 * manager's own: its cookie name, its request header value and the shapes its
 * API answers with.
 */

export {
  LOGIN_FIRST_LOCKOUT_MS,
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

/** The authenticated account as returned by `GET /auth/session`. */
export interface SessionInfo {
  id: number;
  username: string;
  isAdmin: boolean;
  /** ISO session expiry. No session token is included. */
  expiresAt: string;
}

/** One row of the Access page's user table, as `GET /auth/users` answers it. */
export interface UserSummary {
  id: number;
  username: string;
  /** May add and remove users and sign anyone out. */
  isAdmin: boolean;
  /** ISO. */
  createdAt: string;
  /** ISO, or null for a user who has never signed in. */
  lastLoginAt: string | null;
  sessions: number;
}

// ------------------------------------------------------ the request headers

export const SESSION_COOKIE_NAME = 'sim_session';

/**
 * A header no cross-origin page can add without a CORS preflight, which this
 * API never answers. The frontend's fetch wrapper puts it on every write.
 */
export const REQUESTED_WITH_VALUE = 'streaming-infra-manager';
