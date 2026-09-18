/**
 * A sign-in that named no known user, or the wrong password for a known one.
 * Deliberately one error for both: telling them apart tells an attacker which
 * usernames exist, which is also why the unknown-name path still pays for a
 * scrypt against a decoy hash.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Wrong username or password');
    this.name = 'InvalidCredentialsError';
  }
}
