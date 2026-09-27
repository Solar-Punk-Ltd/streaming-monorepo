import { describe, run } from './run.js';
import { CollectionError } from './types.js';

/**
 * Resolve a base ref that exists, preferring the local branch and falling back to its remote.
 *
 * A CI checkout is shallow and single-branch, and a single-branch clone or a worktree holds no local
 * branch nobody created in it, so a bare branch name resolves on one machine and not on the next.
 * Failing over to `origin/` makes the same invocation work in all of them, and failing loudly when
 * neither resolves beats measuring against nothing.
 *
 * The run resolves the base once and hands the result to every collector that reads it. The lockfile
 * read used to take the name as given while the diff fell back, so it stopped at "invalid object name"
 * in exactly the checkouts the fallback exists for.
 */
export async function resolveBase(base: string): Promise<string> {
  for (const candidate of [base, `origin/${base}`]) {
    const check = await run('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (check.exitCode === 0) {
      return candidate;
    }
  }
  throw new CollectionError(
    describe('git', ['rev-parse', '--verify', base]),
    `neither \`${base}\` nor \`origin/${base}\` resolves. A shallow or single-branch clone needs \`git fetch origin ${base}\` first.`,
  );
}
