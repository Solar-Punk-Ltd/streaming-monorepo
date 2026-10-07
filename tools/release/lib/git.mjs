import { execFileSync } from 'node:child_process';

// What a git hook or `git rebase --exec` exports to point every git command at one repository. A script that finds
// its repository by folder must not inherit them: under `rebase --exec`, a `git init` in a scratch folder would
// otherwise re-initialise the checkout the rebase runs in.
const LOCATING_VARIABLES = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
]);

export function gitEnv(env = process.env) {
  const copy = { ...env };
  for (const name of LOCATING_VARIABLES) delete copy[name];
  return copy;
}

// Runs git in a folder and answers its trimmed output. A failure throws with git's own message, or answers null
// when the caller expects one.
export function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      env: gitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = String(error.stderr ?? '').trim() || error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`, { cause: error });
  }
}
