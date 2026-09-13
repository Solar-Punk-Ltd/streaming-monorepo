export class UnauthenticatedError extends Error {
  constructor() {
    super('No valid session');
    this.name = 'UnauthenticatedError';
  }
}
