import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_SETTINGS } from './apps.mjs';
import { UsageError, countOf, parseOptions, requireOption, runWhenStarted } from './lib/cli.mjs';
import { cutLockfile } from './lib/lockfile.mjs';
import { Refusal } from './lib/refusal.mjs';
import { cutWorkspace } from './lib/workspace.mjs';

const USAGE = `Usage: node tools/app-workspace/cut.mjs --app <folder> --out <folder> [--root <folder>] [--in-export]

Writes the pnpm-lock.yaml and pnpm-workspace.yaml of one app of this repository into --out, cut out of the root
ones, so the app builds from its own folder as it did before the root held the one lockfile. --app is the app's
folder from the root, for example apps/infra-manager. --root is the workspace root, by default the repository this
tool sits in.

The lockfile keeps the app's importers, named from its folder, and exactly the snapshots and packages they reach,
each as the root has it. The workspace file is the root's with the app's own globs, the injection setting apps.mjs
gives the app, and build permissions for the app's own packages alone.

It writes nothing and says why when:
  --out is inside the workspace, unless --in-export says the root is a git archive export, which has no .git
  --out already holds a pnpm-lock.yaml or a pnpm-workspace.yaml
  the root or the app names no packageManager, or the two name different ones
  apps.mjs has no entry for the app
  the root has no pnpm-lock.yaml, or its lockfile is not format '9.0'
  a workspace link, a folder dependency or a glob reaches outside the app

Exit codes: 0 written, 1 refused, 2 bad arguments.`;

const OPTION_SPECS = {
  app: { type: 'string' },
  out: { type: 'string' },
  root: { type: 'string' },
  'in-export': { type: 'boolean' },
};

const LOCKFILE = 'pnpm-lock.yaml';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const MANIFEST = 'package.json';

/** The repository this tool sits in, `tools/app-workspace` two folders down. */
export const DEFAULT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** An app's folder as the lockfile names it: relative to the root, forward slashes, no trailing slash. */
export function normalizeApp(app) {
  const normalized = posix.normalize(app.replaceAll('\\', '/')).replace(/\/+$/, '');
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) {
    throw new UsageError(`--app names a folder inside the root, such as apps/infra-manager, not ${app}.`);
  }
  return normalized;
}

/** The real path of a folder that may not exist yet: its nearest existing parent's real path, and the rest. */
function realPathOf(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(realPathOf(parent), basename(absolute));
}

function isInside(folder, root) {
  const path = relative(realPathOf(root), realPathOf(folder));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function packageManagerOf(folder) {
  const manifest = join(folder, MANIFEST);
  if (!existsSync(manifest)) throw new Refusal(`${folder} holds no ${MANIFEST}.`);
  return JSON.parse(readFileSync(manifest, 'utf8')).packageManager;
}

function assertOutFolder({ root, out, inExport }) {
  if (isInside(out, root)) {
    if (!inExport) {
      throw new Refusal(
        `${out} is inside the workspace at ${root}. A ${WORKSPACE_FILE} there makes that folder a workspace of its own, which pnpm before 11.28 ignores without a word. Write the cut to a folder outside the workspace, or build from a copy with tools/app-workspace/in-copy.mjs.`,
      );
    }
    if (existsSync(join(root, '.git'))) {
      throw new Refusal(
        `--in-export writes into ${out}, but ${root} is a git checkout, where a person may work, and not an export. Build from a copy with tools/app-workspace/in-copy.mjs instead.`,
      );
    }
  }
  for (const name of [LOCKFILE, WORKSPACE_FILE]) {
    if (existsSync(join(out, name))) {
      throw new Refusal(`${out} already holds ${name}. An app that keeps its own lockfile builds from it as it is, and a cut replaces nothing.`);
    }
  }
}

function assertSamePackageManager(root, app) {
  const rootManager = packageManagerOf(root);
  if (rootManager === undefined) {
    throw new Refusal(`The root package.json names no packageManager, so there is no pnpm for ${app} to build with.`);
  }
  const appManager = packageManagerOf(join(root, app));
  if (appManager === undefined) {
    throw new Refusal(
      `${app}/package.json names no packageManager. A build from the app folder alone would run corepack's own default pnpm. Give it the root's, ${rootManager}.`,
    );
  }
  if (appManager !== rootManager) {
    throw new Refusal(
      `${app}/package.json names ${appManager} in packageManager and the root names ${rootManager}. A build from the app folder runs the app's, and pnpm 11 refuses to run where another is named, so the two must match.`,
    );
  }
}

/**
 * Cuts one app's lockfile and workspace file out of the root's into `out`, after every check has passed.
 * @returns {string} the sentence that says what it wrote
 */
export function cutApp({ root, app, out, inExport = false }) {
  const settings = APP_SETTINGS[app];
  if (settings === undefined) {
    throw new Refusal(`tools/app-workspace/apps.mjs names no injection setting for ${app}. Add the app there with the setting its image build needs.`);
  }
  assertOutFolder({ root, out, inExport });
  for (const name of [LOCKFILE, WORKSPACE_FILE]) {
    if (!existsSync(join(root, name))) {
      throw new Refusal(`${root} holds no ${name}, so its apps keep their own lockfiles and build from them as they are.`);
    }
  }
  assertSamePackageManager(root, app);

  const lockfile = cutLockfile(readFileSync(join(root, LOCKFILE), 'utf8'), { app, ...settings });
  const workspace = cutWorkspace(readFileSync(join(root, WORKSPACE_FILE), 'utf8'), {
    app,
    ...settings,
    packageNames: lockfile.packageNames,
    projects: lockfile.projects,
  });

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, LOCKFILE), lockfile.text);
  writeFileSync(join(out, WORKSPACE_FILE), workspace);
  return `${app}: ${countOf(lockfile.projects.length, 'project')} besides its own, ${lockfile.packageCount} of the root's ${lockfile.rootPackageCount} packages, injectWorkspacePackages ${settings.injectWorkspacePackages}. Wrote ${LOCKFILE} and ${WORKSPACE_FILE} to ${out}.`;
}

export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const app = normalizeApp(requireOption(options, 'app'));
  const out = resolve(requireOption(options, 'out'));
  const root = resolve(options.root ?? DEFAULT_ROOT);
  process.stdout.write(`${cutApp({ root, app, out, inExport: options['in-export'] === true })}\n`);
  return 0;
}

await runWhenStarted(import.meta.url, USAGE, main, { refused: 1, usage: 2 });
