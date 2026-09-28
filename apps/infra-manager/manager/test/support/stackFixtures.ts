import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_IMAGE, PINNED_PNPM } from '../../src/domain/versions/StackVersionService.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The cut-down checkouts the contract tests read: `v2`, `v3` and `unparsable`. */
export const STACK_FIXTURES = join(here, '..', 'fixtures', 'stack');

export const V2_FIXTURE = join(STACK_FIXTURES, 'v2');
export const V3_FIXTURE = join(STACK_FIXTURES, 'v3');

/*
 * Where a new version is built from, written out rather than imported, so a
 * test that finds them in the build script's arguments proves the values and
 * not only that the manager hands its own constants along.
 */
export const MONOREPO_URL = 'https://github.com/Solar-Punk-Ltd/streaming-monorepo.git';
export const MONOREPO_STACK_FOLDER = 'apps/hls-stream';
/** The stack head the monorepo's import took in, the newest commit of the stack's own history. */
export const STACK_HISTORY_HEAD = 'b4912eb01dafb934cbb3bd9607c73724c5ec6bfb';
export const SWARM_HLS_STREAM_URL = 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git';

/** The image and the pnpm the build script records for a stack that names no pnpm of its own. */
export const PINNED_TOOLCHAIN = `${BUILD_IMAGE} ${PINNED_PNPM}`;

/**
 * What the build script leaves beside the built tree in a staging directory:
 * the commit it exported, the folder it took the stack from, and the image and
 * the pnpm it built with.
 */
export function leaveBuildMarkers(
  staging: string,
  commit: string,
  folder = MONOREPO_STACK_FOLDER,
  toolchain = PINNED_TOOLCHAIN,
): void {
  writeFileSync(join(staging, '.stack-commit'), `${commit}\n`);
  writeFileSync(join(staging, '.stack-folder'), `${folder}\n`);
  writeFileSync(join(staging, '.stack-toolchain'), `${toolchain}\n`);
}

/**
 * A throwaway versions root holding a copy of the `v3` fixture under the name
 * `v3`, committed to a git repository of its own, so a build reported as
 * successful finds a checkout that can be read for both a contract and a
 * commit. `v3` is therefore the only name a build can succeed under here.
 *
 * A copy rather than the fixture itself, and this is not a detail: removing a
 * version deletes its checkout, so a test pointed at the fixtures deletes them.
 * That is exactly what happened on the first run of the routes test, and the
 * next run failed somewhere else entirely.
 */
export function scratchVersionsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-versions-'));
  const checkout = join(root, 'v3');
  cpSync(V3_FIXTURE, checkout, { recursive: true });
  commitFixture(checkout);
  return root;
}

/** The commit `scratchVersionsRoot` left the copy on. */
export function checkoutCommit(checkout: string): string {
  return git(checkout, ['rev-parse', 'HEAD']);
}

/**
 * Moves the checkout on one commit and answers the new one, standing in for a
 * rebuild whose fetch found the branch somewhere else. Empty, because what the
 * manager reads off a rebuilt checkout is the commit and not the files.
 */
export function advanceCheckout(checkout: string): string {
  git(checkout, ['commit', '--quiet', '--allow-empty', '--message', 'the branch moved']);
  return checkoutCommit(checkout);
}

/**
 * One commit holding whatever is in the directory. The manager asks git which
 * commit a built version is on, so a fixture that stands in for a built version
 * has to be a git checkout rather than a plain directory of files.
 */
function commitFixture(checkout: string): void {
  git(checkout, ['init', '--quiet', '--initial-branch=main']);
  git(checkout, ['add', '--all']);
  git(checkout, ['commit', '--quiet', '--message', 'fixture']);
}

/**
 * The machine's own git configuration is kept out: a global commit.gpgsign or
 * a required signing key would fail a commit no test asked to sign.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=stack fixtures',
      '-c',
      'user.email=fixtures@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
}
