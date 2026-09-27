import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { describe, it } from 'node:test';

import { APP_SETTINGS } from '../apps.mjs';
import { DEFAULT_ROOT, cutApp } from '../cut.mjs';
import { TEST_ENV, TOOL_DIR, makeTempDir } from './support/fixtures.mjs';

/** The repository these tests run in. They read its own root files and its image manifest, never fixtures. */
const REPOSITORY_ROOT = DEFAULT_ROOT;
const IMAGE_MANIFEST = 'tools/move-check/images.json';
const LOCKFILE = 'pnpm-lock.yaml';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const ROOT_FILES = ['package.json', LOCKFILE, WORKSPACE_FILE];
const INJECT_SETTING = 'injectWorkspacePackages';

/** One of the repository's root files, failing in words when the repository keeps none. */
function rootFile(name) {
  const path = join(REPOSITORY_ROOT, name);
  assert.ok(
    existsSync(path),
    `${REPOSITORY_ROOT} holds no ${name}. These tests read the one workspace's own files and belong with it.`,
  );
  return readFileSync(path, 'utf8');
}

/** The document pnpm 12 writes above the lockfile proper, both marker lines included, or '' when there is none. */
function packageManagerDocumentOf(text) {
  return text.startsWith('---\n') ? text.slice(0, text.indexOf('\n---\n', 3) + '\n---\n'.length) : '';
}

/** The entries of one top-level section of the lockfile proper, by key, each the entry's own text, key line included. */
function sectionEntries(lockfile, section) {
  const text = lockfile.slice(packageManagerDocumentOf(lockfile).length);
  const start = text.indexOf(`\n${section}:\n`);
  assert.notEqual(start, -1, `the lockfile has no ${section} section`);
  const body = text.slice(start + section.length + 3);
  const end = body.search(/\n[^\s#]/);
  const entries = new Map();
  for (const chunk of (end === -1 ? body : body.slice(0, end)).split('\n\n')) {
    const entry = chunk.replace(/^\n+/, '').trimEnd();
    if (entry === '') continue;
    const key = /^ {2}(\S.*?):(?: \{\})?$/m.exec(entry.split('\n')[0]);
    assert.ok(key, `an entry of ${section} starts with a line that is not its key: ${entry.split('\n')[0]}`);
    entries.set(key[1].replace(/^'(.*)'$/, '$1'), entry);
  }
  return entries;
}

/** An entry's text without its key line, which is what a renamed importer keeps. */
const bodyOf = (entry) => entry.split('\n').slice(1).join('\n');

/** The root lockfile's importer that a cut names `key`, which the cut names from the app's folder. */
const rootImporterOf = (app, key) => (key === '.' ? app : `${app}/${key}`);

/** Cuts `app` out of the repository's own root files into a folder outside it, and reads the two files back. */
function cutOfRepository(t, app) {
  const out = makeTempDir(t);
  cutApp({ root: REPOSITORY_ROOT, app, out });
  return {
    lockfile: readFileSync(join(out, LOCKFILE), 'utf8'),
    workspace: readFileSync(join(out, WORKSPACE_FILE), 'utf8'),
  };
}

/** The image manifest the compare-images workflow builds from, as this commit holds it. */
function imageManifest() {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, IMAGE_MANIFEST), 'utf8'));
}

/** The command that cuts an app's pair into the folder it runs in, inside an export, as a manifest writes it. */
function cutCommandFor(context) {
  const up = posix.relative(context, '.');
  return ['node', `${up}/tools/app-workspace/cut.mjs`, '--root', up, '--app', context, '--out', '.', '--in-export'];
}

/**
 * What a cut reads of an export of this commit, laid out as the export lays it out and with no .git: the root
 * files, the tool itself and each app's package.json.
 */
function exportOfRepository(t) {
  const dir = makeTempDir(t);
  for (const name of ROOT_FILES) cpSync(join(REPOSITORY_ROOT, name), join(dir, name));
  cpSync(TOOL_DIR, join(dir, 'tools', 'app-workspace'), {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes('node_modules'),
  });
  for (const app of Object.keys(APP_SETTINGS)) {
    const manifest = join(dir, app, 'package.json');
    mkdirSync(dirname(manifest), { recursive: true });
    cpSync(join(REPOSITORY_ROOT, app, 'package.json'), manifest);
  }
  return dir;
}

describe("the cut of each app out of the repository's own root files", () => {
  for (const [app, settings] of Object.entries(APP_SETTINGS)) {
    it(`keeps every importer of ${app} and no other, each as the root lockfile has it`, (t) => {
      const root = rootFile(LOCKFILE);
      const cut = cutOfRepository(t, app);

      const rootImporters = sectionEntries(root, 'importers');
      const cutImporters = sectionEntries(cut.lockfile, 'importers');
      const expected = [...rootImporters.keys()].filter((key) => key === app || key.startsWith(`${app}/`));
      assert.ok(expected.length > 0, `the root lockfile has no importer under ${app}`);
      assert.deepEqual([...cutImporters.keys()].map((key) => rootImporterOf(app, key)).sort(), expected.sort());
      for (const [key, entry] of cutImporters) {
        assert.equal(bodyOf(entry), bodyOf(rootImporters.get(rootImporterOf(app, key))), `importer ${key} of ${app}`);
      }
    });

    it(`keeps each package and snapshot ${app} reaches exactly as the root resolved it`, (t) => {
      const root = rootFile(LOCKFILE);
      const cut = cutOfRepository(t, app);

      for (const section of ['packages', 'snapshots']) {
        const rootEntries = sectionEntries(root, section);
        const cutEntries = sectionEntries(cut.lockfile, section);
        assert.ok(cutEntries.size > 0, `the cut of ${app} has no ${section}`);
        assert.ok(cutEntries.size <= rootEntries.size);
        for (const [key, entry] of cutEntries) {
          assert.equal(entry, rootEntries.get(key), `${section} entry ${key} of ${app}`);
        }
      }
    });

    it(`starts ${app}'s lockfile with pnpm's own document, as the root lockfile has it`, (t) => {
      const root = rootFile(LOCKFILE);
      const cut = cutOfRepository(t, app);

      assert.notEqual(packageManagerDocumentOf(root), '', 'the root lockfile has no document recording pnpm');
      assert.equal(packageManagerDocumentOf(cut.lockfile), packageManagerDocumentOf(root));
    });

    it(`gives ${app} its own injection setting, ${settings.injectWorkspacePackages}, in both files`, (t) => {
      rootFile(WORKSPACE_FILE);
      const cut = cutOfRepository(t, app);

      assert.match(cut.workspace, new RegExp(`^${INJECT_SETTING}: ${settings.injectWorkspacePackages}$`, 'm'));
      const lockfileSetting = new RegExp(`^ {2}${INJECT_SETTING}: true$`, 'm');
      assert.equal(lockfileSetting.test(cut.lockfile), settings.injectWorkspacePackages);
    });
  }
});

describe("the image comparison's manifest", () => {
  it("cuts the app's pair first for every image built from an app's folder, and for no other", () => {
    const { images } = imageManifest();

    for (const image of images) {
      const prepare = image.prepare ?? [];
      if (Object.hasOwn(APP_SETTINGS, image.context)) {
        assert.deepEqual(prepare[0], cutCommandFor(image.context), `${image.name} builds from ${image.context}`);
      } else {
        const cuts = prepare.filter((command) => command.some((word) => word.endsWith('app-workspace/cut.mjs')));
        assert.deepEqual(cuts, [], `${image.name} builds from ${image.context}, which is no app's folder`);
      }
    }
  });

  it("writes each app's pair, as the root files cut it, when that first command runs in an export of this commit", (t) => {
    const { images } = imageManifest();
    const cutting = images.filter((image) => Object.hasOwn(APP_SETTINGS, image.context));
    assert.ok(cutting.length > 0, `${IMAGE_MANIFEST} builds no image from an app's folder`);

    for (const image of cutting) {
      // Each side that prepares builds from an export of its own, so each image gets a fresh one here too.
      const context = join(exportOfRepository(t), image.context);
      const [command, ...args] = image.prepare?.[0] ?? [];
      assert.equal(command, 'node', `${image.name}'s first prepare command`);

      const result = spawnSync(process.execPath, args, { cwd: context, env: TEST_ENV, encoding: 'utf8' });

      assert.equal(result.status, 0, `${image.name}: ${result.stderr}`);
      const expected = cutOfRepository(t, image.context);
      assert.equal(readFileSync(join(context, LOCKFILE), 'utf8'), expected.lockfile, `${image.name}'s ${LOCKFILE}`);
      assert.equal(readFileSync(join(context, WORKSPACE_FILE), 'utf8'), expected.workspace, `${image.name}'s ${WORKSPACE_FILE}`);
    }
  });
});
