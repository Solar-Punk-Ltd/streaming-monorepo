export class TooManyAttemptsError extends Error {
  constructor(
    public readonly username: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(
      `Too many login attempts for ${username}, retry in ${retryAfterSeconds}s`,
    );
    this.name = 'TooManyAttemptsError';
  }
}
