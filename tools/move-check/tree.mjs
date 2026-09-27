import {
  CheckError,
  EXIT,
  UsageError,
  applyPrefixMaps,
  countOf,
  isAllowedPath,
  normalizeRelativePath,
  parseOptions,
  parsePrefixMaps,
  requireOption,
  runGit,
  runWhenStarted,
  showHelp,
} from './lib/shared.mjs';

const USAGE = `Usage: node tools/move-check/tree.mjs --from <rev>[:<dir>] --to <rev>[:<dir>]
         [--map <old-prefix>=<new-prefix>]... [--allow <path>]...

Compares every file, symlink and submodule of two git trees by mode and object id.
A side is a revision, or a directory inside one written <rev>:<dir> from the
repository root. Both must be in this repository, so fetch another project first.

  --map     renames a path, or a directory and everything under it, on the from
            side before comparing. The longest matching prefix wins.
  --allow   lets one difference through: an exact path, or a prefix ending in /.
            A missing path may be named by its new or its old path.

Without --map it also compares the two tree ids. Matching tree ids alone prove
that a subtree import copied the tree byte for byte.

Exit codes: 0 match, 1 difference, 2 the check could not run.`;

const OPTION_SPECS = {
  from: { type: 'string' },
  to: { type: 'string' },
  map: { type: 'string', multiple: true },
  allow: { type: 'string', multiple: true },
};

const SHORT_OBJECT_ID_LENGTH = 12;
const DIFFERENCE_KINDS = ['changed', 'missing', 'added'];

/**
 * @typedef {{ mode: string, type: string, objectId: string, path: string }} TreeEntry
 * @typedef {TreeEntry & { originalPath: string }} RenamedEntry
 */

/** Splits `<rev>[:<dir>]` into the revision and a directory relative to the repository root. */
export function parseTreeSpec(text) {
  const separator = text.indexOf(':');
  const rev = separator === -1 ? text : text.slice(0, separator);
  const dir = separator === -1 ? '' : normalizeRelativePath(text.slice(separator + 1));
  if (rev === '') throw new UsageError(`"${text}" names no revision before the colon.`);
  return { text, rev, dir };
}

/** Resolves a side to the id of the tree it names, or throws a CheckError that says why it cannot. */
function resolveTreeId(spec, flag) {
  const expression = spec.dir === '' ? `${spec.rev}^{tree}` : `${spec.rev}:${spec.dir}`;
  let objectId;
  try {
    objectId = runGit(['rev-parse', '--verify', expression]).trim();
  } catch (error) {
    throw new CheckError(`${flag} ${spec.text} does not name a revision, or a directory in one.\n${error.message}`);
  }
  const type = runGit(['cat-file', '-t', objectId]).trim();
  if (type !== 'tree') throw new CheckError(`${flag} ${spec.text} is a ${type}, not a directory.`);
  return objectId;
}

/** Parses `git ls-tree -r -z` output. A path runs from the first tab to the NUL, so it may hold tabs. */
export function parseLsTree(output) {
  return output
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode, type, objectId] = record.slice(0, tab).split(' ');
      return { mode, type, objectId, path: record.slice(tab + 1) };
    });
}

/** Lists every blob, symlink and submodule under a tree, with paths relative to that tree. */
function listTree(treeId) {
  return parseLsTree(runGit(['ls-tree', '-r', '-z', '--full-tree', treeId]));
}

/**
 * Keys the from side by the path each entry has after renaming, and remembers the path it had.
 * @returns {Map<string, RenamedEntry>}
 */
export function renameEntries(entries, rules) {
  const renamed = new Map();
  for (const entry of entries) {
    const path = applyPrefixMaps(entry.path, rules);
    const earlier = renamed.get(path);
    if (earlier) throw new CheckError(`--map sends both ${earlier.originalPath} and ${entry.path} to ${path}.`);
    renamed.set(path, { ...entry, path, originalPath: entry.path });
  }
  return renamed;
}

function isSameEntry(left, right) {
  return left.mode === right.mode && left.objectId === right.objectId;
}

/**
 * Sorts every path into changed (on both sides, different mode or object), missing (from side only)
 * and added (to side only), and counts the identical ones.
 */
export function compareTrees(fromEntries, toEntries) {
  const fromPaths = [...fromEntries.keys()].sort();
  const inBoth = fromPaths.filter((path) => toEntries.has(path));
  const isUnchanged = (path) => isSameEntry(fromEntries.get(path), toEntries.get(path));
  return {
    changed: inBoth
      .filter((path) => !isUnchanged(path))
      .map((path) => ({ path, from: fromEntries.get(path), to: toEntries.get(path) })),
    missing: fromPaths.filter((path) => !toEntries.has(path)).map((path) => ({ path, from: fromEntries.get(path) })),
    added: [...toEntries.keys()]
      .sort()
      .filter((path) => !fromEntries.has(path))
      .map((path) => ({ path, to: toEntries.get(path) })),
    identical: inBoth.filter(isUnchanged).length,
  };
}

function isAllowedDifference(difference, allows) {
  return isAllowedPath(difference.path, allows) || (difference.from !== undefined && isAllowedPath(difference.from.originalPath, allows));
}

function describeEntryState(entry) {
  return `${entry.mode} ${entry.objectId.slice(0, SHORT_OBJECT_ID_LENGTH)}`;
}

function describeDifference(kind, difference) {
  if (kind === 'changed') return `${difference.path}  ${describeEntryState(difference.from)} -> ${describeEntryState(difference.to)}`;
  if (kind === 'missing' && difference.from.originalPath !== difference.path) {
    return `${difference.path}  (was ${difference.from.originalPath})`;
  }
  return difference.path;
}

function formatFailure(comparison, allows, notAllowedCount, allowedCount) {
  const listed = DIFFERENCE_KINDS.filter((kind) => comparison[kind].length > 0).flatMap((kind) => [
    `${kind} (${comparison[kind].length}):`,
    ...comparison[kind].map((difference) => {
      const mark = isAllowedDifference(difference, allows) ? '  (allowed)' : '';
      return `  ${describeDifference(kind, difference)}${mark}`;
    }),
  ]);
  const allowedNote = allowedCount > 0 ? `, ${allowedCount} allowed` : '';
  return [
    ...listed,
    `identical: ${comparison.identical}`,
    `tree: differs, ${countOf(notAllowedCount, 'difference')} not allowed${allowedNote}`,
  ].join('\n');
}

function formatMatch({ comparison, allowedCount, treeIds }) {
  const identical = countOf(comparison.identical, 'identical entry', 'identical entries');
  const parts = ['tree: match'];
  if (treeIds && treeIds.from === treeIds.to) parts.push(`tree ids match (${treeIds.from})`);
  parts.push(identical);
  if (allowedCount > 0) parts.push(countOf(allowedCount, 'allowed difference'));
  if (treeIds && treeIds.from !== treeIds.to && allowedCount === 0) {
    parts.push('tree ids differ although every listed entry matches');
  }
  return parts.join(', ');
}

/** Runs the tree check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const fromSpec = parseTreeSpec(requireOption(options, 'from'));
  const toSpec = parseTreeSpec(requireOption(options, 'to'));
  const rules = parsePrefixMaps(options.map);
  const allows = options.allow ?? [];

  const fromTreeId = resolveTreeId(fromSpec, '--from');
  const toTreeId = resolveTreeId(toSpec, '--to');
  const toEntries = new Map(listTree(toTreeId).map((entry) => [entry.path, entry]));
  const comparison = compareTrees(renameEntries(listTree(fromTreeId), rules), toEntries);

  const differences = DIFFERENCE_KINDS.flatMap((kind) => comparison[kind]);
  const allowedCount = differences.filter((difference) => isAllowedDifference(difference, allows)).length;
  const notAllowedCount = differences.length - allowedCount;
  if (notAllowedCount > 0) {
    console.log(formatFailure(comparison, allows, notAllowedCount, allowedCount));
    return EXIT.DIFFERENCE;
  }
  const treeIds = rules.length === 0 ? { from: fromTreeId, to: toTreeId } : undefined;
  console.log(formatMatch({ comparison, allowedCount, treeIds }));
  return EXIT.MATCH;
}

await runWhenStarted(import.meta.url, USAGE, main);
