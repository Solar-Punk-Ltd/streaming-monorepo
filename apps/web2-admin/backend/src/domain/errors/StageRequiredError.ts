/** The sentence a publish of a draft with no stage is refused with. */
export const STAGE_REQUIRED_MESSAGE = 'Pick the stage this stream is broadcast on before publishing.';

/**
 * A draft with no stage cannot go on the catalogue: nothing says where its
 * encoder sends it.
 */
export class StageRequiredError extends Error {
  constructor(public readonly streamId: string) {
    super(STAGE_REQUIRED_MESSAGE);
    this.name = 'StageRequiredError';
  }
}
