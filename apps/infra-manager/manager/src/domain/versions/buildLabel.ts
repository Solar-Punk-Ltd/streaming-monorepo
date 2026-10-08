import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isBuildLabel } from '@streaming-infra-manager/common';

/**
 * The release a build of the stack is made as. docs/features/stack-versions.md,
 * "Versions page".
 *
 * The bundled version's build is named by the label the manager itself was
 * deployed with, which the deploy hands the api as MANAGER_VERSION. A version
 * an operator added is named by the tag on the commit it built, read in that
 * version's own clone, by the rules `tools/release/version.mjs` names a deploy
 * by: an app cannot import tools/, so they are written again here. Two
 * differences, both because a clone holds only committed history: no short
 * commit stands in for a missing tag, and nothing is ever `-dirty`.
 */

const execFileAsync = promisify(execFile);

/** Where the manager's deploy names the build it sent, for the api to read. */
export const MANAGER_VERSION_VARIABLE = 'MANAGER_VERSION';

/**
 * The label the manager was deployed with, or null when the deploy named none
 * or named something that is not a label.
 */
export function deployedManagerLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[MANAGER_VERSION_VARIABLE];
  return isBuildLabel(value) ? value : null;
}

/** The longest tag name a label is made from, as `tools/release/lib/tagName.mjs` has it. */
export const TAG_NAME_MAX_LENGTH = 80;

const TAG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._+/-]*$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/**
 * Whether a tag name may name a build: letters and digits first, then
 * letters, digits and `. _ + / -`, at most 80 characters, and none of what git
 * refuses in a ref name within that set. The rule of
 * `tools/release/lib/tagName.mjs`, so a tag the guided script makes is
 * always one this takes.
 */
export function isSafeTagName(name: string): boolean {
  if (name === '' || name.length > TAG_NAME_MAX_LENGTH || !TAG_SHAPE.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('/.')) return false;
  if (name.endsWith('.') || name.endsWith('/')) return false;
  return !name.split('/').some((part) => part.endsWith('.lock'));
}

/**
 * The tag names `git describe` leaves out, so the nearest tag it answers is the
 * nearest one this takes rather than one passed over: a character outside the
 * set, a first character that is no letter or digit, more than 80 characters.
 */
const DESCRIBE_EXCLUDES = ['*[!A-Za-z0-9._+/-]*', '[!A-Za-z0-9]*', `${'?'.repeat(TAG_NAME_MAX_LENGTH + 1)}*`].flatMap(
  (pattern) => ['--exclude', pattern],
);

/**
 * What a hook or `git rebase --exec` exports to point every git command at one
 * repository. The clone is named by its folder, so none of them may reach the
 * git run here.
 */
const LOCATING_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
] as const;

/** The environment git runs in: the manager's own, less what would point it at another repository. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of LOCATING_VARIABLES) delete copy[name];
  return copy;
}

const GIT_TIMEOUT_MS = 30_000;

/**
 * Runs git on the clone and answers its trimmed output, or throws with git's
 * own words. The repository is named rather than found, so a clone whose
 * `.git` is broken fails here instead of git walking up to whatever
 * repository holds the versions root.
 */
async function git(clone: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [`--git-dir=${join(clone, '.git')}`, ...args], {
      cwd: clone,
      env: gitEnv(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : String(error);
    throw new Error(`git ${args[0]} failed: ${detail}`, { cause: error });
  }
}

/**
 * The release of a commit, read in a version's own clone: the newest annotated
 * tag on the commit, else the newest lightweight one, else the nearest tag
 * before it and how many commits the build is past it, `<tag>+<n>`, else null.
 * A tag whose name `isSafeTagName` refuses is passed over at every step.
 *
 * Null as well for a clone that is not there or a commit that is not one,
 * which the build script makes impossible and a test stands in for. Throws
 * when git fails at reading the tags it has, and the caller keeps the build
 * without a label rather than failing it.
 */
export async function releaseOfCommit(clone: string, commit: string): Promise<string | null> {
  if (!COMMIT_RE.test(commit) || !existsSync(join(clone, '.git'))) return null;
  const onCommit = await tagOn(clone, commit);
  const label = onCommit ?? (await nearestTagPast(clone, commit));
  return isBuildLabel(label) ? label : null;
}

// An annotated tag before a lightweight one, which is what a mistyped `git tag
// list` leaves, and the newest first among equals.
async function tagOn(clone: string, commit: string): Promise<string | null> {
  const out = await git(clone, [
    'for-each-ref',
    `--points-at=${commit}`,
    '--sort=-creatordate',
    '--format=%(objecttype) %(refname:lstrip=2)',
    'refs/tags',
  ]);
  const tags = out === '' ? [] : out.split('\n').map(parseTagLine);
  const safe = tags.filter((tag) => isSafeTagName(tag.name));
  return (safe.find((tag) => tag.annotated) ?? safe[0])?.name ?? null;
}

function parseTagLine(line: string): { annotated: boolean; name: string } {
  const space = line.indexOf(' ');
  return { annotated: line.slice(0, space) === 'tag', name: line.slice(space + 1) };
}

/** `<tag>+<n>` for the nearest tag the commit descends from, or null when it descends from none this takes. */
async function nearestTagPast(clone: string, commit: string): Promise<string | null> {
  let nearest: string;
  try {
    nearest = await git(clone, ['describe', '--tags', '--abbrev=0', ...DESCRIBE_EXCLUDES, commit]);
  } catch {
    // git describe fails for a commit no tag is behind, which is no label
    // rather than a problem.
    return null;
  }
  if (!isSafeTagName(nearest)) return null;
  const distance = await git(clone, ['rev-list', '--count', `refs/tags/${nearest}..${commit}`]);
  return /^\d+$/.test(distance) ? `${nearest}+${distance}` : null;
}
