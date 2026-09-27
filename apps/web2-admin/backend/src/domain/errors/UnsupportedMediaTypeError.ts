export class UnsupportedMediaTypeError extends Error {
  constructor(
    public readonly received: string,
    public readonly allowed: readonly string[],
  ) {
    super(`Unsupported Content-Type "${received}", expected one of ${allowed.join(', ')}`);
    this.name = 'UnsupportedMediaTypeError';
  }
}
