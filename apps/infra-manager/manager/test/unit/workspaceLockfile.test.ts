/**
 * The one lockfile the manager resolves from, and that it is the only one.
 *
 * pnpm keeps a single lockfile at the root of a workspace and never reads one
 * inside a package, so a package-level lockfile is a copy nothing regenerates.
 * frontend/pnpm-lock.yaml sat unchanged from 2026-05-19 while the package
 * gained three dependencies, and Dependabot filed twenty of the repository's
 * sixty alerts against it. It went on 2026-09-16, and this keeps the next one
 * from settling in.
 *
 * The workspace is found the way pnpm finds it, from the nearest
 * pnpm-workspace.yaml above the manager's folder. That was the manager's own
 * until the repository became one workspace, and is the repository's root
 * since. Either way there must be exactly one between the manager and the top
 * of the repository: a workspace file left in the manager's folder would make
 * pnpm treat the manager as a workspace of its own again, beside the root's.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..', '..');

/** Every folder from `start` up to the repository's top, the first that holds `.git`, or to `/` outside one. */
function foldersUpToRepositoryTop(start: string): string[] {
  const folders: string[] = [];
  for (let folder = start; ; folder = dirname(folder)) {
    folders.push(folder);
    if (existsSync(join(folder, '.git')) || dirname(folder) === folder) {
      return folders;
    }
  }
}

/** The folders holding a pnpm-workspace.yaml at or above the manager's, nearest first, as pnpm looks for one. */
const workspaceRoots = foldersUpToRepositoryTop(app).filter((folder) => existsSync(join(folder, 'pnpm-workspace.yaml')));
const [root] = workspaceRoots;

/** A path from the workspace root with forward slashes, as the workspace file and the lockfile write it. */
function fromRoot(path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Every package entry the workspace file lists, one `  - path` line each, with any quotes taken off. */
function listedPackages(): string[] {
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  return [...workspace.matchAll(/^ {2}- ['"]?([^'"\s#]+)['"]?\s*$/gm)].map((match) => match[1]);
}

/** The listed packages that are the manager's: all of them in its own workspace, those under its folder in the repository's. */
function managerPackages(): string[] {
  const appPath = fromRoot(app);
  return listedPackages().filter((path) => appPath === '' || path === appPath || path.startsWith(`${appPath}/`));
}

describe('the workspace lockfile', () => {
  it('belongs to exactly one workspace between the manager and the top of the repository', () => {
    assert.equal(
      workspaceRoots.length,
      1,
      `pnpm-workspace.yaml in ${workspaceRoots.length} folders at or above the manager: ${workspaceRoots.join(', ')}`,
    );
  });

  it("covers every package of the manager's the workspace names", () => {
    const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const packages = managerPackages();
    assert.ok(packages.length > 0, "the workspace file names the manager's packages the way this test reads them");
    for (const path of packages) {
      assert.ok(existsSync(join(root, path, 'package.json')), `${path} is a package`);
      // An importer with no dependencies of its own, such as the app's root package, is written `path: {}`.
      assert.match(lockfile, new RegExp(`^ {2}${path}:( \\{\\})?$`, 'm'), `${path} is an importer of the workspace lockfile`);
    }
  });

  it('is the only one, because pnpm never reads a lockfile inside a package', () => {
    const folders = managerPackages().map((path) => join(root, path));
    if (root !== app) {
      folders.push(app);
    }
    for (const folder of folders) {
      assert.equal(
        existsSync(join(folder, 'pnpm-lock.yaml')),
        false,
        `${fromRoot(folder)}/pnpm-lock.yaml is a stale copy nothing regenerates`,
      );
    }
  });
});
