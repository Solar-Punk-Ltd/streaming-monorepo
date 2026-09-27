/** Removing this user would lock people out: yourself, or the last who can manage users. */
export class CannotRemoveUserError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'CannotRemoveUserError';
  }
}
