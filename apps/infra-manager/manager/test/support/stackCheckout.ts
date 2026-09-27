import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The streaming stack this manager ships with: `apps/hls-stream` of the same
 * monorepo commit, the tree a host builds as the bundled version. Tests that
 * hold the manager against the real stack read it from here, so they check
 * the stack of their own commit and need no submodule.
 */
export const STACK_CHECKOUT = fileURLToPath(new URL('../../../../hls-stream', import.meta.url));

/** A path inside that checkout, written the way the stack's own docs write it. */
export function stackFile(...segments: string[]): string {
  return join(STACK_CHECKOUT, ...segments);
}
