/** Removing yourself, the last user, or the last admin would lock people out. */
export class CannotRemoveUserError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'CannotRemoveUserError';
  }
}
