/**
 * The stream holds a recording signed as one address, and its stage now signs as another: the manager rotated the
 * stage's key since the recording was made. A row that holds a recording never changes owner, because the recording's
 * feeds resolve only under the key they were signed with, so the publish is refused rather than listing the recording
 * under a stage that no longer signs as its owner.
 *
 * Unpublishing is still allowed: the entry is removed by the owner stored on the row, which is the one it was written
 * with.
 */
export class FeedOwnerMismatchError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly streamOwner: string,
    public readonly stageId: string,
    public readonly stageOwner: string,
  ) {
    super(
      `The recording was made under another key: this stream's recording is signed as ${streamOwner}, and its stage now signs as ${stageOwner}. It cannot be published on that stage.`,
    );
    this.name = 'FeedOwnerMismatchError';
  }
}
