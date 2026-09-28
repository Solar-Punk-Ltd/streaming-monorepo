/**
 * Why a stream's stage cannot change: it is not a draft, so its catalogue
 * entry and viewer links already carry the stage's owner, or it holds a
 * recording, which lives under that owner.
 */
export type StageLockReason = 'published' | 'recording';

/** The sentences the API refuses a stage change with, one per reason. */
export const STAGE_LOCKED_MESSAGES: Record<StageLockReason, string> = {
  published: 'Unpublish the stream to change its stage; publishing fixed it.',
  recording: 'This stream holds a recording made on its stage, so it keeps that stage.',
};

/** A stage change the stream can no longer take. */
export class StageLockedError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly reason: StageLockReason,
  ) {
    super(STAGE_LOCKED_MESSAGES[reason]);
    this.name = 'StageLockedError';
  }
}
