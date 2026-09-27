import { describe, run } from './run.js';
import { mutationApplicability, surfacesTouched } from './surfaces.js';
import { CollectionError, type FactGroup } from './types.js';

/** Sum the added and removed line counts `git diff --numstat` reports for the given paths. */
export function totalLines(numstat: string): number {
  let total = 0;
  for (const line of numstat.split('\n')) {
    const [added, removed] = line.split('\t');
    // A binary file reports "-" for both counts, which is not a line count and must not become NaN.
    // An empty trailing line splits to [''], and Number('') is 0, so it contributes nothing.
    if (Number.isFinite(Number(added))) {
      total += Number(added);
    }
    if (Number.isFinite(Number(removed))) {
      total += Number(removed);
    }
  }
  return total;
}

/**
 * Run a git command, refusing to treat a failure as an empty result.
 *
 * Every count in this group is derived from git output, and git prints nothing to stdout when it
 * fails. Without this the artifact renders a change as zero files, zero lines and no surfaces, marks
 * nothing as failed, and exits 0.
 */
async function git(args: string[]): Promise<string> {
  const result = await run('git', args);
  if (result.exitCode !== 0) {
    throw new CollectionError(describe('git', args), result.stderr.trim() || `exit ${result.exitCode}`);
  }
  return result.stdout;
}

/**
 * The facts the diff-size ceiling and the mutation trigger are both decided on.
 *
 * Both rules used to be settled by the author's own description of their own change, which is the
 * shape of claim this whole artifact exists to remove.
 *
 * `base` arrives resolved by `resolveBase`, the same ref the lockfile is read from.
 */
export async function collectDiff(base: string, head: string): Promise<FactGroup> {
  const range = `${base}..${head}`;
  // `--relative` names each changed path from the working folder, which is the stack's, and leaves out
  // every path outside it. From the root of the stack's own repository it changes nothing.
  const namesArgs = ['diff', '--name-only', '--relative', range];
  const paths = (await git(namesArgs)).split('\n').filter((p) => p.length > 0);

  // git reads a pathspec from the working folder already, so this counts the stack's source alone.
  const srcArgs = ['diff', '--numstat', range, '--', '*/src/*'];
  const srcStat = await git(srcArgs);

  const commitsArgs = ['rev-list', '--count', range];
  const commits = await git(commitsArgs);

  const surfaces = surfacesTouched(paths);
  const mutation = mutationApplicability(paths);

  return {
    title: 'Diff',
    facts: [
      { key: 'files changed', value: String(paths.length), command: describe('git', namesArgs) },
      { key: 'commits', value: commits.trim(), command: describe('git', commitsArgs) },
      { key: 'src lines changed', value: String(totalLines(srcStat)), command: describe('git', srcArgs) },
      {
        key: 'surfaces touched',
        value: surfaces.length > 0 ? `${surfaces.length} (${surfaces.join(', ')})` : 'none',
        command: describe('git', namesArgs),
        // An unclassified path is a hole in the catalogue, and the surface count is the binding half
        // of the diff ceiling, so a path in no bucket makes the cap read lower than it is.
        failed: surfaces.includes('unclassified'),
      },
      {
        key: 'mutation check',
        value: mutation.state,
        command: describe('git', namesArgs),
      },
      ...(mutation.uncovered.length > 0
        ? [
            {
              key: 'source with no mutation harness',
              value: `${mutation.uncovered.length}: ${mutation.uncovered.join(', ')}`,
              command: describe('git', namesArgs),
            },
          ]
        : []),
    ],
  };
}
