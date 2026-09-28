import type { StreamRow } from '../types/index.js';

/**
 * Who called one of the uploader's routes: the uploader of one stage, on the token of its own that the stage record
 * names by its sha256 (`requireUploaderToken`). No other caller reaches those routes.
 */
export interface UploaderCaller {
  stageId: string;
  owner: string;
  name: string;
}

/** Which streams an uploader's call may touch: those on its stage. */
export interface UploaderScope {
  stageId: string;
}

export function scopeOf(caller: UploaderCaller): UploaderScope {
  return { stageId: caller.stageId };
}

/**
 * Whether a stream is one the scope may touch. A stream with no stage (a row older than stages) is on no stage, so no
 * uploader reaches it: it takes a broadcast again once it is unpublished, given a stage and published.
 */
export function inScope(stream: Pick<StreamRow, 'stage_id'>, scope: UploaderScope): boolean {
  return stream.stage_id === scope.stageId;
}
