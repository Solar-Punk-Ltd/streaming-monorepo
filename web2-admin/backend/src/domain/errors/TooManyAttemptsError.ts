/**
 * The lockout, as the caller meets it: 429 with `Retry-After` and the same
 * number in the body. Raised for a sign-in and for a password change alike —
 * checking a current password is a password check like any other.
 */
export class TooManyAttemptsError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many attempts, retry in ${retryAfterSeconds}s`);
    this.name = 'TooManyAttemptsError';
  }
}
