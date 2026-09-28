/**
 * Why a stream's stage cannot change: it is not a draft, so its catalogue
 * entry and viewer links already carry the stage's owner; it holds a
 * recording, which lives under that owner; or it holds a recording made
 * before stages and the stage picked signs as another address than the
 * recording's.
 */
export type StageLockReason = 'published' | 'recording' | 'owner';

/** The sentences the API refuses a stage change with, one per reason. */
export const STAGE_LOCKED_MESSAGES: Record<StageLockReason, string> = {
  published: 'Unpublish the stream to change its stage; publishing fixed it.',
  recording: 'This stream holds a recording made on its stage, so it keeps that stage.',
  owner:
    "This stream holds a recording made under another key than that stage's. Pick a stage that signs as the recording's owner.",
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
