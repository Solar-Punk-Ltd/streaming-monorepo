import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import { commitAll, makeTempDir, runScript, writeFiles } from './support/fixtures.mjs';
import {
  PACKAGE_MANAGER,
  SHARED_ROOT_LOCKFILE,
  SHARED_ROOT_WORKSPACE,
  expectedCut,
  manifest,
  manifestOf,
  realAppFiles,
  sharedAppFiles,
} from './support/workspace.mjs';

const CUT = 'cut.mjs';

function makeWorkspace(t, files = {}) {
  const root = makeTempDir(t);
  writeFiles(root, { ...realAppFiles(), ...files });
  return root;
}

/** Every file under `dir` with what it holds, and every link with where it points, by their paths from `dir`. */
function treeOf(dir) {
  const files = {};
  const links = {};
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name);
      const entry = lstatSync(full);
      if (entry.isSymbolicLink()) links[relative(dir, full)] = readlinkSync(full);
      else if (entry.isDirectory()) walk(full);
      else files[relative(dir, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return { files, links };
}

/** The pair the tool writes for the manager out of the workspace with shared packages. */
const expectedSharedCut = () =>
  expectedCut('apps/infra-manager', true, { root: SHARED_ROOT_LOCKFILE, rootWorkspace: SHARED_ROOT_WORKSPACE });

/**
 * The workspace with shared packages, the contracts package holding a link, a file git ignores in `dist` and an
 * installed package, and, in a checkout, a file added after the commit.
 */
function makeSharedWorkspace(t, { checkout }) {
  const root = makeTempDir(t);
  writeFiles(root, { ...sharedAppFiles(), '.gitignore': 'node_modules/\ndist/\n' });
  symlinkSync('src/index.ts', join(root, 'packages/contracts/entry.ts'));
  if (checkout) commitAll(root);
  writeFiles(root, {
    'packages/contracts/src/added.ts': 'export const added = 1;\n',
    'packages/contracts/dist/index.js': 'built\n',
    'packages/contracts/node_modules/left-pad/index.js': 'module.exports = 1;\n',
  });
  return root;
}

describe('cut.mjs', () => {
  it("writes the manager's lockfile and workspace file into --out, injecting as its table entry says", (t) => {
    const root = makeWorkspace(t);
    const out = makeTempDir(t);

    const result = runScript(CUT, ['--root', root, '--app', 'apps/infra-manager', '--out', out]);

    assert.equal(result.status, 0, result.stderr);
    const expected = expectedCut('apps/infra-manager', true);
    assert.equal(readFileSync(join(out, 'pnpm-lock.yaml'), 'utf8'), expected.lockfile);
    assert.equal(readFileSync(join(out, 'pnpm-workspace.yaml'), 'utf8'), expected.workspace);
    assert.match(
      result.stdout,
      /^apps\/infra-manager: 2 projects besides its own, 9 of the root's 12 packages, injectWorkspacePackages true\. Wrote pnpm-lock\.yaml and pnpm-workspace\.yaml to .+\.\n$/,
    );
  });

  it("writes the admin's without injection", (t) => {
    const root = makeWorkspace(t);
    const out = makeTempDir(t);

    const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', out]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(out, 'pnpm-lock.yaml'), 'utf8'), expectedCut('apps/web2-admin', false).lockfile);
    assert.match(result.stdout, /injectWorkspacePackages false\./);
  });

  it('makes --out when it does not exist yet', (t) => {
    const root = makeWorkspace(t);
    const out = join(makeTempDir(t), 'context');

    const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', out]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(out).sort(), ['pnpm-lock.yaml', 'pnpm-workspace.yaml']);
  });

  it('refuses an --out inside the workspace, and writes nothing', (t) => {
    const root = makeWorkspace(t);
    const out = join(root, 'apps', 'web2-admin');

    const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', out]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /inside the workspace/);
    assert.match(result.stderr, /in-copy\.mjs/);
    assert.equal(existsSync(join(out, 'pnpm-lock.yaml')), false);
  });

  it("refuses an app whose packageManager differs from the root's, naming both", (t) => {
    const root = makeWorkspace(t, { 'apps/web2-admin/package.json': manifestOf('beta', 'pnpm@10.29.3') });

    const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', makeTempDir(t)]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /pnpm@10\.29\.3/);
    assert.match(result.stderr, new RegExp(PACKAGE_MANAGER.replaceAll('.', '\\.').replaceAll('+', '\\+')));
  });

  it('refuses an app that names no packageManager, since corepack would pick its own pnpm there', (t) => {
    const root = makeWorkspace(t, { 'apps/web2-admin/package.json': manifestOf('beta', undefined) });

    const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', makeTempDir(t)]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /apps\/web2-admin\/package\.json names no packageManager/);
  });

  it('refuses a root that names no packageManager', (t) => {
    const root = makeWorkspace(t, { 'package.json': manifestOf('fixture-root', undefined) });

    const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', makeTempDir(t)]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /root package\.json names no packageManager/);
  });

  it('refuses an app its table has no injection setting for', (t) => {
    const root = makeWorkspace(t, { 'apps/gamma/package.json': manifest('gamma') });

    const result = runScript(CUT, ['--root', root, '--app', 'apps/gamma', '--out', makeTempDir(t)]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /apps\/gamma/);
    assert.match(result.stderr, /apps\.mjs/);
  });

  it('refuses an --out that already holds a lockfile, which an app keeping its own builds from as it is', (t) => {
    const root = makeWorkspace(t);
    const out = makeTempDir(t);
    writeFileSync(join(out, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', out]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /already holds pnpm-lock\.yaml/);
    assert.equal(readFileSync(join(out, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9.0\n');
  });

  it('refuses a root without a lockfile, which is a commit whose apps keep their own', (t) => {
    const root = makeTempDir(t);
    mkdirSync(join(root, 'apps', 'web2-admin'), { recursive: true });
    writeFiles(root, { 'package.json': manifest('fixture-root'), 'apps/web2-admin/package.json': manifest('beta') });

    const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', makeTempDir(t)]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no pnpm-lock\.yaml/);
  });

  it('exits 2 with its usage when --app or --out is missing', () => {
    const result = runScript(CUT, ['--app', 'apps/web2-admin']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--out is required/);
    assert.match(result.stderr, /Usage: node tools\/app-workspace\/cut\.mjs/);
  });

  describe('with a shared package the app links', () => {
    it('copies the package as git sees it into workspace-packages/<name>, beside the pair, from a checkout', (t) => {
      const root = makeSharedWorkspace(t, { checkout: true });
      const out = makeTempDir(t);

      const result = runScript(CUT, ['--root', root, '--app', 'apps/infra-manager', '--out', out]);

      assert.equal(result.status, 0, result.stderr);
      const { files, links } = treeOf(out);
      assert.deepEqual(Object.keys(files).sort(), [
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'workspace-packages/contracts/package.json',
        'workspace-packages/contracts/src/added.ts',
        'workspace-packages/contracts/src/index.ts',
      ]);
      assert.deepEqual(links, { 'workspace-packages/contracts/entry.ts': 'src/index.ts' });
      assert.equal(files['pnpm-lock.yaml'], expectedSharedCut().lockfile);
      assert.equal(files['pnpm-workspace.yaml'], expectedSharedCut().workspace);
    });

    it('copies every file of the package but node_modules when the root is not a git checkout', (t) => {
      const root = makeSharedWorkspace(t, { checkout: false });
      const out = makeTempDir(t);

      const result = runScript(CUT, ['--root', root, '--app', 'apps/infra-manager', '--out', out]);

      assert.equal(result.status, 0, result.stderr);
      const { files, links } = treeOf(out);
      assert.deepEqual(Object.keys(files).sort(), [
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'workspace-packages/contracts/dist/index.js',
        'workspace-packages/contracts/package.json',
        'workspace-packages/contracts/src/added.ts',
        'workspace-packages/contracts/src/index.ts',
      ]);
      assert.deepEqual(links, { 'workspace-packages/contracts/entry.ts': 'src/index.ts' });
    });

    it('writes the same bytes on a second run', (t) => {
      const root = makeSharedWorkspace(t, { checkout: true });
      const outs = [makeTempDir(t), makeTempDir(t)];

      for (const out of outs) {
        const result = runScript(CUT, ['--root', root, '--app', 'apps/infra-manager', '--out', out]);
        assert.equal(result.status, 0, result.stderr);
      }

      assert.deepEqual(treeOf(outs[0]), treeOf(outs[1]));
    });

    it('writes the pair alone, the same bytes as before, for an app that links no shared package', (t) => {
      const root = makeSharedWorkspace(t, { checkout: true });
      const out = makeTempDir(t);

      const result = runScript(CUT, ['--root', root, '--app', 'apps/web2-admin', '--out', out]);

      assert.equal(result.status, 0, result.stderr);
      const expected = expectedCut('apps/web2-admin', false);
      assert.deepEqual(treeOf(out), {
        files: { 'pnpm-lock.yaml': expected.lockfile, 'pnpm-workspace.yaml': expected.workspace },
        links: {},
      });
    });

    it('refuses an app that holds a workspace-packages of its own, which the cut writes, and writes nothing', (t) => {
      const root = makeSharedWorkspace(t, { checkout: false });
      writeFiles(root, { 'apps/infra-manager/workspace-packages/notes.txt': 'mine\n' });
      const out = makeTempDir(t);

      const result = runScript(CUT, ['--root', root, '--app', 'apps/infra-manager', '--out', out]);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /apps\/infra-manager\/workspace-packages/);
      assert.deepEqual(readdirSync(out), []);
    });

    it('refuses a shared package that holds an env file, whether git ignores it or not, and writes nothing', (t) => {
      for (const [checkout, name] of [
        [false, '.env'],
        [true, '.env.local'],
      ]) {
        const root = makeSharedWorkspace(t, { checkout });
        writeFiles(root, {
          '.gitignore': 'node_modules/\ndist/\n.env*\n',
          [`packages/contracts/config/${name}`]: 'LOCAL_ONLY=1\n',
        });
        const out = makeTempDir(t);

        const result = runScript(CUT, ['--root', root, '--app', 'apps/infra-manager', '--out', out]);

        assert.equal(result.status, 1, `${name}: ${result.stderr}`);
        assert.match(result.stderr, new RegExp(`packages/contracts/config/${name.replaceAll('.', '\\.')}`), name);
        assert.match(result.stderr, /env file/, name);
        assert.doesNotMatch(result.stderr, /LOCAL_ONLY/, `${name}: the refusal printed what the file holds`);
        assert.deepEqual(readdirSync(out), [], name);
      }
    });
  });
});
