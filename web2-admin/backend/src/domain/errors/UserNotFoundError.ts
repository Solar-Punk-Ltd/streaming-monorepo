export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`User not found: ${userId}`);
    this.name = 'UserNotFoundError';
  }
}
