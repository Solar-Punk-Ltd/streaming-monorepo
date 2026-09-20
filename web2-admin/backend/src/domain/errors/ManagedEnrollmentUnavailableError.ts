export class ManagedEnrollmentUnavailableError extends Error {
  constructor(public readonly streamId: string) {
    super(`Managed enrollment is unavailable for stream ${streamId}`);
    this.name = 'ManagedEnrollmentUnavailableError';
  }
}
