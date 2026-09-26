import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CheckError } from '../lib/shared.mjs';
import { findFirstDifference, listSectionKeys, parseYamlKey, renameImporters } from '../lockfile.mjs';
import { commitAll, makeRepo, runScript, writeFiles } from './support/fixtures.mjs';

const LOCKFILE = 'lockfile.mjs';

const BEFORE_MOVE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  web2-admin/backend:
    dependencies:
      '@streaming-monorepo/web2-admin-common':
        specifier: workspace:*
        version: link:../common
      express:
        specifier: 5.2.1
        version: 5.2.1

  web2-admin/common:
    devDependencies:
      typescript:
        specifier: 5.6.3
        version: 5.6.3

packages:

  express@5.2.1:
    resolution: {integrity: sha512-aaa}
    engines: {node: '>= 18'}

  typescript@5.6.3:
    resolution: {integrity: sha512-bbb}
    hasBin: true

snapshots:

  express@5.2.1: {}

  typescript@5.6.3: {}
`;

const AFTER_MOVE = BEFORE_MOVE.replace('\n  web2-admin/backend:', '\n  apps/web2-admin/backend:').replace(
  '\n  web2-admin/common:',
  '\n  apps/web2-admin/common:',
);

const MOVE_IMPORTERS = ['--importer', 'web2-admin/backend=apps/web2-admin/backend', '--importer', 'web2-admin/common=apps/web2-admin/common'];

/** A repository with one commit per lockfile text, returning the commit ids in order. */
function repoWithLockfiles(t, ...texts) {
  const repo = makeRepo(t);
  const commits = texts.map((text, index) => {
    writeFiles(repo, { 'pnpm-lock.yaml': text });
    return commitAll(repo, `lockfile ${index + 1}`);
  });
  return { repo, commits };
}

describe('parseYamlKey', () => {
  it('reads a plain key with its indentation', () => {
    assert.deepEqual(parseYamlKey('  web2-admin/backend:'), { indent: 2, key: 'web2-admin/backend', keyEnd: 20 });
  });

  it('reads a single-quoted key and unescapes a doubled quote', () => {
    assert.equal(parseYamlKey("  '@scope/pkg@1.0.0':").key, '@scope/pkg@1.0.0');
    assert.equal(parseYamlKey("  'it''s':").key, "it's");
  });

  it('reads a double-quoted key', () => {
    assert.equal(parseYamlKey('  "a\\"b":').key, 'a"b');
  });

  it('reads a key that carries its value on the same line', () => {
    assert.deepEqual(parseYamlKey('  .: {}'), { indent: 2, key: '.', keyEnd: 3 });
  });

  it('reads a key on a line that ends in a carriage return', () => {
    assert.equal(parseYamlKey('  apps/x:\r').key, 'apps/x');
  });

  it('keeps a colon that no space follows inside a plain key', () => {
    assert.equal(parseYamlKey('  link:foo:').key, 'link:foo');
  });

  it('reads deeper keys with their indentation', () => {
    assert.deepEqual(parseYamlKey('      version: link:../common'), { indent: 6, key: 'version', keyEnd: 13 });
  });

  it('returns null for blank lines, comments, list items and plain values', () => {
    for (const line of ['', '   ', '# note', '  - item', '  just text']) assert.equal(parseYamlKey(line), null, line);
  });
});

describe('renameImporters', () => {
  const renames = new Map([
    ['web2-admin/backend', 'apps/web2-admin/backend'],
    ['web2-admin/common', 'apps/web2-admin/common'],
  ]);

  it('renames the importer keys and leaves every other line alone', () => {
    assert.equal(renameImporters(BEFORE_MOVE, renames), AFTER_MOVE);
  });

  it('returns the text unchanged when nothing is renamed', () => {
    assert.equal(renameImporters(BEFORE_MOVE, new Map()), BEFORE_MOVE);
  });

  it('renames only keys two spaces deep inside the top-level importers map', () => {
    const text = 'importers:\n\n  a:\n    dependencies:\n      a:\n        version: 1.0.0\n\npackages:\n\n  a:\n    resolution: {}\n';
    const renamed = renameImporters(text, new Map([['a', 'b']]));
    assert.equal(renamed, 'importers:\n\n  b:\n    dependencies:\n      a:\n        version: 1.0.0\n\npackages:\n\n  a:\n    resolution: {}\n');
  });

  it('keeps a value on the same line and the quoting of the key', () => {
    const text = "importers:\n\n  .: {}\n\n  'web/a': {}\n";
    const renamed = renameImporters(text, new Map([['.', 'root'], ['web/a', "it's"]]));
    assert.equal(renamed, "importers:\n\n  root: {}\n\n  'it''s': {}\n");
  });

  it('keeps carriage returns at the ends of lines', () => {
    const text = 'importers:\r\n\r\n  web/a:\r\n    dependencies: {}\r\n';
    assert.equal(renameImporters(text, new Map([['web/a', 'apps/a']])), 'importers:\r\n\r\n  apps/a:\r\n    dependencies: {}\r\n');
  });

  it('refuses an importer the lockfile does not have and lists the ones it has', () => {
    assert.throws(
      () => renameImporters(BEFORE_MOVE, new Map([['web2-admin/backnd', 'x']])),
      (error) => error instanceof CheckError && /web2-admin\/backnd/.test(error.message) && /web2-admin\/common/.test(error.message),
    );
  });

  it('refuses a rename that lands on an importer that is already there', () => {
    assert.throws(() => renameImporters(BEFORE_MOVE, new Map([['web2-admin/backend', 'web2-admin/common']])), CheckError);
  });

  it('refuses a lockfile with no importers section', () => {
    assert.throws(() => renameImporters("lockfileVersion: '9.0'\n", new Map([['a', 'b']])), CheckError);
  });
});

describe('listSectionKeys', () => {
  it('lists the keys two spaces deep in one top-level section', () => {
    assert.deepEqual(listSectionKeys(BEFORE_MOVE, 'packages'), ['express@5.2.1', 'typescript@5.6.3']);
    assert.deepEqual(listSectionKeys(BEFORE_MOVE, 'importers'), ['.', 'web2-admin/backend', 'web2-admin/common']);
  });

  it('unquotes quoted keys', () => {
    assert.deepEqual(listSectionKeys("snapshots:\n\n  '@a/b@1.0.0(react@18.3.1)': {}\n", 'snapshots'), ['@a/b@1.0.0(react@18.3.1)']);
  });

  it('lists nothing for a section the text does not have', () => {
    assert.deepEqual(listSectionKeys(BEFORE_MOVE, 'catalogs'), []);
  });
});

describe('findFirstDifference', () => {
  it('finds nothing in identical texts', () => {
    assert.equal(findFirstDifference('a\nb\n', 'a\nb\n'), null);
  });

  it('shows the differing lines between the common start and the common end', () => {
    assert.deepEqual(findFirstDifference('a\nb\nc\nd\n', 'a\nB\nC\nd\n'), { lineNumber: 2, fromLines: ['b', 'c'], toLines: ['B', 'C'] });
  });

  it('shows an inserted line with nothing on the other side', () => {
    assert.deepEqual(findFirstDifference('a\nc\n', 'a\nb\nc\n'), { lineNumber: 2, fromLines: [], toLines: ['b'] });
  });

  it('shows a missing final newline as an empty last line', () => {
    assert.deepEqual(findFirstDifference('a\n', 'a'), { lineNumber: 2, fromLines: [''], toLines: [] });
  });
});

describe('lockfile.mjs', () => {
  it('passes two identical lockfiles on one line', (t) => {
    const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE, `${BEFORE_MOVE}`);
    const result = runScript(LOCKFILE, ['--from', `${commits[0]}:pnpm-lock.yaml`, '--to', `${commits[1]}:pnpm-lock.yaml`], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'lockfile: match, identical byte for byte (40 lines)\n');
  });

  it('passes a move once the moved importers are renamed', (t) => {
    const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE, AFTER_MOVE);
    const args = ['--from', `${commits[0]}:pnpm-lock.yaml`, '--to', `${commits[1]}:pnpm-lock.yaml`, ...MOVE_IMPORTERS];
    const result = runScript(LOCKFILE, args, { cwd: repo });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.stdout, 'lockfile: match, identical byte for byte after renaming 2 importers (40 lines)\n');
  });

  it('shows the first differing lines with their numbers when an importer is not renamed', (t) => {
    const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE, AFTER_MOVE);
    const result = runScript(LOCKFILE, ['--from', `${commits[0]}:pnpm-lock.yaml`, '--to', `${commits[1]}:pnpm-lock.yaml`], { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^first difference at line 11:$/m);
    assert.match(result.stdout, /^ {2}from 11: " {2}web2-admin\/backend:"$/m);
    assert.match(result.stdout, /^ {2}to {3}11: " {2}apps\/web2-admin\/backend:"$/m);
    assert.match(result.stdout, /^lockfile: differs$/m);
  });

  it('catches a change the renames do not explain', (t) => {
    const edited = AFTER_MOVE.replace('version: link:../common', 'version: link:../../common');
    const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE, edited);
    const args = ['--from', `${commits[0]}:pnpm-lock.yaml`, '--to', `${commits[1]}:pnpm-lock.yaml`, ...MOVE_IMPORTERS];
    const result = runScript(LOCKFILE, args, { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ {2}from 15: " {8}version: link:\.\.\/common"$/m);
    assert.match(result.stdout, /^ {2}to {3}15: " {8}version: link:\.\.\/\.\.\/common"$/m);
  });

  it('shows at most five differing lines per side and counts the rest', (t) => {
    const { repo, commits } = repoWithLockfiles(t, 'a\n1\n2\n3\n4\n5\n6\n7\nz\n', 'a\nz\n');
    const result = runScript(LOCKFILE, ['--from', `${commits[0]}:pnpm-lock.yaml`, '--to', `${commits[1]}:pnpm-lock.yaml`], { cwd: repo });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ {2}from 6: "5"$/m);
    assert.doesNotMatch(result.stdout, /"6"/);
    assert.match(result.stdout, /^ {2}from \.\.\. and 2 more differing lines$/m);
    assert.match(result.stdout, /^ {2}to {3}2: \(no line here, the rest matches\)$/m);
  });

  describe('--packages', () => {
    it('passes when only the formatting changed', (t) => {
      const reformatted = BEFORE_MOVE.replace("lockfileVersion: '9.0'", "lockfileVersion: '9.1'").replace("engines: {node: '>= 18'}\n", '');
      const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE, reformatted);
      const args = ['--packages', '--from', `${commits[0]}:pnpm-lock.yaml`, '--to', `${commits[1]}:pnpm-lock.yaml`];
      const result = runScript(LOCKFILE, args, { cwd: repo });
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.stdout, 'lockfile: match, the same 2 packages and 2 snapshots on both sides\n');
    });

    it('lists the keys one side has and the other lacks', (t) => {
      const upgraded = BEFORE_MOVE.replaceAll('express@5.2.1', 'express@5.2.2');
      const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE, upgraded);
      const args = ['--packages', '--from', `${commits[0]}:pnpm-lock.yaml`, '--to', `${commits[1]}:pnpm-lock.yaml`];
      const result = runScript(LOCKFILE, args, { cwd: repo });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /^packages only in from \(1\):\n {2}express@5\.2\.1$/m);
      assert.match(result.stdout, /^packages only in to \(1\):\n {2}express@5\.2\.2$/m);
      assert.match(result.stdout, /^snapshots only in from \(1\):\n {2}express@5\.2\.1$/m);
      assert.match(result.stdout, /^lockfile: differs, 2 package keys and 2 snapshot keys are on one side only$/m);
    });
  });

  describe('bad input', () => {
    it('exits 2 when a side does not name a file as <rev>:<path>', (t) => {
      const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE);
      const result = runScript(LOCKFILE, ['--from', commits[0], '--to', `${commits[0]}:pnpm-lock.yaml`], { cwd: repo });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--from must name a file as <rev>:<path>/);
      assert.match(result.stderr, /Usage: node tools\/move-check\/lockfile\.mjs/);
    });

    it('exits 2 when --importer is given with --packages', (t) => {
      const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE);
      const spec = `${commits[0]}:pnpm-lock.yaml`;
      const result = runScript(LOCKFILE, ['--packages', '--from', spec, '--to', spec, '--importer', 'a=b'], { cwd: repo });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--importer has no effect with --packages/);
    });

    it('exits 2 for a path the revision does not have', (t) => {
      const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE);
      const result = runScript(LOCKFILE, ['--from', `${commits[0]}:nope.yaml`, '--to', `${commits[0]}:pnpm-lock.yaml`], { cwd: repo });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--from .*:nope\.yaml/);
    });

    it('exits 2 for a path that is a directory', (t) => {
      const repo = makeRepo(t);
      writeFiles(repo, { 'apps/pnpm-lock.yaml': BEFORE_MOVE });
      const commit = commitAll(repo, 'a lockfile in a directory');
      const result = runScript(LOCKFILE, ['--from', `${commit}:apps`, '--to', `${commit}:apps/pnpm-lock.yaml`], { cwd: repo });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /is a tree, not a file/);
    });

    it('exits 2 for a file that is not UTF-8', (t) => {
      const repo = makeRepo(t);
      writeFileSync(join(repo, 'pnpm-lock.yaml'), Buffer.from([0x61, 0xff, 0x0a]));
      const commit = commitAll(repo, 'bytes that are not text');
      const spec = `${commit}:pnpm-lock.yaml`;
      const result = runScript(LOCKFILE, ['--from', spec, '--to', spec], { cwd: repo });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /not valid UTF-8/);
    });

    it('exits 2 when the same importer is renamed twice', (t) => {
      const { repo, commits } = repoWithLockfiles(t, BEFORE_MOVE);
      const spec = `${commits[0]}:pnpm-lock.yaml`;
      const result = runScript(LOCKFILE, ['--from', spec, '--to', spec, '--importer', 'a=b', '--importer', 'a=c'], { cwd: repo });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--importer names "a" more than once/);
    });
  });
});
