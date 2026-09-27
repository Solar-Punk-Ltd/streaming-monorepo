/** A username the database's CHECK would refuse, caught before it gets there. */
export class InvalidUsernameError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'InvalidUsernameError';
  }
}
