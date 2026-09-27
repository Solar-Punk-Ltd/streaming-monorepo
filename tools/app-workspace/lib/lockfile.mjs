import { posix } from 'node:path';

import { Refusal } from './refusal.mjs';
import { indentOf, readKey, readScalar, spell } from './yaml-lines.mjs';

/** The lockfile format pnpm 9, 10, 11 and 12 write, and the only one this reader knows. */
const LOCKFILE_VERSION = '9.0';

/** The line that opens and closes the document pnpm 12 writes above the lockfile proper. */
const DOCUMENT_MARKER = '---';

const INJECT_SETTING = 'injectWorkspacePackages';

/** The root folder whose projects, one folder down, an app may link and a cut carries. */
const SHARED_FOLDER = 'packages';
/** Where a cut carries each shared package, `packages/<name>` becoming `workspace-packages/<name>`. */
export const CARRIED_FOLDER = 'workspace-packages';

const IMPORTER_DEPENDENCY_FIELDS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);
const SNAPSHOT_EDGE_FIELDS = new Set(['dependencies', 'optionalDependencies']);

/** Where pnpm writes each part: an entry's key two spaces in, its fields four, a dependency six, its version eight. */
const DEPTH = Object.freeze({ ENTRY: 2, FIELD: 4, DEPENDENCY: 6, DEPENDENCY_FIELD: 8 });

/** A dependency pnpm installs under another name records the package it names, `string-width@4.2.3`, as its version. */
const ALIASED_VERSION = /^(?:@[^/@\s]+\/)?[^@/:(\s]+@/;

/** @typedef {{ key: string, lines: string[] }} Section  A top-level key's line and its body, trailing blank lines off. */
/** @typedef {{ key: import('./yaml-lines.mjs').Key, lines: string[] }} Entry  One entry of a keyed section. */

/**
 * Splits off the document pnpm 12 writes above the lockfile proper, which records the pnpm the workspace runs and
 * that pnpm's own binaries. It names the pnpm every app of this repository repeats in its packageManager, so a cut
 * keeps it as the root has it.
 *
 * @returns {{ packageManagerDocument: string, lockfile: string }}  the first document with both marker lines, or
 *   an empty string when the lockfile has none, and the lockfile after it
 */
function splitPackageManagerDocument(text) {
  if (!text.startsWith(`${DOCUMENT_MARKER}\n`)) return { packageManagerDocument: '', lockfile: text };
  const close = text.indexOf(`\n${DOCUMENT_MARKER}\n`, DOCUMENT_MARKER.length);
  if (close === -1) {
    throw new Refusal(`The root lockfile opens a document with ${DOCUMENT_MARKER} and never closes it.`);
  }
  const packageManagerDocument = text.slice(0, close + DOCUMENT_MARKER.length + 2);
  if (!/^ {4}packageManagerDependencies:$/m.test(packageManagerDocument)) {
    throw new Refusal(
      `The root lockfile's first document records no packageManagerDependencies, so it is not the record of pnpm's own version that pnpm 12 writes there.`,
    );
  }
  return { packageManagerDocument, lockfile: text.slice(packageManagerDocument.length) };
}

/** Splits a lockfile into its top-level sections, in order. */
function readSections(text) {
  const sections = [];
  for (const line of text.split('\n')) {
    if (line.trim() !== '' && indentOf(line) === 0) {
      const key = readKey(line);
      if (key === null) throw new Refusal(`The root lockfile has a top-level line this tool cannot read: ${line}`);
      sections.push({ key: key.value, lines: [line] });
    } else if (sections.length > 0) {
      sections.at(-1).lines.push(line);
    } else if (line.trim() !== '') {
      throw new Refusal(`The root lockfile starts with a line this tool cannot read: ${line}`);
    }
  }
  for (const section of sections) {
    while (section.lines.at(-1)?.trim() === '') section.lines.pop();
  }
  return sections;
}

/** The entries of `importers`, `packages` or `snapshots`, each its key line and the deeper lines under it. */
function readEntries(section) {
  const entries = [];
  for (const line of section.lines.slice(1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) === DEPTH.ENTRY) {
      const key = readKey(line.slice(DEPTH.ENTRY));
      if (key === null)
        throw new Refusal(`The root lockfile's ${section.key} has an entry this tool cannot read: ${line}`);
      entries.push({ key, lines: [line] });
    } else if (indentOf(line) > DEPTH.ENTRY && entries.length > 0) {
      entries.at(-1).lines.push(line);
    } else {
      throw new Refusal(`The root lockfile's ${section.key} has a line this tool cannot place: ${line}`);
    }
  }
  return entries;
}

/** The value after a line's key, at the depth given. */
function valueAfterKey(line, depth) {
  const body = line.slice(depth);
  return readScalar(body.slice(readKey(body).length + 1)).value;
}

/** Every `{ name, version, index }` in an importer's dependency fields, `index` being the version's line. */
function importerDependencies(entry) {
  const found = [];
  let inField = false;
  let name = null;
  for (const [index, line] of entry.lines.entries()) {
    if (index === 0) continue;
    const depth = indentOf(line);
    const key = readKey(line.slice(depth));
    if (depth === DEPTH.FIELD) {
      inField = IMPORTER_DEPENDENCY_FIELDS.has(key?.value);
      name = null;
    } else if (inField && depth === DEPTH.DEPENDENCY) {
      name = key.value;
    } else if (inField && depth === DEPTH.DEPENDENCY_FIELD && name !== null && key?.value === 'version') {
      found.push({ name, version: valueAfterKey(line, depth), index });
    }
  }
  return found;
}

/** Every `{ name, version }` a snapshot depends on, optional ones included. */
function snapshotEdges(entry) {
  const found = [];
  let inField = false;
  for (const line of entry.lines.slice(1)) {
    const depth = indentOf(line);
    const key = readKey(line.slice(depth));
    if (depth === DEPTH.FIELD) inField = SNAPSHOT_EDGE_FIELDS.has(key?.value);
    else if (inField && depth === DEPTH.DEPENDENCY)
      found.push({ name: key.value, version: valueAfterKey(line, depth) });
  }
  return found;
}

function snapshotKeyOf(name, version) {
  return ALIASED_VERSION.test(version) ? version : `${name}@${version}`;
}

/** A snapshot's key without its peer suffix, `viem@2.0.0(zod@4.0.0)` to `viem@2.0.0`, is its package's key. */
function packageKeyOf(snapshotKey) {
  const peers = snapshotKey.indexOf('(');
  return peers === -1 ? snapshotKey : snapshotKey.slice(0, peers);
}

/** `@scope/name@1.0.0` to `@scope/name`. */
export function packageNameOf(packageKey) {
  return packageKey.slice(0, packageKey.lastIndexOf('@') > 0 ? packageKey.lastIndexOf('@') : packageKey.length);
}

function isIn(app, importer) {
  return importer === app || importer.startsWith(`${app}/`);
}

/** A project one folder under the root's `packages`, as the root's `packages/*` glob lists it. */
function isShared(importer) {
  return posix.dirname(importer) === SHARED_FOLDER;
}

/** An importer's name in the cut: the app's named from its folder, its own as `.`, a shared package's carried. */
function renameImporter(app, importer) {
  if (!isIn(app, importer)) return `${CARRIED_FOLDER}/${posix.basename(importer)}`;
  return importer === app ? '.' : importer.slice(app.length + 1);
}

/** Where a `link:` from an importer leads, both as paths from the workspace root. */
function linkTarget(importer, link) {
  return posix.normalize(posix.join(importer, link.slice('link:'.length)));
}

/**
 * An importer's lines under its name in the cut, each link whose target moved pointed at the target's place in the
 * cut. A link between two projects that move together reads as the root has it.
 */
function renamedEntry(app, entry) {
  const renamed = renameImporter(app, entry.key.value);
  const lines = [...entry.lines];
  for (const { version, index } of importerDependencies(entry)) {
    if (!version.startsWith('link:')) continue;
    const target = renameImporter(app, linkTarget(entry.key.value, version));
    if (linkTarget(renamed, version) === target) continue;
    const body = lines[index].slice(DEPTH.DEPENDENCY_FIELD);
    const key = readKey(body);
    const { quote } = readScalar(body.slice(key.length + 1));
    const link = `link:${posix.relative(`/${renamed}`, `/${target}`)}`;
    lines[index] = `${' '.repeat(DEPTH.DEPENDENCY_FIELD)}${body.slice(0, key.length + 1)} ${spell(link, quote)}`;
  }
  const afterKey = lines[0].slice(DEPTH.ENTRY + entry.key.length);
  lines[0] = `${' '.repeat(DEPTH.ENTRY)}${renamed === '.' ? '.' : spell(renamed, entry.key.quote)}${afterKey}`;
  return lines;
}

function settingsFor(section, injectWorkspacePackages) {
  const lines = section.lines.filter(
    (line) => !(indentOf(line) === DEPTH.ENTRY && readKey(line.slice(DEPTH.ENTRY))?.value === INJECT_SETTING),
  );
  if (injectWorkspacePackages) lines.push(`${' '.repeat(DEPTH.ENTRY)}${INJECT_SETTING}: true`);
  return lines;
}

function keyedSection(name, blocks) {
  return blocks.length === 0 ? `${name}: {}` : `${name}:\n\n${blocks.map((lines) => lines.join('\n')).join('\n\n')}`;
}

function sectionNamed(sections, name) {
  const section = sections.find((candidate) => candidate.key === name);
  if (section === undefined) throw new Refusal(`The root lockfile has no ${name} section.`);
  return section;
}

/** @typedef {{ from: string, to: string }} SharedPackage  A shared package's folder in the root, and in the cut. */

/**
 * Cuts one app's lockfile out of the root's. It keeps the app's importers, renamed from its folder, and exactly the
 * snapshots and packages they reach, each as the root has it, and every other section as it is. The settings carry
 * the app's own injection setting, which is the only line the cut writes that the root does not have.
 *
 * A shared package the app links, a project one folder under the root's `packages`, is carried as
 * `workspace-packages/<name>` with every package it links in turn, and the app's links to it point there. A shared
 * package may link only other shared packages.
 *
 * @param {string} text  the root pnpm-lock.yaml
 * @param {{ app: string, injectWorkspacePackages: boolean }} options  the app's folder from the root, and its setting
 * @returns {{ text: string, projects: string[], sharedPackages: SharedPackage[], packageNames: Set<string>, packageCount: number, rootPackageCount: number }}
 */
export function cutLockfile(text, { app, injectWorkspacePackages }) {
  const { packageManagerDocument, lockfile } = splitPackageManagerDocument(text);
  const sections = readSections(lockfile);
  const version = sections.find((section) => section.key === 'lockfileVersion');
  const spelled = version === undefined ? 'missing' : version.lines[0].slice('lockfileVersion:'.length).trim();
  if (version === undefined || readScalar(spelled).value !== LOCKFILE_VERSION) {
    throw new Refusal(
      `The root lockfile is format ${spelled}. This tool reads format '${LOCKFILE_VERSION}', which pnpm 9 to 12 write, and cuts nothing else.`,
    );
  }

  const rootImporters = readEntries(sectionNamed(sections, 'importers'));
  const appImporters = rootImporters.filter((entry) => isIn(app, entry.key.value));
  if (!appImporters.some((entry) => entry.key.value === app)) {
    throw new Refusal(`The root lockfile has no importer for ${app}, so it is no project of this workspace.`);
  }
  const rootImportersById = new Map(rootImporters.map((entry) => [entry.key.value, entry]));
  const carriedIds = new Set();

  const queue = [];
  const visiting = [...appImporters];
  for (const importer of visiting) {
    const importerIsShared = !isIn(app, importer.key.value);
    for (const { name, version: dependency } of importerDependencies(importer)) {
      if (dependency.startsWith('link:')) {
        const target = linkTarget(importer.key.value, dependency);
        if (importerIsShared && !isShared(target)) {
          throw new Refusal(
            `${importer.key.value} links ${name} from ${target} at ${dependency}. A shared package is carried into each app's cut on its own, so it may link only other packages one folder under ${SHARED_FOLDER}.`,
          );
        }
        if (!importerIsShared && !isIn(app, target) && !isShared(target)) {
          throw new Refusal(
            `${importer.key.value} links ${name} from ${target}, which is outside ${app}. A cut app folder cannot carry a package from outside it.`,
          );
        }
        if (!rootImportersById.has(target)) {
          throw new Refusal(
            `${importer.key.value} links ${name} from ${target}, which the root lockfile has no importer for.`,
          );
        }
        if (isShared(target) && !carriedIds.has(target)) {
          carriedIds.add(target);
          visiting.push(rootImportersById.get(target));
        }
      } else if (dependency.startsWith('file:')) {
        throw new Refusal(
          `${importer.key.value} depends on ${name} at ${dependency}, a path written from the workspace root, which a cut app folder would read from the wrong place.`,
        );
      } else {
        queue.push(snapshotKeyOf(name, dependency));
      }
    }
  }

  const snapshots = new Map(readEntries(sectionNamed(sections, 'snapshots')).map((entry) => [entry.key.value, entry]));
  const reached = new Set();
  while (queue.length > 0) {
    const key = queue.pop();
    if (reached.has(key)) continue;
    const snapshot = snapshots.get(key);
    if (snapshot === undefined)
      throw new Refusal(`${app} reaches ${key}, but the root lockfile holds no snapshot of it.`);
    reached.add(key);
    for (const { name, version: dependency } of snapshotEdges(snapshot)) {
      if (dependency.startsWith('link:') || dependency.startsWith('file:')) {
        throw new Refusal(
          `The snapshot ${key} depends on ${name} at ${dependency}, which a cut app folder cannot carry.`,
        );
      }
      queue.push(snapshotKeyOf(name, dependency));
    }
  }

  const packages = readEntries(sectionNamed(sections, 'packages'));
  const packageKeys = new Set(packages.map((entry) => entry.key.value));
  const keptPackageKeys = new Set([...reached].map(packageKeyOf));
  for (const key of keptPackageKeys) {
    if (!packageKeys.has(key))
      throw new Refusal(`${app} reaches ${key}, but the root lockfile holds no package entry for it.`);
  }

  const importers = [...appImporters, ...rootImporters.filter((entry) => carriedIds.has(entry.key.value))];
  const written = sections.map((section) => {
    switch (section.key) {
      case 'settings':
        return settingsFor(section, injectWorkspacePackages).join('\n');
      case 'importers':
        return keyedSection(
          'importers',
          importers.map((entry) => renamedEntry(app, entry)),
        );
      case 'packages':
        return keyedSection(
          'packages',
          packages.filter((entry) => keptPackageKeys.has(entry.key.value)).map((entry) => entry.lines),
        );
      case 'snapshots':
        return keyedSection(
          'snapshots',
          [...snapshots.values()].filter((entry) => reached.has(entry.key.value)).map((entry) => entry.lines),
        );
      default:
        return section.lines.join('\n');
    }
  });

  return {
    text: `${packageManagerDocument}${written.join('\n\n')}\n`,
    projects: importers.map((entry) => renameImporter(app, entry.key.value)).filter((id) => id !== '.'),
    sharedPackages: rootImporters
      .filter((entry) => carriedIds.has(entry.key.value))
      .map((entry) => ({ from: entry.key.value, to: renameImporter(app, entry.key.value) })),
    packageNames: new Set([...keptPackageKeys].map(packageNameOf)),
    packageCount: keptPackageKeys.size,
    rootPackageCount: packages.length,
  };
}
