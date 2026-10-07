/**
 * The release a build of the stack is made as: the label the manager was
 * deployed with for the bundled version, and the tag on the commit, read in the
 * version's own clone, for one an operator added. The same rules
 * `tools/release/version.mjs` names a deploy by, and its own test is the model
 * for this one.
 *
 * Unit test against scratch git repositories, no network. `pnpm test` in
 * manager/.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  deployedManagerLabel,
  gitEnv,
  isSafeTagName,
  MANAGER_VERSION_VARIABLE,
  releaseOfCommit,
} from '../../src/domain/versions/buildLabel.js';
import { scratchRepo } from '../support/scratchGit.js';

// The machine's own git configuration stays out of the git the code under test
// starts as well as the git this file starts.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function clone() {
  const dir = mkdtempSync(join(tmpdir(), 'build-label-'));
  scratch.push(dir);
  return scratchRepo(dir);
}

describe('the label the bundled version is made as', () => {
  it('is MANAGER_VERSION, in every shape a deploy names a build with', () => {
    for (const label of [
      'QA-build-2026-10-07',
      'QA-build-2026-10-07+3',
      '635b4e175',
      '635b4e175-dirty',
      'QA-build-2026-10-07+3-dirty',
    ]) {
      assert.equal(deployedManagerLabel({ [MANAGER_VERSION_VARIABLE]: label }), label);
    }
  });

  it('is nothing when the deploy named none, or named something that is not a label', () => {
    assert.equal(deployedManagerLabel({}), null);
    for (const value of ['', ' QA-build', 'two words', "it's", '$(touch-pwned)', 'x'.repeat(97), 'a\nb']) {
      assert.equal(deployedManagerLabel({ [MANAGER_VERSION_VARIABLE]: value }), null, JSON.stringify(value));
    }
  });

  it("reads the api's own environment when it is asked", () => {
    const before = process.env[MANAGER_VERSION_VARIABLE];
    try {
      process.env[MANAGER_VERSION_VARIABLE] = 'QA-build-2026-10-07';
      assert.equal(deployedManagerLabel(), 'QA-build-2026-10-07');
      delete process.env[MANAGER_VERSION_VARIABLE];
      assert.equal(deployedManagerLabel(), null);
    } finally {
      if (before === undefined) delete process.env[MANAGER_VERSION_VARIABLE];
      else process.env[MANAGER_VERSION_VARIABLE] = before;
    }
  });
});

describe('the release of a commit an added version built', () => {
  it('is nothing when no tag is behind the commit', async () => {
    const repo = clone();
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), null);
  });

  it('is the tag on the commit', async () => {
    const repo = clone();
    repo.annotatedTag('QA-build-2026-10-07');
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), 'QA-build-2026-10-07');
  });

  it('takes an annotated tag over a newer lightweight one on the same commit', async () => {
    const repo = clone();
    repo.annotatedTag('QA-build-2026-10-07', { seconds: 1_700_000_000 });
    repo.lightweightTag('list');
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), 'QA-build-2026-10-07');
  });

  it('takes the newest of two annotated tags on one commit', async () => {
    const repo = clone();
    repo.annotatedTag('first-name');
    repo.annotatedTag('second-name');
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), 'second-name');
  });

  it('takes a lightweight tag when the commit carries no annotated one', async () => {
    const repo = clone();
    repo.lightweightTag('hand-made');
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), 'hand-made');
  });

  it('is the nearest tag and the distance past it on an untagged commit', async () => {
    const repo = clone();
    repo.annotatedTag('stack/v3.3');
    repo.commit('two');
    repo.commit('three');
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), 'stack/v3.3+2');
  });

  it('names the commit it is asked about, not the one the clone has checked out', async () => {
    const repo = clone();
    const tagged = repo.head();
    repo.annotatedTag('QA-build-2026-10-07');
    const next = repo.commit('two');
    repo.commit('three');
    assert.equal(await releaseOfCommit(repo.dir, tagged), 'QA-build-2026-10-07');
    assert.equal(await releaseOfCommit(repo.dir, next), 'QA-build-2026-10-07+1');
  });

  it('passes over a tag a shell or a page would have to quote, on the commit and behind it', async () => {
    const repo = clone();
    repo.annotatedTag('v1');
    repo.commit('two');
    repo.lightweightTag("x'y");
    repo.annotatedTag('$(touch-pwned)');
    repo.annotatedTag('x'.repeat(81));
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), 'v1+1', 'the nearest tag this takes');
    repo.commit('three');
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), 'v1+2');
  });

  it('is nothing when every tag behind the commit is one it passes over', async () => {
    const repo = clone();
    repo.annotatedTag('$(touch-pwned)');
    repo.commit('two');
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), null);
  });

  it('takes a tag of up to 80 characters, with every character a tag script allows', async () => {
    const repo = clone();
    const name = `release/2026.10_rc+1-${'x'.repeat(59)}`;
    assert.equal(name.length, 80);
    repo.annotatedTag(name);
    assert.equal(await releaseOfCommit(repo.dir, repo.head()), name);
  });

  it('is nothing for a clone that is not there, or a commit that is not one', async () => {
    const repo = clone();
    assert.equal(await releaseOfCommit(join(repo.dir, 'missing'), repo.head()), null);
    assert.equal(await releaseOfCommit(repo.dir, 'HEAD'), null);
    assert.equal(await releaseOfCommit(repo.dir, '--upload-pack=touch'), null);
  });

  it('is nothing for a commit the clone does not hold', async () => {
    const repo = clone();
    repo.annotatedTag('v1');
    assert.equal(await releaseOfCommit(repo.dir, 'f'.repeat(40)), null);
  });

  it('says what git said when it cannot read the clone, so the caller can keep the build without a label', async () => {
    const broken = mkdtempSync(join(tmpdir(), 'build-label-broken-'));
    scratch.push(broken);
    mkdirSync(join(broken, '.git'));
    await assert.rejects(releaseOfCommit(broken, 'a'.repeat(40)), /git for-each-ref failed/);
  });

  it('never reads another repository than the clone, even one around a broken clone', async () => {
    const around = clone();
    around.annotatedTag('the-repository-around-it');
    const broken = join(around.dir, 'versions', 'review-stack.repo');
    mkdirSync(join(broken, '.git'), { recursive: true });
    await assert.rejects(releaseOfCommit(broken, around.head()), /git for-each-ref failed/);
  });

  it('reads the clone it is given whatever GIT_DIR the api inherited', async () => {
    const elsewhere = clone();
    elsewhere.annotatedTag('the-wrong-repository');
    const repo = clone();
    repo.annotatedTag('the-clone');
    const before = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(elsewhere.dir, '.git');
      assert.equal(await releaseOfCommit(repo.dir, repo.head()), 'the-clone');
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });
});

describe('the environment that git runs in', () => {
  it('drops every variable that points git at one repository and keeps the rest', () => {
    const env = gitEnv({
      GIT_DIR: '/x/.git',
      GIT_WORK_TREE: '/x',
      GIT_INDEX_FILE: '/x/.git/index',
      GIT_COMMON_DIR: '/x/.git',
      GIT_OBJECT_DIRECTORY: '/x/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/y',
      GIT_PREFIX: 'sub/',
      GIT_NAMESPACE: 'ns',
      GIT_CONFIG_NOSYSTEM: '1',
      PATH: '/usr/bin',
    });
    assert.deepEqual(env, { GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin' });
  });
});

describe('which tag names may name a build', () => {
  it('takes the names the tag script makes', () => {
    for (const name of ['QA-build-2026-10-07', 'stack/v3.3', 'release/2026.10_rc+1', 'v1', '9']) {
      assert.equal(isSafeTagName(name), true, name);
    }
  });

  it('refuses the names tools/release/lib/tagName.mjs refuses', () => {
    for (const name of [
      '',
      'x'.repeat(81),
      '-leading-dash',
      '.leading-dot',
      'two words',
      "x'y",
      '$(touch-pwned)',
      'a..b',
      'a//b',
      'a/.b',
      'ends.',
      'ends/',
      'part.lock/x',
      'x.lock',
    ]) {
      assert.equal(isSafeTagName(name), false, JSON.stringify(name));
    }
  });
});
