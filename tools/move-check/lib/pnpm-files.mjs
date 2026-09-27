import { isDeepStrictEqual } from 'node:util';

import { isPlainObject } from './shared.mjs';

/**
 * The files pnpm writes about an install rather than for any package, by their path inside the install's own
 * node_modules folder, each with the keys pnpm rewrites on every install. Read from pnpm 9.12.0, 10.29.3 and
 * 11.10.0, the three this repository runs.
 */
export const PNPM_OWN_FILES = Object.freeze({
  /** The install's settings and layout, and the pnpm that made it. YAML under pnpm 9, JSON under 10 and later. */
  '.modules.yaml': ['prunedAt'],
  /** The lockfile of what is installed. */
  '.pnpm/lock.yaml': [],
  /** pnpm 10 and later: the settings and projects the install was checked against, and when. */
  '.pnpm-workspace-state-v1.json': ['lastValidatedTimestamp'],
  /** pnpm 11: where each installed package sits. */
  '.package-map.json': [],
});

/** The verdict of an image whose only differences beyond the allowed ones are in pnpm's own files. */
export const MATCH_APART_FROM_PNPM = "match apart from pnpm's own files";

const PACKAGE_MANAGER_LINE = /^\s*"?packageManager"?\s*:\s*["']?([^"',\s]+)/m;
const YAML_TOP_LEVEL_KEY = /^([^\s#-][^:]*):(?:\s|$)/;
const TOP_LEVEL = { json: 'JSON', yaml: 'YAML' };

/** A node_modules/.bin folder, where pnpm writes a shell script for each command a package offers. */
const COMMAND_SHIMS = /(^|\/)node_modules\/\.bin(\/|$)/;
/** pnpm itself, installed as a global npm package, as the bench and browser images install it. */
const PNPM_PROGRAM = /^(?:.*?\/)?lib\/node_modules\/pnpm(?=\/|$)/;
const PNPM_PROGRAM_TARGET = /(^|\/)lib\/node_modules\/pnpm\//;

/**
 * Which of pnpm's own files a path is, or null. The file must sit in the first node_modules folder of the path, so a
 * package's own file of the same name is never taken for one. The path is in the tar reader's form.
 */
export function pnpmOwnFileName(path) {
  const segments = path.split('/');
  const modules = segments.indexOf('node_modules');
  if (modules === -1) return null;
  const name = segments.slice(modules + 1).join('/');
  return Object.hasOwn(PNPM_OWN_FILES, name) ? name : null;
}

/** True for a node_modules/.bin folder and the command shims pnpm writes into it, at any depth. */
export function isCommandShimPath(path) {
  return COMMAND_SHIMS.test(path);
}

/** The folder of pnpm itself installed as a global npm package, when the path is that folder or inside it, else null. */
export function pnpmProgramRoot(path) {
  return PNPM_PROGRAM.exec(path)?.[0] ?? null;
}

/** True for pnpm's own package.json in that folder, which says which pnpm it is. */
export function isPnpmProgramManifest(path) {
  const root = pnpmProgramRoot(path);
  return root !== null && path === `${root}/package.json`;
}

/** True for a link target inside pnpm itself, as npm links pnpm's commands into a bin folder. */
export function linksIntoPnpmProgram(target) {
  return typeof target === 'string' && PNPM_PROGRAM_TARGET.test(target);
}

/** The pnpm a file says wrote it, such as `pnpm@9.12.0`, from its packageManager key in either format. */
function writtenBy(text) {
  return PACKAGE_MANAGER_LINE.exec(text)?.[1] ?? null;
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Splits YAML at its top-level keys, each with the lines under it. The block style pnpm writes needs nothing more. */
function yamlTopLevelBlocks(text) {
  const blocks = new Map();
  let key = null;
  for (const line of text.split('\n')) {
    const match = YAML_TOP_LEVEL_KEY.exec(line);
    if (match) {
      key = match[1].trim();
      blocks.set(key, []);
    }
    if (key !== null) blocks.get(key).push(line);
  }
  return new Map([...blocks].map(([name, lines]) => [name, lines.join('\n').trimEnd()]));
}

/** A file's top-level keys with their values, and the format it is written in. */
function readTopLevel(text) {
  const json = parseJsonObject(text);
  if (json !== null) return { format: TOP_LEVEL.json, values: new Map(Object.entries(json)) };
  return { format: TOP_LEVEL.yaml, values: yamlTopLevelBlocks(text) };
}

function differingKeys(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => !isDeepStrictEqual(before.get(key), after.get(key))).sort();
}

/**
 * Says how two versions of one of pnpm's own files differ: the pnpm that wrote each, when that changed, the change of
 * format, and otherwise the top-level keys that differ. `installTimeOnly` when every key that differs is one pnpm
 * rewrites on every install, which is all a rebuild of the same install changes.
 * @param {keyof PNPM_OWN_FILES} name
 * @returns {{ parts: string[], installTimeOnly: boolean }}
 */
export function describeContentChange(name, beforeText, afterText) {
  const parts = [];
  const beforeWriter = writtenBy(beforeText);
  const afterWriter = writtenBy(afterText);
  if (beforeWriter !== afterWriter) parts.push(`written by ${beforeWriter ?? 'no named pnpm'} -> ${afterWriter ?? 'no named pnpm'}`);
  const before = readTopLevel(beforeText);
  const after = readTopLevel(afterText);
  if (before.format !== after.format) return { parts: [...parts, `as ${before.format} -> ${after.format}`], installTimeOnly: false };
  const keys = differingKeys(before.values, after.values);
  if (keys.length === 0) return { parts: [...parts, 'in its formatting alone'], installTimeOnly: false };
  if (keys.every((key) => PNPM_OWN_FILES[name].includes(key))) {
    return { parts: [...parts, `its install time only: ${keys.join(', ')}`], installTimeOnly: parts.length === 0 };
  }
  return { parts: [...parts, `in ${keys.join(', ')}`], installTimeOnly: false };
}
