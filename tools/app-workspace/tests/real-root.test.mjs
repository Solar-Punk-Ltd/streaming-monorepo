import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { APP_SETTINGS } from '../apps.mjs';
import { DEFAULT_ROOT, cutApp } from '../cut.mjs';
import { makeTempDir } from './support/fixtures.mjs';

/** The repository these tests run in. They read its own root files, never fixtures. */
const REPOSITORY_ROOT = DEFAULT_ROOT;
const LOCKFILE = 'pnpm-lock.yaml';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
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
