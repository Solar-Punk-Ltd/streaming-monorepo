/** Why a stream could not enter the managed lifecycle, as the 503 body names it. */
export type ManagedEnrollmentRefusal =
  | 'uploader_capability_not_fresh'
  | 'uploader_profile_changed';

const REFUSAL_EXPLANATIONS: Record<ManagedEnrollmentRefusal, string> = {
  uploader_capability_not_fresh:
    'the configured uploader holds no fresh capability record offering this media type',
  uploader_profile_changed:
    "the uploader's profile for this media type changed after the adoption was prepared",
};

export class ManagedEnrollmentUnavailableError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly reason: ManagedEnrollmentRefusal,
  ) {
    super(
      `Managed enrollment is unavailable for stream ${streamId}: ${REFUSAL_EXPLANATIONS[reason]}`,
    );
    this.name = 'ManagedEnrollmentUnavailableError';
  }
}
