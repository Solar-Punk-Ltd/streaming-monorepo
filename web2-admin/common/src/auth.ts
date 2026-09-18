/**
 * The sign-in rules and shapes the backend and the console both have to agree
 * on. Ported from streaming-infra-manager's `common/src/auth.ts`, whose own
 * header explains why they live in one place: a copy that drifts is not a
 * compile error anywhere, so the console would accept a password the API
 * refuses, and the header that makes a cross-site write impossible would be
 * spelled one way on the sending side and another on the checking side.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// ------------------------------------------------------------- the password

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The one authority on what makes an acceptable password: the reason it is
 * refused, in words the operator can act on, or null when it is fine.
 *
 * Anything printable is allowed and no composition rules apply. Length is the
 * only thing that buys resistance to guessing, and a password carrying the
 * username is the first guess anyone makes.
 */
export function passwordProblem(
  password: string,
  username: string,
): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  if (
    username.length > 0 &&
    password.toLowerCase().includes(username.toLowerCase())
  ) {
    return 'password must not contain the username';
  }
  return null;
}

// ------------------------------------------------------------- the username

/** Mirrors the users_username_format CHECK in the migration. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export const USERNAME_MAX_LENGTH = 32;

export const USERNAME_MESSAGE =
  'username must be 2 to 32 characters of a-z, 0-9, dot, underscore or dash, starting with a letter or digit';

/**
 * The reason a username cannot be used, or null when it can. The database
 * enforces the same rule as a CHECK, so this exists to refuse a bad name with
 * something an operator can act on rather than a constraint violation from the
 * driver.
 */
export function usernameProblem(username: string): string | null {
  return USERNAME_RE.test(username) ? null : USERNAME_MESSAGE;
}

// ------------------------------------------------------ the request headers

export const SESSION_COOKIE_NAME = 'web2_admin_session';

export const REQUESTED_WITH_HEADER = 'x-requested-with';

/**
 * A header no cross-origin page can add without a CORS preflight, which this
 * API never answers. The console's fetch wrapper puts it on every write.
 */
export const REQUESTED_WITH_VALUE = 'web2-admin';

// ----------------------------------------------------------- the two clocks

/** Signed out after this long without a request. Slides on every request. */
export const SESSION_IDLE_TIMEOUT_MS = 12 * HOUR_MS;

/** Signed out this long after signing in, however busy the session was. */
export const SESSION_ABSOLUTE_TIMEOUT_MS = 14 * 24 * HOUR_MS;

/**
 * How stale `last_seen_at` may be before a request writes it again. Without
 * this every request would be a write.
 */
export const LAST_SEEN_REFRESH_MS = MINUTE_MS;

// ------------------------------------------------------ the lockout schedule

/** Failures allowed before the first lockout. The next one locks. */
export const LOGIN_FREE_ATTEMPTS = 4;

export const LOGIN_FIRST_LOCKOUT_MS = MINUTE_MS;
export const LOGIN_MAX_LOCKOUT_MS = 60 * MINUTE_MS;

/** Quiet time after which a key is forgotten. Twice the longest lockout, so
 * sitting one out does not by itself wipe the count. */
export const LOGIN_FORGET_MS = 2 * LOGIN_MAX_LOCKOUT_MS;

/** How long a key is locked after this many failures, and 0 while it is free. */
export function lockoutMsFor(failures: number): number {
  if (failures <= LOGIN_FREE_ATTEMPTS) return 0;

  const doublings = failures - LOGIN_FREE_ATTEMPTS - 1;
  return Math.min(
    LOGIN_MAX_LOCKOUT_MS,
    LOGIN_FIRST_LOCKOUT_MS * 2 ** doublings,
  );
}
