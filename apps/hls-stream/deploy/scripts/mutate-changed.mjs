/**
 * Mutation testing on the lines a branch changed, through the stack's two Stryker configurations.
 *
 * `pnpm mutate` and `pnpm mutate:client` mutate everything their configuration names, which takes long enough
 * that nobody runs it on a branch. The question a branch asks is narrower: do the tests that came with this
 * change catch a change in its behaviour, or do they only run its lines. Stryker's `--mutate` takes a range per
 * file, `path:startLine-endLine`, so a zero-context diff maps onto it and nothing outside the change is mutated.
 *
 * Run it from `apps/hls-stream` with `pnpm mutate:changed`. The base is `origin/main-v3`, or `MUTATION_BASE`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const STACK_ROOT = path.resolve(import.meta.dirname, '../..');
const BASE_REF = process.env.MUTATION_BASE ?? 'origin/main-v3';

/** Absolute paths rather than a bare name, so the call never takes a `git` from a writable PATH entry. */
const GIT = ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find((candidate) => existsSync(candidate));

/** Where a container's cpu ceiling is written. The host's core count says nothing about it. */
const CGROUP_CPU_MAX = '/sys/fs/cgroup/cpu.max';

const SHORT_SHA = 8;

/**
 * @typedef {object} MutationTarget
 * @property {string} config The Stryker configuration, relative to the stack.
 * @property {RegExp} mutable The files that configuration's `mutate` globs name, relative to the stack.
 */

/** @type {MutationTarget[]} */
export const MUTATION_TARGETS = [
  { config: 'stryker.config.json', mutable: /^packages\/(?:stream-uploader|shared)\/src\/.+\.ts$/ },
  { config: 'stryker.client.config.json', mutable: /^packages\/client\/src\/(?!.+\.d\.ts$).+\.tsx?$/ },
];

const DIFF_HEADER = /^\+\+\+ b\/(.+)$/;
const DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The line ranges a zero-context diff adds, per file the target mutates.
 *
 * @param {string} diffText `git diff --unified=0` output, paths relative to the repository root.
 * @param {MutationTarget} target
 * @param {string} stackPrefix The stack's folder inside the repository.
 * @returns {Map<string, string[]>} Stack-relative file to `start-end` ranges.
 */
export function changedRanges(diffText, target, stackPrefix = 'apps/hls-stream/') {
  const ranges = new Map();
  let file = null;
  for (const line of diffText.split('\n')) {
    const header = DIFF_HEADER.exec(line);
    if (header) {
      const relative = header[1].startsWith(stackPrefix) ? header[1].slice(stackPrefix.length) : null;
      file = relative && target.mutable.test(relative) ? relative : null;
      continue;
    }
    const hunk = DIFF_HUNK.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    ranges.set(file, [...(ranges.get(file) ?? []), `${start}-${start + count - 1}`]);
  }
  return ranges;
}

/** @param {Map<string, string[]>} ranges */
export function mutateArgument(ranges) {
  return [...ranges].flatMap(([file, spans]) => spans.map((span) => `${file}:${span}`)).join(',');
}

/**
 * Half the cpu ceiling, since each Stryker worker starts a test process of its own.
 *
 * @param {string | undefined} cgroupCpuMax The contents of `cpu.max`, `<quota> <period>` or `max <period>`.
 * @param {number} cores The host's cores, used when no ceiling is set.
 */
export function workerCount(cgroupCpuMax, cores) {
  let ceiling = cores;
  if (cgroupCpuMax) {
    const [quota, period] = cgroupCpuMax.trim().split(/\s+/);
    if (quota !== 'max') ceiling = Math.max(1, Math.floor(Number(quota) / Number(period)));
  }
  return Math.max(1, Math.floor(ceiling / 2));
}

function git(...args) {
  if (!GIT) throw new Error('mutate:changed: no git at any of the fixed paths this script looks in');
  return execFileSync(GIT, args, { cwd: STACK_ROOT, encoding: 'utf8' });
}

function mergeBase() {
  try {
    return git('merge-base', BASE_REF, 'HEAD').trim();
  } catch {
    // A base that cannot be resolved must never turn into "nothing changed", which reads as a clean run.
    throw new Error(`mutate:changed: cannot find a merge base with ${BASE_REF}. Fetch it, or set MUTATION_BASE.`);
  }
}

function main() {
  const base = mergeBase();
  const diffText = git('diff', '--unified=0', '--diff-filter=ACMR', base, '--', 'packages');
  const workers = workerCount(existsSync(CGROUP_CPU_MAX) ? readFileSync(CGROUP_CPU_MAX, 'utf8') : undefined, availableParallelism());
  let ran = 0;
  for (const target of MUTATION_TARGETS) {
    const ranges = changedRanges(diffText, target);
    if (ranges.size === 0) {
      console.log(`mutate:changed: ${target.config}: no file it mutates changed against ${BASE_REF} (${base.slice(0, SHORT_SHA)})`);
      continue;
    }
    console.log(`mutate:changed: ${target.config}: ${ranges.size} file(s) against ${base.slice(0, SHORT_SHA)}, ${workers} worker(s)`);
    for (const file of ranges.keys()) console.log(`  ${file}`);
    execFileSync(
      path.join(STACK_ROOT, 'node_modules/.bin/stryker'),
      ['run', target.config, '--mutate', mutateArgument(ranges), '--concurrency', String(workers)],
      { cwd: STACK_ROOT, stdio: 'inherit' },
    );
    ran += 1;
  }
  if (ran === 0) console.log('mutate:changed: nothing to mutate');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}
