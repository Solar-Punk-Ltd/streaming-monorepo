import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cutLockfile } from '../lib/lockfile.mjs';
import { Refusal } from '../lib/refusal.mjs';
import { IMPORTERS, OVERRIDES, PACKAGES, ROOT_LOCKFILE, SETTINGS, SNAPSHOTS, lockfileText } from './support/workspace.mjs';

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

function withBlocks({ importers = Object.values(IMPORTERS), packages = Object.values(PACKAGES), snapshots = Object.values(SNAPSHOTS), ...rest }) {
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

    assert.deepEqual(
      [...packageNames].sort(),
      ['abitype', 'body-parser', 'express', 'fsevents', 'qs', 'string-width', 'typescript', 'viem', 'zod'],
    );
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

    assert.equal(cut.text.includes(`${SETTINGS.plain}\n\n${OVERRIDES}\n\n${catalogs}\n\n${checksum}\n\nimporters:\n\n`), true);
  });

  it('refuses a workspace link that leaves the app', () => {
    const leaving = IMPORTERS.alphaServer.replace('link:../common', 'link:../../beta');
    const text = withBlocks({ importers: [IMPORTERS.root, IMPORTERS.alpha, IMPORTERS.alphaCommon, leaving, IMPORTERS.beta] });

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
      (error) => error instanceof Refusal && /qs@6\.16\.0/.test(error.message) && /no package entry/.test(error.message),
    );
  });

  it('refuses a dependency on a folder, whose file: path is written from the root', () => {
    const local = IMPORTERS.alphaCommon.replace(
      'version: 2.0.0(typescript@5.6.3)(zod@4.0.0)',
      'version: file:vendor/viem',
    );
    const text = withBlocks({ importers: [IMPORTERS.root, IMPORTERS.alpha, local, IMPORTERS.alphaServer, IMPORTERS.beta] });

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

  it('refuses an app the lockfile has no importer for', () => {
    assert.throws(
      () => cutLockfile(ROOT_LOCKFILE, { app: 'apps/gamma', injectWorkspacePackages: false }),
      (error) => error instanceof Refusal && /apps\/gamma/.test(error.message) && /no importer/.test(error.message),
    );
  });
});
