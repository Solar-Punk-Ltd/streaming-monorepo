/**
 * Everything the login screen and the two password forms say, in one place.
 *
 * Ported from streaming-infra-manager's `frontend/src/auth/messages.ts`. One
 * module rather than a sentence next to each form, because the same rule is
 * stated by the login page, the add-user form and the change-password form,
 * and three copies of it drift.
 *
 * Deliberately vague about which half of the pair was wrong: naming the
 * username would tell anyone which accounts exist.
 */

import { PASSWORD_MIN_LENGTH } from '@streaming-monorepo/web2-admin-common';

export const SIGN_IN_MESSAGES = {
  wrongPair: 'Wrong username or password.',
  sessionEnded: 'Your session ended. Log in again.',
  noUsers: 'No users yet. Create the first one on the host.',
  unreachable:
    'The server did not answer. Check that it is running, then try again.',
} as const;

/** Said by both password forms, so they say it the same way. */
export const PASSWORD_MISMATCH = 'The two passwords are not the same.';

/** The rule, stated before it is broken rather than after. */
export const PASSWORD_RULE =
  `At least ${PASSWORD_MIN_LENGTH} characters, and it must not contain the ` +
  'username.';

/**
 * The command that creates the first user, shown when there are none.
 *
 * `api` is the backend's service name in `web2-admin/backend/docker-compose.yml`
 * and `-p web2-admin` the project name its own scripts use. One constant, so
 * the day the CLI is renamed there is one line to change here.
 */
export const FIRST_USER_COMMAND =
  'docker compose -p web2-admin exec -it api node dist/cli.js user:add <username>';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** How long to wait, as an operator would say it. */
export function waitText(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return 'in less than a minute';
  if (seconds < SECONDS_PER_HOUR) {
    return `in ${plural(Math.ceil(seconds / SECONDS_PER_MINUTE), 'minute')}`;
  }
  return `in ${plural(Math.ceil(seconds / SECONDS_PER_HOUR), 'hour')}`;
}

export function tooManyAttempts(retryAfterSeconds: number): string {
  return `Too many attempts. Try again ${waitText(retryAfterSeconds)}.`;
}
