import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Settings every test repository runs with, so no hook, signing key or password prompt takes part. */
const GIT_ISOLATION = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

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

/** The environment for git and for the scripts under test: no system or user git config, a fixed identity. */
export const TEST_ENV = Object.freeze({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED_GIT_LOCATION.has(name))),
  GIT_AUTHOR_NAME: 'App Workspace',
  GIT_AUTHOR_EMAIL: 'app-workspace@example.invalid',
  GIT_COMMITTER_NAME: 'App Workspace',
  GIT_COMMITTER_EMAIL: 'app-workspace@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
});

/** Makes an empty directory that is removed when the test ends. */
export function makeTempDir(t, label = 'app-workspace-') {
  const dir = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes each `relative path: text` pair under `dir`, making folders as needed. */
export function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/** Runs one of the tool's scripts with node, never through a shell, and returns its status and both streams. */
export function runScript(script, args, { cwd, env = TEST_ENV } = {}) {
  const result = spawnSync(process.execPath, [join(TOOL_DIR, script), ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function git(dir, args) {
  return execFileSync('git', [...GIT_ISOLATION, ...args], { cwd: dir, env: TEST_ENV, encoding: 'utf8' });
}

/** Makes `dir` a git repository holding everything in it that .gitignore does not ignore, committed once. */
export function commitAll(dir) {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
}
