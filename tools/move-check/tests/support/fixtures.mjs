import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Settings every test repository runs with, so no hook, signing key or password prompt takes part. */
const GIT_ISOLATION = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

/** Variables that point git at some other repository, as a git hook sets them. */
const INHERITED_GIT_LOCATION = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]);

const TEST_IDENTITY = {
  GIT_AUTHOR_NAME: 'Move Check',
  GIT_AUTHOR_EMAIL: 'move-check@example.invalid',
  GIT_COMMITTER_NAME: 'Move Check',
  GIT_COMMITTER_EMAIL: 'move-check@example.invalid',
};

/** The environment for git and for the scripts under test: no system or user git config, a fixed identity. */
export const TEST_ENV = Object.freeze({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED_GIT_LOCATION.has(name))),
  ...TEST_IDENTITY,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
});

/** Makes an empty directory that is removed when the test ends. */
export function makeTempDir(t, label = 'move-check-') {
  const dir = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs git in a test repository and returns what it printed. */
export function git(repo, ...args) {
  return gitWithInput(repo, '', ...args);
}

/** Runs git in a test repository with `input` on its standard input. */
export function gitWithInput(repo, input, ...args) {
  return execFileSync('git', [...GIT_ISOLATION, ...args], { cwd: repo, env: TEST_ENV, encoding: 'utf8', input });
}

/** Makes an empty repository on a branch named main, removed when the test ends. */
export function makeRepo(t) {
  const repo = makeTempDir(t, 'move-check-repo-');
  git(repo, 'init', '--quiet', '--initial-branch=main');
  return repo;
}

/** Writes files given as `{ 'relative/path': content }`, creating their directories. */
export function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Stages every change in the working tree, commits it and returns the commit id. */
export function commitAll(repo, message) {
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--allow-empty', '--message', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

/** Runs one of the kit's scripts the way a colleague would and captures both streams and the exit code. */
export function runScript(script, args, { cwd, env = TEST_ENV } = {}) {
  const result = spawnSync(process.execPath, [join(KIT_DIR, script), ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
