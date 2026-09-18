/**
 * Nobody has been created yet, so there is no password to check against. The
 * console shows the CLI command that makes the first user.
 */
export class NoUsersError extends Error {
  constructor() {
    super('No users exist yet, create the first one with the user:add CLI');
    this.name = 'NoUsersError';
  }
}
