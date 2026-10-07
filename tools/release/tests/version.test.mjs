import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitEnv } from '../lib/git.mjs';
import { describeVersion, formatEnv } from '../version.mjs';

// The user's own git configuration stays out of every git these tests start, theirs and the script's: a global
// tag.gpgSign, hooksPath or excludesFile would change what a scratch repository does.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const SCRIPT = fileURLToPath(new URL('../version.mjs', import.meta.url));
const SAFE_VALUE = /^[A-Za-z0-9._+/-]*$/;
const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-version-'));
  scratch.push(dir);
  let clock = 1_790_000_000;
  const runAt = (seconds, args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...gitEnv(),
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_AUTHOR_DATE: `${seconds} +0000`,
        GIT_COMMITTER_DATE: `${seconds} +0000`,
      },
    }).trim();
  const run = (...args) => {
    clock += 60;
    return runAt(clock, args);
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  run('init', '-q', '-b', 'main');
  write('.gitignore', '.env.*\n');
  write('apps/a/index.ts', 'export {};\n');
  write('apps/b/index.ts', 'export {};\n');
  write('packages/shared/index.ts', 'export {};\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'first');
  return {
    dir,
    write,
    commit(message) {
      write(`log/${message}.txt`, `${message}\n`);
      run('add', '-A');
      run('commit', '-q', '-m', message);
    },
    annotatedTag(name, seconds) {
      if (seconds === undefined) run('tag', '-a', name, '-m', name);
      else runAt(seconds, ['tag', '-a', name, '-m', name]);
    },
    lightweightTag(name) {
      run('tag', name);
    },
    // A tag git tag would never make, such as one starting with a dash: update-ref writes any name git takes in a ref.
    refTag(name) {
      run('update-ref', `refs/tags/${name}`, 'HEAD');
    },
    head: () => run('rev-parse', 'HEAD'),
  };
}

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: gitEnv() });
}

describe('the version of a build', () => {
  it('is the short commit when no tag is behind it', () => {
    const repo = scratchRepo();
    const version = describeVersion({ root: repo.dir });
    assert.equal(version.commit, repo.head());
    assert.match(version.commit, /^[0-9a-f]{40}$/);
    assert.equal(version.short, version.commit.slice(0, 9));
    assert.deepEqual(
      { tag: version.tag, label: version.label, dirty: version.dirty },
      {
        tag: '',
        label: version.short,
        dirty: false,
      },
    );
  });

  it('is the tag on its commit', () => {
    const repo = scratchRepo();
    repo.annotatedTag('QA-build-2026-10-07');
    const version = describeVersion({ root: repo.dir });
    assert.equal(version.tag, 'QA-build-2026-10-07');
    assert.equal(version.label, 'QA-build-2026-10-07');
  });

  it('takes an annotated tag over a newer lightweight one on the same commit', () => {
    const repo = scratchRepo();
    repo.annotatedTag('QA-build-2026-10-07', 1_700_000_000);
    repo.lightweightTag('list');
    assert.equal(describeVersion({ root: repo.dir }).tag, 'QA-build-2026-10-07');
  });

  it('takes the newest of two annotated tags on one commit', () => {
    const repo = scratchRepo();
    repo.annotatedTag('first-name');
    repo.annotatedTag('second-name');
    assert.equal(describeVersion({ root: repo.dir }).label, 'second-name');
  });

  it('is the nearest tag and the distance past it on an untagged commit', () => {
    const repo = scratchRepo();
    repo.annotatedTag('stack/v3.3');
    repo.commit('two');
    repo.commit('three');
    const version = describeVersion({ root: repo.dir });
    assert.equal(version.tag, '');
    assert.equal(version.label, 'stack/v3.3+2');
  });

  it('passes over a tag a shell or a page would have to quote', () => {
    const repo = scratchRepo();
    repo.lightweightTag("x'y");
    repo.annotatedTag('$(touch-pwned)');
    const version = describeVersion({ root: repo.dir });
    assert.equal(version.tag, '');
    assert.equal(version.label, version.short);
    repo.commit('two');
    assert.equal(describeVersion({ root: repo.dir }).label, describeVersion({ root: repo.dir }).short);
  });

  it('finds the nearest tag it can name past one it passes over', () => {
    const repo = scratchRepo();
    repo.annotatedTag('v1');
    repo.commit('two');
    repo.annotatedTag("x'y");
    repo.refTag('-dash');
    repo.commit('three');
    assert.equal(describeVersion({ root: repo.dir }).label, 'v1+2');
  });

  it('ends with -dirty when the app holds a change git has not committed', () => {
    const repo = scratchRepo();
    repo.annotatedTag('v1');
    repo.write('apps/a/index.ts', 'export const changed = true;\n');
    const version = describeVersion({ root: repo.dir, app: 'apps/a' });
    assert.equal(version.dirty, true);
    assert.equal(version.label, 'v1-dirty');
    assert.equal(version.tag, 'v1');
  });

  it('counts a change in the shared packages and the root install files', () => {
    const repo = scratchRepo();
    repo.write('packages/shared/index.ts', 'export const changed = true;\n');
    assert.equal(describeVersion({ root: repo.dir, app: 'apps/a' }).dirty, true);
  });

  it('leaves out changes to another app, ignored files, and nothing else', () => {
    const repo = scratchRepo();
    repo.write('apps/b/index.ts', 'export const changed = true;\n');
    repo.write('apps/a/.env.qa', 'SECRET=1\n');
    assert.equal(describeVersion({ root: repo.dir, app: 'apps/a' }).dirty, false);
    assert.equal(describeVersion({ root: repo.dir }).dirty, true, 'the whole checkout counts without --app');
    repo.write('apps/a/new-source.ts', 'export {};\n');
    assert.equal(describeVersion({ root: repo.dir, app: 'apps/a' }).dirty, true, 'a new file in the app counts');
  });

  it('prints lines a deploy script reads, every value without quoting', () => {
    const repo = scratchRepo();
    repo.annotatedTag('release/2026.10');
    repo.commit('two');
    const result = runScript(['--root', repo.dir, '--app', 'apps/a']);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.deepEqual(
      lines.map((line) => line.slice(0, line.indexOf('='))),
      ['VERSION_COMMIT', 'VERSION_SHORT', 'VERSION_TAG', 'VERSION_LABEL', 'VERSION_DIRTY'],
    );
    for (const line of lines) assert.match(line.slice(line.indexOf('=') + 1), SAFE_VALUE, line);
    assert.equal(result.stdout, formatEnv(describeVersion({ root: repo.dir, app: 'apps/a' })));
    assert.ok(lines.includes('VERSION_LABEL=release/2026.10+1'));
  });

  it('prints the same as JSON on request', () => {
    const repo = scratchRepo();
    const result = runScript(['--root', repo.dir, '--format=json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), describeVersion({ root: repo.dir }));
  });

  it('refuses a folder outside the checkout or one that does not exist', () => {
    const repo = scratchRepo();
    for (const app of ['../elsewhere', '/etc', 'apps/missing']) {
      const result = runScript(['--root', repo.dir, '--app', app]);
      assert.equal(result.status, 1, app);
      assert.match(result.stderr, /^version: --app /, app);
    }
  });

  it('says so outside a git checkout, and for an option it does not know', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'release-version-outside-'));
    scratch.push(outside);
    const result = runScript(['--root', outside]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not inside a git checkout/);
    assert.equal(runScript(['--format', 'xml']).status, 2);
    assert.equal(runScript(['--colour']).status, 2);
  });
});
