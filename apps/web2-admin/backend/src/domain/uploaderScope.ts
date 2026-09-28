import type { StreamRow } from '../types/index.js';

/**
 * Who called one of the uploader's routes, as the token it presented says (`requireUploaderToken`):
 * - `stage`: the uploader of one stage, on the token of its own that the stage record names by its sha256;
 * - `shared`: an uploader still on the shared `INTERNAL_API_TOKEN`, which names no stage. It is taken while the
 *   stages move over to tokens of their own (docs/architecture/stages.md, phase 5), and answered as before.
 */
export type UploaderCaller = { kind: 'shared' } | { kind: 'stage'; stageId: string; owner: string; name: string };

/**
 * Which streams an uploader's call may touch: those on one stage, or, for a caller on the shared token, every
 * stream, as before stages had tokens of their own.
 */
export type UploaderScope = { stageId: string } | null;

export function scopeOf(caller: UploaderCaller): UploaderScope {
  return caller.kind === 'stage' ? { stageId: caller.stageId } : null;
}

/**
 * Whether a stream is one the scope may touch. A stream with no stage (a row older than stages) is on no stage, so
 * only the shared token reaches it.
 */
export function inScope(stream: Pick<StreamRow, 'stage_id'>, scope: UploaderScope): boolean {
  return scope === null || stream.stage_id === scope.stageId;
}
