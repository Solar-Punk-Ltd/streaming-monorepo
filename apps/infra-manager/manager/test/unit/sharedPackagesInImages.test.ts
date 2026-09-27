/**
 * The repository's shared packages, one folder under its root `packages`, reach an image of the manager only as the
 * cut carries them: tools/app-workspace copies each one the manager links into `workspace-packages/<name>` beside the
 * cut lockfile. An image that does not copy them there fails its frozen install, and an api that runs compiled code
 * without the compiled condition loads a shared package's TypeScript sources and stops at its first import.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Manifest {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REPOSITORY = resolve(APP, '../..');
const SHARED_FOLDER = 'packages';
const CARRIED_FOLDER = 'workspace-packages';
const PROJECTS = ['common', 'manager', 'frontend'];
const COMPILED_CONDITION = '--conditions=compiled';

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;

/** The repository's shared packages by name, each with its folder name and manifest. */
function sharedPackages(): Map<string, { folder: string; manifest: Manifest }> {
  const root = join(REPOSITORY, SHARED_FOLDER);
  const found = new Map<string, { folder: string; manifest: Manifest }>();
  if (!existsSync(root)) return found;
  for (const folder of readdirSync(root)) {
    const path = join(root, folder, 'package.json');
    if (existsSync(path)) {
      const manifest = readManifest(path);
      found.set(manifest.name, { folder, manifest });
    }
  }
  return found;
}

const workspaceDependencies = (manifest: Manifest): string[] =>
  Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => name);

/** The folder of every shared package a project of the manager reaches, through its own packages or another. */
function sharedFoldersReachedBy(project: string): string[] {
  const shared = sharedPackages();
  const ownByName = new Map(PROJECTS.map((name) => [readManifest(join(APP, name, 'package.json')).name, name]));
  const reached = new Set<string>();
  const visiting = [readManifest(join(APP, project, 'package.json'))];
  for (const manifest of visiting) {
    for (const name of workspaceDependencies(manifest)) {
      const own = ownByName.get(name);
      const carried = shared.get(name);
      if (own !== undefined) {
        visiting.push(readManifest(join(APP, own, 'package.json')));
      } else if (carried !== undefined && !reached.has(carried.folder)) {
        reached.add(carried.folder);
        visiting.push(carried.manifest);
      }
    }
  }
  return [...reached];
}

/** Every `COPY <source> <target>` of a Dockerfile's build context, as `[source, target]`. */
function contextCopies(dockerfile: string): Array<[string, string]> {
  return dockerfile
    .split('\n')
    .map((line) => /^COPY (?!--from)(\S+) (\S+)$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map(([, source, target]) => [source.replace(/\/$/, ''), target.replace(/^\.\//, '').replace(/\/$/, '')]);
}

/** The lines of a Dockerfile's last stage, the one the image runs. */
const runtimeStage = (dockerfile: string): string => dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

describe('the shared packages in the manager images', () => {
  for (const project of ['manager', 'frontend']) {
    it(`copies each shared package the ${project} reaches where the cut carries it, manifest first`, () => {
      const copies = contextCopies(readFileSync(join(APP, project, 'Dockerfile'), 'utf8'));
      const sources = copies.map(([source]) => source);
      for (const folder of sharedFoldersReachedBy(project)) {
        const carried = `${CARRIED_FOLDER}/${folder}`;
        const manifestAt = sources.indexOf(`${carried}/package.json`);
        const sourcesAt = sources.indexOf(carried);
        assert.notEqual(manifestAt, -1, `the ${project} image never copies ${carried}/package.json`);
        assert.notEqual(sourcesAt, -1, `the ${project} image never copies ${carried}`);
        assert.ok(manifestAt < sourcesAt, `the ${project} image copies ${carried} before its manifest`);
        for (const [source, target] of copies.filter(([from]) => from.startsWith(carried))) {
          assert.equal(target, source.replace(/\/package\.json$/, ''), `${source} lands at ${target}`);
        }
      }
    });
  }

  it('reaches at least one shared package, so the test above asserts something', () => {
    assert.ok(sharedFoldersReachedBy('manager').length > 0);
  });

  it('runs every node process of the api image with the compiled condition', () => {
    const runtime = runtimeStage(readFileSync(join(APP, 'manager', 'Dockerfile'), 'utf8'));
    assert.equal(/^ENV NODE_OPTIONS=(\S+)$/m.exec(runtime)?.[1], COMPILED_CONDITION);
  });

  it('starts the built api with the compiled condition outside a container too', () => {
    const start = readManifest(join(APP, 'manager', 'package.json')).scripts?.start ?? '';
    assert.match(start, new RegExp(`^node ${COMPILED_CONDITION} dist/index\\.js$`));
  });
});
