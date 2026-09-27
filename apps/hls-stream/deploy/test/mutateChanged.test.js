import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { changedRanges, MUTATION_TARGETS, mutateArgument, workerCount } from '../scripts/mutate-changed.mjs';

/**
 * The changed-lines mutation run: which lines of a diff each Stryker configuration is handed.
 *
 * A run that is handed nothing reports clean, so the failure worth guarding is a diff whose lines never reach
 * Stryker: a path read from the wrong root, a file one configuration mutates filed under the other, or a pure
 * deletion turned into a range that names no line.
 */

const STACK = new URL('../../', import.meta.url);

/** A zero-context diff as `git diff --unified=0` prints it from the repository root. */
const diff = (...files) =>
  files
    .map(({ path, hunks }) =>
      [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks.map((h) => `${h}\n+x`)].join('\n'),
    )
    .join('\n');

const uploader = MUTATION_TARGETS.find((t) => t.config === 'stryker.config.json');
const client = MUTATION_TARGETS.find((t) => t.config === 'stryker.client.config.json');

describe('changedRanges', () => {
  it('names the lines a hunk adds, relative to the stack', () => {
    const text = diff({
      path: 'apps/hls-stream/packages/stream-uploader/src/uploader.ts',
      hunks: ['@@ -10,2 +10,3 @@', '@@ -40 +41 @@'],
    });
    assert.deepEqual(changedRanges(text, uploader), new Map([['packages/stream-uploader/src/uploader.ts', ['10-12', '41-41']]]));
  });

  it('leaves out a pure deletion, which has no line left to mutate', () => {
    const text = diff({ path: 'apps/hls-stream/packages/shared/src/index.ts', hunks: ['@@ -5,3 +4,0 @@'] });
    assert.deepEqual(changedRanges(text, uploader), new Map());
  });

  it('gives each configuration only the files it mutates', () => {
    const text = diff(
      { path: 'apps/hls-stream/packages/shared/src/feed.ts', hunks: ['@@ -1 +1 @@'] },
      { path: 'apps/hls-stream/packages/client/src/App.tsx', hunks: ['@@ -2 +2,2 @@'] },
      { path: 'apps/hls-stream/packages/client/src/vite-env.d.ts', hunks: ['@@ -1 +1 @@'] },
      { path: 'apps/hls-stream/packages/stream-uploader/test/uploader.test.ts', hunks: ['@@ -1 +1 @@'] },
      { path: 'apps/hls-stream/packages/cli/src/main.ts', hunks: ['@@ -1 +1 @@'] },
    );
    assert.deepEqual([...changedRanges(text, uploader).keys()], ['packages/shared/src/feed.ts']);
    assert.deepEqual(changedRanges(text, client), new Map([['packages/client/src/App.tsx', ['2-3']]]));
  });
});

describe('mutateArgument', () => {
  it("writes Stryker's path:start-end list", () => {
    const ranges = new Map([
      ['packages/shared/src/a.ts', ['1-2', '9-9']],
      ['packages/shared/src/b.ts', ['4-4']],
    ]);
    assert.equal(mutateArgument(ranges), 'packages/shared/src/a.ts:1-2,packages/shared/src/a.ts:9-9,packages/shared/src/b.ts:4-4');
  });
});

describe('workerCount', () => {
  it("takes half a container's cpu ceiling rather than the host's cores", () => {
    assert.equal(workerCount('600000 100000', 64), 3);
  });

  it('takes half the cores where the cgroup sets no ceiling or there is none', () => {
    assert.equal(workerCount('max 100000', 12), 6);
    assert.equal(workerCount(undefined, 12), 6);
  });

  it('never goes below one', () => {
    assert.equal(workerCount('50000 100000', 1), 1);
  });
});

describe('the mutation targets', () => {
  // The targets restate each configuration's globs as a pattern, so a glob changed there must be changed here.
  it('are the two configurations, whose mutate globs the patterns were written from', () => {
    const expected = {
      'stryker.config.json': ['packages/stream-uploader/src/**/*.ts', 'packages/shared/src/**/*.ts'],
      'stryker.client.config.json': ['packages/client/src/**/*.{ts,tsx}', '!packages/client/src/**/*.d.ts'],
    };
    for (const target of MUTATION_TARGETS) {
      const config = JSON.parse(readFileSync(new URL(target.config, STACK), 'utf8'));
      assert.deepEqual(config.mutate, expected[target.config], target.config);
    }
    assert.equal(MUTATION_TARGETS.length, 2);
  });
});
