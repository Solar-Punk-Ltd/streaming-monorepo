import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { gitEnv } from '../../src/domain/versions/buildLabel.js';

/**
 * The environment every git a test starts runs in: none of the variables a hook
 * or `git rebase --exec` exports to point git at one repository, so a `git
 * init` here can never reach the checkout the suite runs in, and none of the
 * machine's own configuration, so a global tag.gpgSign or hooksPath cannot
 * change what a scratch repository does. The rules of
 * `tools/release/tests/version.test.mjs`.
 */
export function scratchGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...gitEnv(process.env),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...extra,
  };
}

/** A repository of a test's own, one commit in, with a clock that moves a minute per command. */
export interface ScratchRepo {
  dir: string;
  /** Runs git in the repository and answers its trimmed output. */
  git(...args: string[]): string;
  /** A new commit, and its id. */
  commit(message: string): string;
  /** An annotated tag on HEAD, or on `target`, made at `seconds` when given. */
  annotatedTag(name: string, options?: { target?: string; seconds?: number }): void;
  lightweightTag(name: string, target?: string): void;
  head(): string;
}

export function scratchRepo(dir: string = mkdtempSync(join(tmpdir(), 'scratch-git-'))): ScratchRepo {
  mkdirSync(dir, { recursive: true });
  let clock = 1_790_000_000;
  const runAt = (seconds: number, args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scratchGitEnv({ GIT_AUTHOR_DATE: `${seconds} +0000`, GIT_COMMITTER_DATE: `${seconds} +0000` }),
    }).trim();
  const run = (...args: string[]): string => {
    clock += 60;
    return runAt(clock, args);
  };
  const commit = (message: string): string => {
    const file = join(dir, 'log', `${message.replace(/[^A-Za-z0-9]+/g, '-')}.txt`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${message}\n`);
    run('add', '-A');
    run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  run('init', '-q', '-b', 'main');
  commit('first');
  return {
    dir,
    git: run,
    commit,
    annotatedTag(name, { target = 'HEAD', seconds } = {}) {
      const args = ['tag', '-a', name, '-m', name, target];
      if (seconds === undefined) run(...args);
      else runAt(seconds, args);
    },
    lightweightTag(name, target = 'HEAD') {
      run('tag', name, target);
    },
    head: () => run('rev-parse', 'HEAD'),
  };
}
