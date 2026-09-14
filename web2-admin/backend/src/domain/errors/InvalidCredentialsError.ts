export class InvalidCredentialsError extends Error {
  constructor(public readonly username: string) {
    super(`Invalid credentials for ${username}`);
    this.name = 'InvalidCredentialsError';
  }
}
