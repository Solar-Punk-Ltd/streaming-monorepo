import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { commitAll, makeTempDir, runScript, writeFiles } from './support/fixtures.mjs';
import { PACKAGE_MANAGER, expectedCut, manifest, manifestOf, realAppFiles } from './support/workspace.mjs';

const CUT = 'cut.mjs';

function makeWorkspace(t, files = {}) {
  const root = makeTempDir(t);
  writeFiles(root, { ...realAppFiles(), ...files });
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

  it('exits 2 with its usage when --app or --out is missing', (t) => {
    const result = runScript(CUT, ['--app', 'apps/web2-admin']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--out is required/);
    assert.match(result.stderr, /Usage: node tools\/app-workspace\/cut\.mjs/);
  });
});
