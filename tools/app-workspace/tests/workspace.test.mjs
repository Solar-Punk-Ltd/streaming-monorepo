import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Refusal } from '../lib/refusal.mjs';
import { cutWorkspace } from '../lib/workspace.mjs';
import { ROOT_WORKSPACE } from './support/workspace.mjs';

const ALPHA = {
  app: 'apps/alpha',
  injectWorkspacePackages: true,
  packageNames: new Set([
    'abitype',
    'body-parser',
    'express',
    'fsevents',
    'qs',
    'string-width',
    'typescript',
    'viem',
    'zod',
  ]),
  projects: ['common', 'server'],
};

const BETA = {
  app: 'apps/beta',
  injectWorkspacePackages: false,
  packageNames: new Set(['js-tokens', 'loose-envify', 'react', 'typescript', 'zod']),
  projects: [],
};

const header = (
  app,
) => `# The workspace of ${app} alone, cut from the repository's root pnpm-workspace.yaml by tools/app-workspace.
# Its projects, its injection setting and its build permissions are the app's own. Edit the root file, never this one.
`;

describe('cutWorkspace', () => {
  it("keeps the app's globs named from its folder, its own injection setting, and the build permissions of its packages", () => {
    assert.equal(
      cutWorkspace(ROOT_WORKSPACE, ALPHA),
      `${header('apps/alpha')}# Every app's projects, and the repository's tools.
packages:
  - server
  - common

# The app's own setting, from tools/app-workspace/apps.mjs.
injectWorkspacePackages: true

allowBuilds:
  fsevents: false

overrides:
  body-parser: ^2.3.0 # a reason
  qs: ^6.16.0

saveExact: true
`,
    );
  });

  it('keeps a quoted glob quoted, and the root setting of an app that does not inject', () => {
    assert.equal(
      cutWorkspace(ROOT_WORKSPACE, BETA),
      `${header('apps/beta')}# Every app's projects, and the repository's tools.
packages:
  - 'packages/*'

# Off for the workspace. Each app's cut carries its own.
injectWorkspacePackages: false

allowBuilds:
  react: false

overrides:
  body-parser: ^2.3.0 # a reason
  qs: ^6.16.0

saveExact: true
`,
    );
  });

  it('adds injectWorkspacePackages after the packages for an app that injects when the root names no setting', () => {
    const root = ROOT_WORKSPACE.replace(
      "# Off for the workspace. Each app's cut carries its own.\ninjectWorkspacePackages: false\n\n",
      '',
    );

    const cut = cutWorkspace(root, ALPHA);

    assert.equal(cut.includes('  - common\n\ninjectWorkspacePackages: true\n\nallowBuilds:\n'), true);
    assert.equal(cutWorkspace(root, BETA).includes('injectWorkspacePackages'), false);
  });

  it('writes an empty build permission list when the app has none of the packages the root names', () => {
    const cut = cutWorkspace(ROOT_WORKSPACE, { ...ALPHA, packageNames: new Set(['qs']) });

    assert.equal(cut.includes('\nallowBuilds: {}\n\noverrides:\n'), true);
  });

  it('keeps a negated glob under the app, and drops one elsewhere', () => {
    const root = ROOT_WORKSPACE.replace(
      '  - tools/*\n',
      '  - tools/*\n  - "!apps/alpha/server/fixtures"\n  - "!tools/old"\n',
    );

    const cut = cutWorkspace(root, ALPHA);

    assert.equal(cut.includes('packages:\n  - server\n  - common\n  - "!server/fixtures"\n\n'), true);
  });

  it('refuses a build permission of its packages that is neither true nor false, such as the placeholder pnpm writes', () => {
    const root = ROOT_WORKSPACE.replace('  fsevents: false\n', '  fsevents: set this to true or false\n');

    assert.throws(
      () => cutWorkspace(root, ALPHA),
      (error) =>
        error instanceof Refusal && /fsevents/.test(error.message) && /set this to true or false/.test(error.message),
    );
    assert.doesNotThrow(
      () => cutWorkspace(root, BETA),
      'beta has no fsevents, so the placeholder is not its to refuse',
    );
  });

  it('refuses a glob that reaches into the app from outside its folder', () => {
    const root = ROOT_WORKSPACE.replace('  - tools/*\n', '  - tools/*\n  - apps/*/server\n');

    assert.throws(
      () => cutWorkspace(root, ALPHA),
      (error) =>
        error instanceof Refusal && /apps\/\*\/server/.test(error.message) && /apps\/alpha/.test(error.message),
    );
  });

  it('refuses a cut whose globs leave out a project the lockfile keeps', () => {
    assert.throws(
      () => cutWorkspace(ROOT_WORKSPACE, { ...ALPHA, projects: ['common', 'server', 'worker'] }),
      (error) => error instanceof Refusal && /worker/.test(error.message),
    );
  });

  it('refuses a workspace file that lists no packages', () => {
    assert.throws(
      () => cutWorkspace('saveExact: true\n', ALPHA),
      (error) => error instanceof Refusal && /packages/.test(error.message),
    );
  });
});
