/** The *current* password in a change-password request did not match. */
export class InvalidPasswordError extends Error {
  constructor() {
    super('Current password is incorrect');
    this.name = 'InvalidPasswordError';
  }
}
