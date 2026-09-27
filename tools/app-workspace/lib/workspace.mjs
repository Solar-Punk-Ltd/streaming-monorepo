import { CARRIED_FOLDER, packageNameOf } from './lockfile.mjs';
import { Refusal } from './refusal.mjs';
import { indentOf, readKey, readScalar, spell } from './yaml-lines.mjs';

const INJECT_SETTING = 'injectWorkspacePackages';
const GLOB_CHARACTERS = /[*?[{]/;

/** What stands above an injection setting the cut changed, in place of the root's comment on its own value. */
const OWN_SETTING_COMMENT = "# The app's own setting, from tools/app-workspace/apps.mjs.";

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
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '[^/]*')
        .replaceAll('?', '[^/]'),
    )
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
      throw new Refusal(
        `The root's glob ${value} can match projects inside ${app} from outside its folder, which a cut cannot rename.`,
      );
    }
  }
  return kept;
}

function assertCovers(globs, projects, app) {
  const include = globs.filter((glob) => !glob.value.startsWith('!')).map((glob) => globPattern(glob.value));
  const exclude = globs.filter((glob) => glob.value.startsWith('!')).map((glob) => globPattern(glob.value.slice(1)));
  for (const project of projects) {
    const listed =
      include.some((pattern) => pattern.test(project)) && !exclude.some((pattern) => pattern.test(project));
    if (!listed) throw new Refusal(`The cut's globs for ${app} leave out ${project}, a project the lockfile keeps.`);
  }
}

/** The `packages:` block with the app's globs alone, each in the quote the root gave it, and the carried packages'. */
function packagesBlock(lines, block, { app, projects, sharedPackages }) {
  const items = lines
    .slice(block.start + 1, block.end)
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => readScalar(line.trim().slice(2)));
  const globs = cutGlobs(items, app);
  if (sharedPackages.length > 0) globs.push({ value: `${CARRIED_FOLDER}/*`, quote: '' });
  assertCovers(globs, projects, app);
  if (globs.length === 0) return ['packages: []'];
  return ['packages:', ...globs.map((glob) => `  - ${spell(glob.value, glob.quote)}`)];
}

const BUILD_PERMISSIONS = new Set(['true', 'false']);

/**
 * The `allowBuilds:` block with the entries of the app's own packages alone, their comments kept. Each must say true
 * or false: pnpm writes `set this to true or false` in place of an answer when it refuses a build nobody approved.
 */
function allowBuildsBlock(lines, block, packageNames) {
  const entries = [];
  for (const line of lines.slice(block.start + 1, block.end)) {
    const body = line.trim();
    const key = readKey(body);
    if (key === null || !packageNames.has(packageNameOf(key.value))) continue;
    const permission = readScalar(body.slice(key.length + 1)).value;
    if (!BUILD_PERMISSIONS.has(permission)) {
      throw new Refusal(
        `The root's allowBuilds gives ${key.value} "${permission}", which is neither true nor false. pnpm writes that when it refuses a build nobody approved. Decide it in the root pnpm-workspace.yaml.`,
      );
    }
    entries.push(line);
  }
  return entries.length === 0 ? ['allowBuilds: {}'] : [lines[block.start], ...entries];
}

/**
 * Cuts one app's workspace file out of the root's, as text: the root's lines, with the app's globs, its injection
 * setting and the build permissions of its own packages. Comments and every other setting stay as the root has them.
 * When the lockfile carries shared packages, `workspace-packages/*` follows the app's globs.
 *
 * @param {string} text  the root pnpm-workspace.yaml
 * @param {{ app: string, injectWorkspacePackages: boolean, packageNames: Set<string>, projects: string[], sharedPackages?: import('./lockfile.mjs').SharedPackage[] }} options
 *   the app's folder from the root, its setting, and the packages, projects and shared packages its cut lockfile keeps
 * @returns {string}
 */
export function cutWorkspace(text, { app, injectWorkspacePackages, packageNames, projects, sharedPackages = [] }) {
  const lines = text.replace(/\n$/, '').split('\n');
  const packages = findBlock(lines, 'packages');
  if (packages === null)
    throw new Refusal('The root pnpm-workspace.yaml lists no packages, so there is no project to cut.');

  const edits = new Map([
    [packages.start, { end: packages.end, lines: packagesBlock(lines, packages, { app, projects, sharedPackages }) }],
  ]);

  const inject = findBlock(lines, INJECT_SETTING);
  const setting = `${INJECT_SETTING}: ${injectWorkspacePackages}`;
  if (inject !== null) {
    const current = readScalar(lines[inject.start].slice(INJECT_SETTING.length + 1)).value;
    if (current !== String(injectWorkspacePackages)) {
      // The comment right above the key explains the root's value, which this cut no longer has.
      let comment = inject.start;
      while (comment > 0 && lines[comment - 1].startsWith('#')) comment -= 1;
      edits.set(comment, { end: inject.end, lines: [OWN_SETTING_COMMENT, setting] });
    }
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
