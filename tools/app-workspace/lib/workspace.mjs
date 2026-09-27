import { packageNameOf } from './lockfile.mjs';
import { Refusal } from './refusal.mjs';
import { indentOf, readKey, readScalar, spell } from './yaml-lines.mjs';

const INJECT_SETTING = 'injectWorkspacePackages';
const GLOB_CHARACTERS = /[*?[{]/;

const header = (app) => [
  `# The workspace of ${app} alone, cut from the repository's root pnpm-workspace.yaml by tools/app-workspace.`,
  "# Its projects, its injection setting and its build permissions are the app's own. Edit the root file, never this one.",
];

/** @typedef {{ start: number, end: number }} Block  A top-level key's line and the indented lines under it, `end` excluded. */

/** The top-level key a line starts, or null for an indented, blank or comment line. */
function topLevelKey(line) {
  return line.trim() !== '' && indentOf(line) === 0 && !line.startsWith('#') ? readKey(line) : null;
}

/** The block of the top-level key `name`: its line and the indented lines that follow it without a break. */
function findBlock(lines, name) {
  const start = lines.findIndex((line) => topLevelKey(line)?.value === name);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '' && indentOf(lines[end]) > 0) end += 1;
  return { start, end };
}

/** A pnpm workspace glob as a regular expression over project paths: `*` stays in one folder, `**` crosses them. */
function globPattern(glob) {
  const source = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** Renames the root's globs for the app's folder. The app's own folder is the cut's root, and every other glob goes. */
function cutGlobs(items, app) {
  const kept = [];
  for (const { value, quote } of items) {
    const negated = value.startsWith('!');
    const glob = negated ? value.slice(1) : value;
    if (glob === app) continue;
    if (glob.startsWith(`${app}/`)) {
      kept.push({ value: `${negated ? '!' : ''}${glob.slice(app.length + 1)}`, quote });
      continue;
    }
    const literal = glob.split(GLOB_CHARACTERS)[0];
    if (GLOB_CHARACTERS.test(glob) && `${app}/`.startsWith(literal)) {
      throw new Refusal(`The root's glob ${value} can match projects inside ${app} from outside its folder, which a cut cannot rename.`);
    }
  }
  return kept;
}

function assertCovers(globs, projects, app) {
  const include = globs.filter((glob) => !glob.value.startsWith('!')).map((glob) => globPattern(glob.value));
  const exclude = globs.filter((glob) => glob.value.startsWith('!')).map((glob) => globPattern(glob.value.slice(1)));
  for (const project of projects) {
    const listed = include.some((pattern) => pattern.test(project)) && !exclude.some((pattern) => pattern.test(project));
    if (!listed) throw new Refusal(`The cut's globs for ${app} leave out ${project}, a project the lockfile keeps.`);
  }
}

/** The `packages:` block with the app's globs alone, each in the quote the root gave it. */
function packagesBlock(lines, block, { app, projects }) {
  const items = lines
    .slice(block.start + 1, block.end)
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => readScalar(line.trim().slice(2)));
  const globs = cutGlobs(items, app);
  assertCovers(globs, projects, app);
  if (globs.length === 0) return ['packages: []'];
  return ['packages:', ...globs.map((glob) => `  - ${spell(glob.value, glob.quote)}`)];
}

/** The `allowBuilds:` block with the entries of the app's own packages alone, their comments kept. */
function allowBuildsBlock(lines, block, packageNames) {
  const entries = lines.slice(block.start + 1, block.end).filter((line) => {
    const key = readKey(line.trim());
    return key !== null && packageNames.has(packageNameOf(key.value));
  });
  return entries.length === 0 ? ['allowBuilds: {}'] : [lines[block.start], ...entries];
}

/**
 * Cuts one app's workspace file out of the root's, as text: the root's lines, with the app's globs, its injection
 * setting and the build permissions of its own packages. Comments and every other setting stay as the root has them.
 *
 * @param {string} text  the root pnpm-workspace.yaml
 * @param {{ app: string, injectWorkspacePackages: boolean, packageNames: Set<string>, projects: string[] }} options
 *   the app's folder from the root, its setting, and the packages and projects its cut lockfile keeps
 * @returns {string}
 */
export function cutWorkspace(text, { app, injectWorkspacePackages, packageNames, projects }) {
  const lines = text.replace(/\n$/, '').split('\n');
  const packages = findBlock(lines, 'packages');
  if (packages === null) throw new Refusal('The root pnpm-workspace.yaml lists no packages, so there is no project to cut.');

  const edits = new Map([[packages.start, { end: packages.end, lines: packagesBlock(lines, packages, { app, projects }) }]]);

  const inject = findBlock(lines, INJECT_SETTING);
  const setting = `${INJECT_SETTING}: ${injectWorkspacePackages}`;
  if (inject !== null) {
    const current = readScalar(lines[inject.start].slice(INJECT_SETTING.length + 1)).value;
    if (current !== String(injectWorkspacePackages)) edits.set(inject.start, { end: inject.end, lines: [setting] });
  } else if (injectWorkspacePackages) {
    const packagesEdit = edits.get(packages.start);
    packagesEdit.lines = [...packagesEdit.lines, '', setting];
  }

  const allowBuilds = findBlock(lines, 'allowBuilds');
  if (allowBuilds !== null) {
    edits.set(allowBuilds.start, { end: allowBuilds.end, lines: allowBuildsBlock(lines, allowBuilds, packageNames) });
  }

  const written = [...header(app)];
  for (let index = 0; index < lines.length; index += 1) {
    const edit = edits.get(index);
    if (edit === undefined) {
      written.push(lines[index]);
      continue;
    }
    written.push(...edit.lines);
    index = edit.end - 1;
  }
  return `${written.join('\n')}\n`;
}
