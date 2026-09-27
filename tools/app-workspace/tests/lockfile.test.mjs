import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cutLockfile } from '../lib/lockfile.mjs';
import { Refusal } from '../lib/refusal.mjs';
import {
  IMPORTERS,
  OVERRIDES,
  PACKAGE_MANAGER_DOCUMENT,
  PACKAGES,
  ROOT_LOCKFILE,
  SETTINGS,
  SHARED_IMPORTERS,
  SHARED_PACKAGES,
  SHARED_ROOT_LOCKFILE,
  SHARED_SNAPSHOTS,
  SNAPSHOTS,
  lockfileText,
} from './support/workspace.mjs';

const ALPHA = { app: 'apps/alpha', injectWorkspacePackages: false };
const BETA = { app: 'apps/beta', injectWorkspacePackages: false };

/** What apps/alpha's importers reach: express's chain, the alias's target, fsevents, and viem with its peers. */
const ALPHA_KEPT = ['abitype', 'bodyParser', 'express', 'fsevents', 'qs', 'stringWidth', 'typescript', 'viem', 'zod'];
const BETA_KEPT = ['jsTokens', 'looseEnvify', 'react', 'typescript', 'zod'];

const pick = (blocks, names) => names.map((name) => blocks[name]);

const ALPHA_IMPORTERS = [
  IMPORTERS.alpha.replace('  apps/alpha:', '  .:'),
  IMPORTERS.alphaCommon.replace('  apps/alpha/common:', '  common:'),
  IMPORTERS.alphaServer.replace('  apps/alpha/server:', '  server:'),
];

function withBlocks({
  importers = Object.values(IMPORTERS),
  packages = Object.values(PACKAGES),
  snapshots = Object.values(SNAPSHOTS),
  ...rest
}) {
  return lockfileText({ importers, packages, snapshots, ...rest });
}

describe('cutLockfile', () => {
  it("writes the app's importers named from its folder, and exactly the packages and snapshots they reach", () => {
    const cut = cutLockfile(ROOT_LOCKFILE, ALPHA);

    assert.equal(
      cut.text,
      lockfileText({
        importers: ALPHA_IMPORTERS,
        packages: pick(PACKAGES, ALPHA_KEPT),
        snapshots: pick(SNAPSHOTS, ALPHA_KEPT),
      }),
    );
  });

  it('cuts the other app with its own importer as `.` and nothing only alpha reaches', () => {
    const cut = cutLockfile(ROOT_LOCKFILE, BETA);

    assert.equal(
      cut.text,
      lockfileText({
        importers: [IMPORTERS.beta.replace('  apps/beta:', '  .:')],
        packages: pick(PACKAGES, BETA_KEPT),
        snapshots: pick(SNAPSHOTS, BETA_KEPT),
      }),
    );
  });

  it('names the projects it keeps from the app folder, its own not among them', () => {
    assert.deepEqual(cutLockfile(ROOT_LOCKFILE, ALPHA).projects, ['common', 'server']);
    assert.deepEqual(cutLockfile(ROOT_LOCKFILE, BETA).projects, []);
  });

  it('names every package it keeps, so the workspace file can keep their build permissions alone', () => {
    const { packageNames } = cutLockfile(ROOT_LOCKFILE, ALPHA);

    assert.deepEqual([...packageNames].sort(), [
      'abitype',
      'body-parser',
      'express',
      'fsevents',
      'qs',
      'string-width',
      'typescript',
      'viem',
      'zod',
    ]);
  });

  it("counts what it kept against the root's packages", () => {
    const cut = cutLockfile(ROOT_LOCKFILE, ALPHA);

    assert.equal(cut.packageCount, 9);
    assert.equal(cut.rootPackageCount, 12);
  });

  it('writes injectWorkspacePackages into the settings of an app that injects', () => {
    const cut = cutLockfile(ROOT_LOCKFILE, { ...ALPHA, injectWorkspacePackages: true });

    assert.match(cut.text, new RegExp(`^${SETTINGS.injected.replaceAll('\n', '\\n')}$`, 'm'));
  });

  it('leaves injectWorkspacePackages out for an app that does not, whatever the root says', () => {
    const cut = cutLockfile(withBlocks({ settings: SETTINGS.injected }), ALPHA);

    assert.equal(cut.text.includes('injectWorkspacePackages'), false);
    assert.equal(cut.text.startsWith(`lockfileVersion: '9.0'\n\n${SETTINGS.plain}\n\n`), true);
  });

  it('carries every other top-level section as the root has it, in its place', () => {
    const catalogs = 'catalogs:\n  default:\n    typescript:\n      specifier: 5.6.3\n      version: 5.6.3';
    const checksum = 'pnpmfileChecksum: sha256-abc';
    const cut = cutLockfile(withBlocks({ extra: [OVERRIDES, catalogs, checksum] }), ALPHA);

    assert.equal(
      cut.text.includes(`${SETTINGS.plain}\n\n${OVERRIDES}\n\n${catalogs}\n\n${checksum}\n\nimporters:\n\n`),
      true,
    );
  });

  it('refuses a workspace link that leaves the app', () => {
    const leaving = IMPORTERS.alphaServer.replace('link:../common', 'link:../../beta');
    const text = withBlocks({
      importers: [IMPORTERS.root, IMPORTERS.alpha, IMPORTERS.alphaCommon, leaving, IMPORTERS.beta],
    });

    assert.throws(
      () => cutLockfile(text, ALPHA),
      (error) =>
        error instanceof Refusal &&
        /apps\/alpha\/server links @alpha\/common from apps\/beta, which is outside apps\/alpha/.test(error.message),
    );
  });

  it('refuses a lockfile that lacks a snapshot the app reaches', () => {
    const text = withBlocks({ snapshots: Object.values(SNAPSHOTS).filter((block) => block !== SNAPSHOTS.qs) });

    assert.throws(
      () => cutLockfile(text, ALPHA),
      (error) => error instanceof Refusal && /qs@6\.16\.0/.test(error.message) && /no snapshot/.test(error.message),
    );
  });

  it('refuses a lockfile that lacks the package entry of a snapshot the app reaches', () => {
    const text = withBlocks({ packages: Object.values(PACKAGES).filter((block) => block !== PACKAGES.qs) });

    assert.throws(
      () => cutLockfile(text, ALPHA),
      (error) =>
        error instanceof Refusal && /qs@6\.16\.0/.test(error.message) && /no package entry/.test(error.message),
    );
  });

  it('refuses a dependency on a folder, whose file: path is written from the root', () => {
    const local = IMPORTERS.alphaCommon.replace(
      'version: 2.0.0(typescript@5.6.3)(zod@4.0.0)',
      'version: file:vendor/viem',
    );
    const text = withBlocks({
      importers: [IMPORTERS.root, IMPORTERS.alpha, local, IMPORTERS.alphaServer, IMPORTERS.beta],
    });

    assert.throws(
      () => cutLockfile(text, ALPHA),
      (error) => error instanceof Refusal && /file:vendor\/viem/.test(error.message),
    );
  });

  it('refuses a lockfile format it was not written for', () => {
    assert.throws(
      () => cutLockfile(withBlocks({ version: `'6.0'` }), ALPHA),
      (error) => error instanceof Refusal && /'6\.0'/.test(error.message) && /9\.0/.test(error.message),
    );
  });

  it("keeps pnpm's own document above the lockfile as the root has it, and cuts the one below it", () => {
    const cut = cutLockfile(`${PACKAGE_MANAGER_DOCUMENT}${ROOT_LOCKFILE}`, ALPHA);

    assert.equal(cut.text, `${PACKAGE_MANAGER_DOCUMENT}${cutLockfile(ROOT_LOCKFILE, ALPHA).text}`);
    assert.equal(cut.rootPackageCount, cutLockfile(ROOT_LOCKFILE, ALPHA).rootPackageCount);
  });

  it('refuses a document opened above the lockfile and never closed', () => {
    assert.throws(
      () => cutLockfile(`---\n${ROOT_LOCKFILE}`, ALPHA),
      (error) => error instanceof Refusal && /---/.test(error.message),
    );
  });

  it("refuses a first document that is not pnpm's record of its own version", () => {
    const other = PACKAGE_MANAGER_DOCUMENT.replace('    packageManagerDependencies:\n', '    dependencies:\n');
    assert.throws(
      () => cutLockfile(`${other}${ROOT_LOCKFILE}`, ALPHA),
      (error) => error instanceof Refusal && /packageManagerDependencies/.test(error.message),
    );
  });

  it('refuses an app the lockfile has no importer for', () => {
    assert.throws(
      () => cutLockfile(ROOT_LOCKFILE, { app: 'apps/gamma', injectWorkspacePackages: false }),
      (error) => error instanceof Refusal && /apps\/gamma/.test(error.message) && /no importer/.test(error.message),
    );
  });

  describe('with a shared package under packages/', () => {
    /** The blocks of the shared root whose names are given, in the root's own order. */
    const keep = (blocks, names) =>
      Object.entries(blocks)
        .filter(([name]) => names.includes(name))
        .map(([, block]) => block);

    const ALPHA_SHARED_KEPT = [...ALPHA_KEPT, 'esbuild', 'esbuildLinux', 'valibot'];

    const CARRIED_CONTRACTS = SHARED_IMPORTERS.contracts.replace(
      '  packages/contracts:',
      '  workspace-packages/contracts:',
    );

    const ALPHA_SHARED_IMPORTERS = [
      SHARED_IMPORTERS.alpha
        .replace('  apps/alpha:', '  .:')
        .replace('link:../../packages/contracts', 'link:workspace-packages/contracts'),
      SHARED_IMPORTERS.alphaCommon.replace('  apps/alpha/common:', '  common:'),
      SHARED_IMPORTERS.alphaServer
        .replace('  apps/alpha/server:', '  server:')
        .replace('link:../../../packages/contracts', 'link:../workspace-packages/contracts'),
      CARRIED_CONTRACTS,
    ];

    /** The shared root with some importers replaced, and others added, by their root names. */
    function sharedWith(importers) {
      const blocks = { ...SHARED_IMPORTERS, ...importers };
      return lockfileText({
        importers: Object.values(blocks).filter((block) => block !== null),
        packages: Object.values(SHARED_PACKAGES),
        snapshots: Object.values(SHARED_SNAPSHOTS),
      });
    }

    it("carries the package as workspace-packages/<name>, points the app's links at it, and keeps what it reaches", () => {
      const cut = cutLockfile(SHARED_ROOT_LOCKFILE, ALPHA);

      assert.equal(
        cut.text,
        lockfileText({
          importers: ALPHA_SHARED_IMPORTERS,
          packages: keep(SHARED_PACKAGES, ALPHA_SHARED_KEPT),
          snapshots: keep(SHARED_SNAPSHOTS, ALPHA_SHARED_KEPT),
        }),
      );
    });

    it('names the carried package among the projects and its packages among the names, and says where it goes', () => {
      const cut = cutLockfile(SHARED_ROOT_LOCKFILE, ALPHA);

      assert.deepEqual(cut.projects, ['common', 'server', 'workspace-packages/contracts']);
      assert.deepEqual(cut.sharedPackages, [{ from: 'packages/contracts', to: 'workspace-packages/contracts' }]);
      assert.equal(cut.packageNames.has('esbuild'), true);
      assert.equal(cut.packageNames.has('@esbuild/linux-x64'), true);
      assert.equal(cut.packageNames.has('left-pad'), false);
    });

    it('carries a shared package another shared package links, with the link between them as the root has it', () => {
      const contracts = SHARED_IMPORTERS.contracts.replace(
        '    dependencies:\n',
        "    dependencies:\n      '@example/unused':\n        specifier: workspace:*\n        version: link:../unused\n",
      );
      const cut = cutLockfile(sharedWith({ contracts }), ALPHA);

      const kept = [...ALPHA_SHARED_KEPT, 'leftPad'];
      assert.equal(
        cut.text,
        lockfileText({
          importers: [
            ...ALPHA_SHARED_IMPORTERS.slice(0, 3),
            contracts.replace('  packages/contracts:', '  workspace-packages/contracts:'),
            SHARED_IMPORTERS.unused.replace('  packages/unused:', '  workspace-packages/unused:'),
          ],
          packages: keep(SHARED_PACKAGES, kept),
          snapshots: keep(SHARED_SNAPSHOTS, kept),
        }),
      );
      assert.deepEqual(
        cut.sharedPackages.map((shared) => shared.to),
        ['workspace-packages/contracts', 'workspace-packages/unused'],
      );
    });

    it('refuses a shared package that links anything outside packages/, naming the importer, the link and the target', () => {
      const contracts = SHARED_IMPORTERS.contracts.replace(
        '    dependencies:\n',
        "    dependencies:\n      beta:\n        specifier: workspace:*\n        version: link:../../apps/beta\n",
      );

      assert.throws(
        () => cutLockfile(sharedWith({ contracts }), ALPHA),
        (error) =>
          error instanceof Refusal &&
          /packages\/contracts links beta from apps\/beta/.test(error.message) &&
          /link:\.\.\/\.\.\/apps\/beta/.test(error.message),
      );
    });

    it('refuses a link to a folder under packages/ the root lockfile has no importer for', () => {
      const alpha = SHARED_IMPORTERS.alpha.replace('packages/contracts', 'packages/missing');

      assert.throws(
        () => cutLockfile(sharedWith({ alpha }), ALPHA),
        (error) => error instanceof Refusal && /packages\/missing/.test(error.message) && /no importer/.test(error.message),
      );
    });

    it('refuses a link deeper than one folder under packages/, which the root glob does not list', () => {
      const alpha = SHARED_IMPORTERS.alpha.replace('packages/contracts', 'packages/contracts/nested');

      assert.throws(
        () => cutLockfile(sharedWith({ alpha }), ALPHA),
        (error) => error instanceof Refusal && /outside apps\/alpha/.test(error.message),
      );
    });

    it('cuts an app that links no shared package to the same bytes whether the root holds shared packages or not', () => {
      const shared = cutLockfile(SHARED_ROOT_LOCKFILE, BETA);

      assert.equal(shared.text, cutLockfile(ROOT_LOCKFILE, BETA).text);
      assert.deepEqual(shared.projects, []);
      assert.deepEqual(shared.sharedPackages, []);
    });
  });
});
