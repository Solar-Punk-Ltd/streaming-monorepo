/**
 * Why a stage cannot take a stream: the admin was never told of it, the
 * manager retired it, or it runs an engine the admin takes no streams on
 * (OvenMediaEngine: the admin takes streams on SRS only).
 */
export type StageUnavailableReason = 'unknown' | 'retired' | 'unsupported';

const MESSAGES: Record<StageUnavailableReason, string> = {
  unknown: 'The admin knows no stage with that id. Pick one of the stages listed.',
  retired: 'That stage was retired by the manager and takes no new streams. Pick another.',
  unsupported: 'That stage runs an engine the admin does not take streams on yet. Pick an SRS stage.',
};

/** A stream form named a stage that cannot take the stream. */
export class StageUnavailableError extends Error {
  constructor(
    public readonly stageId: string,
    public readonly reason: StageUnavailableReason,
  ) {
    super(MESSAGES[reason]);
    this.name = 'StageUnavailableError';
  }
}
