import { cutLockfile } from '../../lib/lockfile.mjs';
import { cutWorkspace } from '../../lib/workspace.mjs';

/**
 * A small workspace of two apps, written the way pnpm 11 writes its files, and the builder that assembles a lockfile
 * from its blocks. A test states the root lockfile and the lockfile it expects a cut to write in the same blocks, so
 * the expected text is the root's own text for every entry the cut keeps.
 *
 * `apps/alpha` has two projects, `server` linking `common`, and reaches through `express`, an npm alias, an optional
 * dependency and `viem`, whose optional peer `zod` only `apps/beta` declares. `apps/beta` has one project and shares
 * `typescript` with alpha.
 */

export const IMPORTERS = {
  root: `  .: {}`,
  alpha: `  apps/alpha:
    devDependencies:
      typescript:
        specifier: 5.6.3
        version: 5.6.3`,
  alphaCommon: `  apps/alpha/common:
    dependencies:
      viem:
        specifier: ^2.0.0
        version: 2.0.0(typescript@5.6.3)(zod@4.0.0)`,
  alphaServer: `  apps/alpha/server:
    dependencies:
      '@alpha/common':
        specifier: workspace:*
        version: link:../common
      express:
        specifier: 5.0.0
        version: 5.0.0
      string-width-cjs:
        specifier: npm:string-width@4.2.3
        version: string-width@4.2.3
    optionalDependencies:
      fsevents:
        specifier: 2.3.3
        version: 2.3.3`,
  beta: `  apps/beta:
    dependencies:
      react:
        specifier: 18.3.1
        version: 18.3.1
    devDependencies:
      typescript:
        specifier: 5.6.3
        version: 5.6.3
      zod:
        specifier: 4.0.0
        version: 4.0.0`,
  tools: `  tools/move-check: {}`,
};

export const PACKAGES = {
  abitype: `  abitype@1.0.0:
    resolution: {integrity: sha512-abitype}
    peerDependencies:
      typescript: '>=5.0.4'
      zod: ^3 >=3.22.0
    peerDependenciesMeta:
      typescript:
        optional: true
      zod:
        optional: true`,
  bodyParser: `  body-parser@2.3.0:
    resolution: {integrity: sha512-bodyparser}
    engines: {node: '>=18'}`,
  express: `  express@5.0.0:
    resolution: {integrity: sha512-express}
    engines: {node: '>= 18'}`,
  fsevents: `  fsevents@2.3.3:
    resolution: {integrity: sha512-fsevents}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]`,
  jsTokens: `  js-tokens@4.0.0:
    resolution: {integrity: sha512-jstokens}`,
  looseEnvify: `  loose-envify@1.4.0:
    resolution: {integrity: sha512-looseenvify}
    hasBin: true`,
  qs: `  qs@6.16.0:
    resolution: {integrity: sha512-qs}
    engines: {node: '>=0.6'}`,
  react: `  react@18.3.1:
    resolution: {integrity: sha512-react}
    engines: {node: '>=0.10.0'}`,
  stringWidth: `  string-width@4.2.3:
    resolution: {integrity: sha512-stringwidth}
    engines: {node: '>=8'}`,
  typescript: `  typescript@5.6.3:
    resolution: {integrity: sha512-typescript}
    engines: {node: '>=14.17'}
    hasBin: true`,
  viem: `  viem@2.0.0:
    resolution: {integrity: sha512-viem}
    peerDependencies:
      typescript: '>=5.0.4'
    peerDependenciesMeta:
      typescript:
        optional: true`,
  zod: `  zod@4.0.0:
    resolution: {integrity: sha512-zod}`,
};

export const SNAPSHOTS = {
  abitype: `  abitype@1.0.0(typescript@5.6.3)(zod@4.0.0):
    optionalDependencies:
      typescript: 5.6.3
      zod: 4.0.0`,
  bodyParser: `  body-parser@2.3.0:
    dependencies:
      qs: 6.16.0`,
  express: `  express@5.0.0:
    dependencies:
      body-parser: 2.3.0
    transitivePeerDependencies:
      - supports-color`,
  fsevents: `  fsevents@2.3.3:
    optional: true`,
  jsTokens: `  js-tokens@4.0.0: {}`,
  looseEnvify: `  loose-envify@1.4.0:
    dependencies:
      js-tokens: 4.0.0`,
  qs: `  qs@6.16.0: {}`,
  react: `  react@18.3.1:
    dependencies:
      loose-envify: 1.4.0`,
  stringWidth: `  string-width@4.2.3: {}`,
  typescript: `  typescript@5.6.3: {}`,
  viem: `  viem@2.0.0(typescript@5.6.3)(zod@4.0.0):
    dependencies:
      abitype: 1.0.0(typescript@5.6.3)(zod@4.0.0)
    optionalDependencies:
      typescript: 5.6.3`,
  zod: `  zod@4.0.0: {}`,
};

export const SETTINGS = {
  plain: `settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false`,
  injected: `settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
  injectWorkspacePackages: true`,
};

export const OVERRIDES = `overrides:
  body-parser: ^2.3.0
  qs: ^6.16.0`;

/** A lockfile as pnpm writes one: top-level sections apart by a blank line, and so is every entry of a keyed one. */
export function lockfileText({ version = `'9.0'`, settings = SETTINGS.plain, extra = [OVERRIDES], importers, packages, snapshots }) {
  const keyed = (name, entries) => `${name}:\n\n${entries.join('\n\n')}`;
  return `${[
    `lockfileVersion: ${version}`,
    settings,
    ...extra,
    keyed('importers', importers),
    keyed('packages', packages),
    keyed('snapshots', snapshots),
  ].join('\n\n')}\n`;
}

const ALL = (blocks) => Object.values(blocks);

/** The root lockfile of the two apps. */
export const ROOT_LOCKFILE = lockfileText({
  importers: ALL(IMPORTERS),
  packages: ALL(PACKAGES),
  snapshots: ALL(SNAPSHOTS),
});

/** The root workspace file, as a person writes one: comments, a quoted glob, reasons beside settings. */
export const ROOT_WORKSPACE = `# Every app's projects, and the repository's tools.
packages:
  - apps/alpha
  - apps/alpha/server
  - apps/alpha/common
  - apps/beta
  - 'apps/beta/packages/*'
  - tools/*

# Off for the workspace. Each app's cut carries its own.
injectWorkspacePackages: false

allowBuilds:
  esbuild: true # build tooling
  fsevents: false
  react: false

overrides:
  body-parser: ^2.3.0 # a reason
  qs: ^6.16.0

saveExact: true
`;

export const PACKAGE_MANAGER = 'pnpm@11.11.0+sha512.0000';

/** A package.json naming `packageManager`, or naming none when it is undefined. */
export function manifestOf(name, packageManager) {
  const fields = packageManager === undefined ? { name, private: true } : { name, private: true, packageManager };
  return `${JSON.stringify(fields, null, 2)}\n`;
}

export function manifest(name) {
  return manifestOf(name, PACKAGE_MANAGER);
}

/** The files of the two-app workspace, keyed by their paths from its root. */
export function workspaceFiles({ lockfile = ROOT_LOCKFILE, workspace = ROOT_WORKSPACE } = {}) {
  return {
    'package.json': manifest('fixture-root'),
    'pnpm-lock.yaml': lockfile,
    'pnpm-workspace.yaml': workspace,
    'apps/alpha/package.json': manifest('alpha'),
    'apps/alpha/common/package.json': manifest('@alpha/common'),
    'apps/alpha/server/package.json': manifest('@alpha/server'),
    'apps/beta/package.json': manifest('beta'),
  };
}

/** The fixture's two apps under the names of two real ones, so the tool's own table gives their injection setting. */
export function asRealApps(text) {
  return text.replaceAll('apps/alpha', 'apps/infra-manager').replaceAll('apps/beta', 'apps/web2-admin');
}

/** The two-app workspace with its apps at `apps/infra-manager` and `apps/web2-admin`. */
export function realAppFiles() {
  return Object.fromEntries(Object.entries(workspaceFiles()).map(([path, text]) => [asRealApps(path), asRealApps(text)]));
}

/** What the tool writes for one of the real-named apps, computed by the library its scripts run. */
export function expectedCut(app, injectWorkspacePackages) {
  const lockfile = cutLockfile(asRealApps(ROOT_LOCKFILE), { app, injectWorkspacePackages });
  const workspace = cutWorkspace(asRealApps(ROOT_WORKSPACE), {
    app,
    injectWorkspacePackages,
    packageNames: lockfile.packageNames,
    projects: lockfile.projects,
  });
  return { lockfile: lockfile.text, workspace };
}
