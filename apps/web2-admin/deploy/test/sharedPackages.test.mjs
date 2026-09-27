import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The repository's shared packages, one folder under its root `packages`, reach an image of the admin only as the
 * cut carries them: tools/app-workspace copies each one the admin links into `workspace-packages/<name>` beside the
 * cut lockfile. An image that does not copy them there fails its frozen install, and a backend that runs compiled
 * code without the compiled condition loads a shared package's TypeScript sources and stops at its first import.
 */

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPOSITORY = resolve(APP, '../..');
const SHARED_FOLDER = 'packages';
const CARRIED_FOLDER = 'workspace-packages';
const PROJECTS = ['common', 'backend', 'frontend'];
const COMPILED_CONDITION = '--conditions=compiled';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The repository's shared packages by name, each with its folder name and manifest. */
function sharedPackages() {
  const root = join(REPOSITORY, SHARED_FOLDER);
  const found = new Map();
  if (!existsSync(root)) return found;
  for (const folder of readdirSync(root)) {
    const path = join(root, folder, 'package.json');
    if (existsSync(path)) {
      const manifest = readJson(path);
      found.set(manifest.name, { folder, manifest });
    }
  }
  return found;
}

const workspaceDependencies = (manifest) =>
  Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, range]) => String(range).startsWith('workspace:'))
    .map(([name]) => name);

/** The folder of every shared package a project of the admin reaches, through the admin's own packages or another. */
function sharedFoldersReachedBy(project) {
  const shared = sharedPackages();
  const ownByName = new Map(PROJECTS.map((name) => [readJson(join(APP, name, 'package.json')).name, name]));
  const reached = new Set();
  const visiting = [readJson(join(APP, project, 'package.json'))];
  for (const manifest of visiting) {
    for (const name of workspaceDependencies(manifest)) {
      if (ownByName.has(name)) {
        visiting.push(readJson(join(APP, ownByName.get(name), 'package.json')));
      } else if (shared.has(name) && !reached.has(shared.get(name).folder)) {
        reached.add(shared.get(name).folder);
        visiting.push(shared.get(name).manifest);
      }
    }
  }
  return [...reached];
}

/** Every `COPY <source> <target>` of a Dockerfile's build context, as `[source, target]`. */
function contextCopies(dockerfile) {
  return dockerfile
    .split('\n')
    .map((line) => /^COPY (?!--from)(\S+) (\S+)$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map(([, source, target]) => [source.replace(/\/$/, ''), target.replace(/^\.\//, '').replace(/\/$/, '')]);
}

/** The lines of a Dockerfile's last stage, the one the image runs. */
const runtimeStage = (dockerfile) => dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

describe('the shared packages in the admin images', () => {
  for (const project of ['backend', 'frontend']) {
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
        for (const [source, target] of copies.filter(([source]) => source.startsWith(carried))) {
          assert.equal(target, source.replace(/\/package\.json$/, ''), `${source} lands at ${target}`);
        }
      }
    });
  }

  it('reaches at least one shared package, so the test above asserts something', () => {
    assert.ok(sharedFoldersReachedBy('backend').length > 0);
  });

  it('runs every node process of the backend image with the compiled condition', () => {
    const runtime = runtimeStage(readFileSync(join(APP, 'backend', 'Dockerfile'), 'utf8'));
    const nodeOptions = /^ENV NODE_OPTIONS=(\S+)$/m.exec(runtime)?.[1];
    assert.equal(nodeOptions, COMPILED_CONDITION);
  });

  it('starts the built backend with the compiled condition outside a container too', () => {
    const { start } = readJson(join(APP, 'backend', 'package.json')).scripts;
    assert.match(start, new RegExp(`^node ${COMPILED_CONDITION} dist/index\\.js$`));
  });
});
