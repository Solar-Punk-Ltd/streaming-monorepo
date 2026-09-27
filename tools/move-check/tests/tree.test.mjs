import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { CheckError, UsageError, parsePrefixMaps } from '../lib/shared.mjs';
import { compareTrees, parseLsTree, parseTreeSpec, renameEntries } from '../tree.mjs';
import { TEST_ENV, commitAll, git, gitWithInput, makeRepo, runScript, writeFiles } from './support/fixtures.mjs';

const TREE = 'tree.mjs';

const ADMIN_FILES = {
  'web2-admin/backend/src/app.ts': 'export const app = 1\n',
  'web2-admin/common/src/index.ts': 'export type Id = string\n',
  'deploy/deploy.sh': '#!/bin/sh\necho deploy\n',
  'pnpm-workspace.yaml': 'packages:\n  - web2-admin/*\n',
};

/** A repository whose second commit moves web2-admin/ to apps/web2-admin/ with git mv and changes nothing else. */
function repoWithMove(t) {
  const repo = makeRepo(t);
  writeFiles(repo, ADMIN_FILES);
  const before = commitAll(repo, 'before the move');
  mkdirSync(join(repo, 'apps'));
  git(repo, 'mv', 'web2-admin', 'apps/web2-admin');
  const after = commitAll(repo, 'the move');
  return { repo, before, after };
}

function lines(text) {
  return text.trimEnd().split('\n');
}

describe('parseTreeSpec', () => {
  it('reads a bare revision as the root of that revision', () => {
    assert.deepEqual(parseTreeSpec('HEAD'), { text: 'HEAD', rev: 'HEAD', dir: '' });
  });

  it('reads <rev>:<dir> and drops a trailing slash', () => {
    assert.deepEqual(parseTreeSpec('main:apps/web2-admin/'), { text: 'main:apps/web2-admin/', rev: 'main', dir: 'apps/web2-admin' });
  });

  it('reads a directory relative to the repository root, whatever a leading ./ says', () => {
    assert.equal(parseTreeSpec('main:./apps').dir, 'apps');
  });

  it('reads an empty directory as the root', () => {
    assert.equal(parseTreeSpec('main:').dir, '');
  });

  it('refuses a directory with no revision', () => {
    assert.throws(() => parseTreeSpec(':apps'), UsageError);
  });
});

describe('parseLsTree', () => {
  it('reads mode, type, object id and a path that may hold tabs', () => {
    const output = '100644 blob 1111111111111111111111111111111111111111\tdir/a\tb.txt\x00160000 commit 2222222222222222222222222222222222222222\tvendor/lib\x00';
    assert.deepEqual(parseLsTree(output), [
      { mode: '100644', type: 'blob', objectId: '1111111111111111111111111111111111111111', path: 'dir/a\tb.txt' },
      { mode: '160000', type: 'commit', objectId: '2222222222222222222222222222222222222222', path: 'vendor/lib' },
    ]);
  });

  it('reads empty output as no entries', () => {
    assert.deepEqual(parseLsTree(''), []);
  });
});

describe('renameEntries', () => {
  const entry = (path) => ({ mode: '100644', type: 'blob', objectId: 'a'.repeat(40), path });

  it('keys each entry by its new path and keeps the old one', () => {
    const renamed = renameEntries([entry('web2-admin/a.ts')], parsePrefixMaps(['web2-admin=apps/web2-admin']));
    assert.deepEqual([...renamed.keys()], ['apps/web2-admin/a.ts']);
    assert.equal(renamed.get('apps/web2-admin/a.ts').originalPath, 'web2-admin/a.ts');
  });

  it('refuses a map that sends two paths to the same place', () => {
    assert.throws(
      () => renameEntries([entry('a/x'), entry('b/x')], parsePrefixMaps(['a=c', 'b=c'])),
      (error) => error instanceof CheckError && /a\/x/.test(error.message) && /b\/x/.test(error.message),
    );
  });
});

describe('compareTrees', () => {
  const blob = (objectId, mode = '100644') => ({ mode, type: 'blob', objectId });
  const side = (entries) => new Map(Object.entries(entries).map(([path, value]) => [path, { ...value, path, originalPath: path }]));

  it('sorts paths into changed, missing and added and counts the identical ones', () => {
    const comparison = compareTrees(
      side({ same: blob('1'), content: blob('2'), mode: blob('3'), gone: blob('4') }),
      side({ same: blob('1'), content: blob('9'), mode: blob('3', '100755'), new: blob('5') }),
    );
    assert.deepEqual(comparison.changed.map((difference) => difference.path), ['content', 'mode']);
    assert.deepEqual(comparison.missing.map((difference) => difference.path), ['gone']);
    assert.deepEqual(comparison.added.map((difference) => difference.path), ['new']);
    assert.equal(comparison.identical, 1);
  });
});

describe('tree.mjs', () => {
  it('says the tree ids match when both sides are the same tree', (t) => {
    const { repo, before } = repoWithMove(t);
    const result = runScript(TREE, ['--from', before, '--to', before], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lines(result.stdout).length, 1);
    assert.match(result.stdout, /^tree: match, tree ids match \([0-9a-f]+\), 4 identical entries$/m);
  });

  it('proves a subtree import by comparing tree ids', (t) => {
    const repo = makeRepo(t);
    writeFiles(repo, { 'src/index.js': 'console.log(1)\n', 'package.json': '{}\n' });
    const project = commitAll(repo, 'the project on its own');
    git(repo, 'read-tree', '--prefix=apps/project/', '-u', project);
    const imported = commitAll(repo, 'the project imported under apps/project');
    const result = runScript(TREE, ['--from', project, '--to', `${imported}:apps/project`], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tree ids match/);
  });

  it('passes a git mv when the map renames the moved directory', (t) => {
    const { repo, before, after } = repoWithMove(t);
    const result = runScript(TREE, ['--from', before, '--to', after, '--map', 'web2-admin/=apps/web2-admin/'], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'tree: match, 4 identical entries\n');
  });

  it('without the map, lists every moved file as missing and as added', (t) => {
    const { repo, before, after } = repoWithMove(t);
    const result = runScript(TREE, ['--from', before, '--to', after], { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^missing \(2\):$/m);
    assert.match(result.stdout, /^ {2}web2-admin\/backend\/src\/app\.ts$/m);
    assert.match(result.stdout, /^added \(2\):$/m);
    assert.match(result.stdout, /^ {2}apps\/web2-admin\/common\/src\/index\.ts$/m);
    assert.match(result.stdout, /^identical: 2$/m);
    assert.match(result.stdout, /^tree: differs, 4 differences not allowed$/m);
  });

  it('lists a file whose content changed with both object ids', (t) => {
    const { repo, before } = repoWithMove(t);
    writeFiles(repo, { 'apps/web2-admin/backend/src/app.ts': 'export const app = 2\n' });
    const edited = commitAll(repo, 'an edit hidden in the move');
    const result = runScript(TREE, ['--from', before, '--to', edited, '--map', 'web2-admin=apps/web2-admin'], { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^changed \(1\):$/m);
    assert.match(result.stdout, /^ {2}apps\/web2-admin\/backend\/src\/app\.ts {2}100644 [0-9a-f]{12} -> 100644 [0-9a-f]{12}$/m);
    assert.match(result.stdout, /^identical: 3$/m);
  });

  it('passes when every difference is allowed and counts them on its one line', (t) => {
    const { repo, before } = repoWithMove(t);
    writeFiles(repo, { 'pnpm-workspace.yaml': 'packages:\n  - apps/web2-admin/*\n' });
    const edited = commitAll(repo, 'the workspace follows the move');
    const args = ['--from', before, '--to', edited, '--map', 'web2-admin=apps/web2-admin', '--allow', 'pnpm-workspace.yaml'];
    const result = runScript(TREE, args, { cwd: repo });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.stdout, 'tree: match, 3 identical entries, 1 allowed difference\n');
  });

  it('marks an allowed difference as allowed when something else fails', (t) => {
    const { repo, before } = repoWithMove(t);
    writeFiles(repo, { 'pnpm-workspace.yaml': 'packages:\n  - apps/web2-admin/*\n', 'deploy/deploy.sh': '#!/bin/sh\n' });
    const edited = commitAll(repo, 'two edits');
    const args = ['--from', before, '--to', edited, '--map', 'web2-admin=apps/web2-admin', '--allow', 'pnpm-workspace.yaml'];
    const result = runScript(TREE, args, { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ {2}pnpm-workspace\.yaml {2}.* {2}\(allowed\)$/m);
    assert.match(result.stdout, /^ {2}deploy\/deploy\.sh {2}100644 [0-9a-f]{12} -> 100644 [0-9a-f]{12}$/m);
    assert.match(result.stdout, /^tree: differs, 1 difference not allowed, 1 allowed$/m);
  });

  it('covers a directory with an allow entry that ends in a slash, and only then', (t) => {
    const { repo, before } = repoWithMove(t);
    writeFiles(repo, { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' });
    const edited = commitAll(repo, 'docs arrive');
    const common = ['--from', before, '--to', edited, '--map', 'web2-admin=apps/web2-admin'];
    assert.equal(runScript(TREE, [...common, '--allow', 'docs/'], { cwd: repo }).status, 0);
    assert.equal(runScript(TREE, [...common, '--allow', 'docs'], { cwd: repo }).status, 1);
  });

  it('reports a missing file by its new path and its old one, and allows it by either', (t) => {
    const { repo, before } = repoWithMove(t);
    git(repo, 'rm', '--quiet', 'apps/web2-admin/common/src/index.ts');
    const trimmed = commitAll(repo, 'a file dropped in the move');
    const common = ['--from', before, '--to', trimmed, '--map', 'web2-admin=apps/web2-admin'];
    const result = runScript(TREE, common, { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ {2}apps\/web2-admin\/common\/src\/index\.ts {2}\(was web2-admin\/common\/src\/index\.ts\)$/m);
    assert.equal(runScript(TREE, [...common, '--allow', 'web2-admin/common/src/index.ts'], { cwd: repo }).status, 0);
    assert.equal(runScript(TREE, [...common, '--allow', 'apps/web2-admin/common/src/index.ts'], { cwd: repo }).status, 0);
  });

  it('counts a change of file mode as a change', (t) => {
    const { repo, after } = repoWithMove(t);
    git(repo, 'update-index', '--chmod=+x', 'deploy/deploy.sh');
    git(repo, 'commit', '--quiet', '--message', 'executable');
    const result = runScript(TREE, ['--from', after, '--to', 'HEAD'], { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ {2}deploy\/deploy\.sh {2}100644 ([0-9a-f]{12}) -> 100755 \1$/m);
  });

  it('compares a submodule by the commit it names', (t) => {
    const { repo, before, after } = repoWithMove(t);
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${before},vendor/lib`);
    git(repo, 'commit', '--quiet', '--message', 'a submodule at the first commit');
    const pinned = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-index', '--cacheinfo', `160000,${after},vendor/lib`);
    git(repo, 'commit', '--quiet', '--message', 'the submodule moves on');
    const moved = git(repo, 'rev-parse', 'HEAD').trim();
    assert.equal(runScript(TREE, ['--from', pinned, '--to', pinned], { cwd: repo }).status, 0);
    const result = runScript(TREE, ['--from', pinned, '--to', moved], { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`^ {2}vendor/lib {2}160000 ${before.slice(0, 12)} -> 160000 ${after.slice(0, 12)}$`, 'm'));
  });

  it('counts a symlink whose target changed as a change', (t) => {
    const repo = makeRepo(t);
    const target = (text) => gitWithInput(repo, text, 'hash-object', '-w', '--stdin').trim();
    writeFiles(repo, { 'README.md': 'readme\n' });
    git(repo, 'add', 'README.md');
    git(repo, 'update-index', '--add', '--cacheinfo', `120000,${target('README.md')},link`);
    git(repo, 'commit', '--quiet', '--message', 'a link');
    const first = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-index', '--cacheinfo', `120000,${target('docs/README.md')},link`);
    git(repo, 'commit', '--quiet', '--message', 'the link points elsewhere');
    const result = runScript(TREE, ['--from', first, '--to', 'HEAD'], { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ {2}link {2}120000 [0-9a-f]{12} -> 120000 [0-9a-f]{12}$/m);
  });

  it('says so when every entry matches but the tree ids differ', (t) => {
    const repo = makeRepo(t);
    writeFiles(repo, { 'a.txt': 'a\n' });
    const plain = commitAll(repo, 'one file');
    const blob = git(repo, 'rev-parse', `${plain}:a.txt`).trim();
    const emptyTree = gitWithInput(repo, '', 'mktree').trim();
    const withEmptyDir = gitWithInput(repo, `100644 blob ${blob}\ta.txt\n040000 tree ${emptyTree}\tempty\n`, 'mktree').trim();
    const result = runScript(TREE, ['--from', plain, '--to', withEmptyDir], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'tree: match, 1 identical entry, tree ids differ although every listed entry matches\n');
  });

  it('lists the whole tree when started from a subdirectory', (t) => {
    const { repo, before } = repoWithMove(t);
    mkdirSync(join(repo, 'deploy', 'nested'), { recursive: true });
    const result = runScript(TREE, ['--from', before, '--to', before], { cwd: join(repo, 'deploy', 'nested') });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /4 identical entries/);
  });

  it('refuses a map that sends two paths to one place', (t) => {
    const { repo, before, after } = repoWithMove(t);
    const args = ['--from', before, '--to', after, '--map', 'web2-admin/backend/src/app.ts=deploy/deploy.sh'];
    const result = runScript(TREE, args, { cwd: repo });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--map sends both deploy\/deploy\.sh and web2-admin\/backend\/src\/app\.ts to deploy\/deploy\.sh/);
  });

  it('exits 2 with the usage when an option is missing', (t) => {
    const { repo, before } = repoWithMove(t);
    const result = runScript(TREE, ['--from', before], { cwd: repo });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--to is required/);
    assert.match(result.stderr, /Usage: node tools\/move-check\/tree\.mjs/);
    assert.equal(result.stdout, '');
  });

  it('exits 2 for a revision that does not exist', (t) => {
    const { repo, before } = repoWithMove(t);
    const result = runScript(TREE, ['--from', before, '--to', 'no-such-branch'], { cwd: repo });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--to no-such-branch/);
  });

  it('exits 2 when a side names a file rather than a directory', (t) => {
    const { repo, before } = repoWithMove(t);
    const result = runScript(TREE, ['--from', `${before}:deploy/deploy.sh`, '--to', before], { cwd: repo });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /is a blob, not a directory/);
  });

  it('exits 2 for a malformed map', (t) => {
    const { repo, before } = repoWithMove(t);
    const result = runScript(TREE, ['--from', before, '--to', before, '--map', 'web2-admin'], { cwd: repo });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--map takes <old>=<new>/);
  });

  it('prints the usage on standard output for --help and exits 0', (t) => {
    const repo = makeRepo(t);
    const result = runScript(TREE, ['--help'], { cwd: repo });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: node tools\/move-check\/tree\.mjs/);
  });

  it('exits 2 outside a git repository', (t) => {
    const repo = makeRepo(t);
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    const env = { ...TEST_ENV, GIT_CEILING_DIRECTORIES: realpathSync(dirname(repo)) };
    const result = runScript(TREE, ['--from', 'HEAD', '--to', 'HEAD'], { cwd: repo, env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not a git repository/i);
  });
});
