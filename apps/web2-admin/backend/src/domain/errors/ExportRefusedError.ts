import type { ExportRefusalProblem } from '@streaming-monorepo/web2-admin-common';

/**
 * An export cannot start, or an action cannot be done to it now: another export holds the one slot, the stream holds
 * no finished recording, the quality has not finished, there is no node to read through, ffmpeg is missing, the disk
 * is short, or the export is in a state the action does not apply to. `message` is the sentence the console shows.
 * Nothing changed. The API answers 409.
 */
export class ExportRefusedError extends Error {
  constructor(
    public readonly problem: ExportRefusalProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ExportRefusedError';
  }
}
