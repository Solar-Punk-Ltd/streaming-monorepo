import { spawn } from 'node:child_process';

import {
  CheckError,
  EXIT,
  applyPrefixMaps,
  countOf,
  describeCommandFailure,
  diffJson,
  formatJsonPath,
  formatJsonValue,
  isAllowedPath,
  parseOptions,
  parsePrefixMaps,
  requireOption,
  runCommand,
  runWhenStarted,
  showHelp,
} from './lib/shared.mjs';
import {
  MATCH_APART_FROM_PNPM,
  describeContentChange,
  isCommandShimPath,
  isPnpmProgramManifest,
  linksIntoPnpmProgram,
  pnpmOwnFileName,
  pnpmProgramRoot,
} from './lib/pnpm-files.mjs';
import { TarFormatError, readTarSummaries } from './lib/tar.mjs';

const USAGE = `Usage: node tools/move-check/image.mjs --before <image> --after <image> [--map <old>=<new>]... [--allow <path>]...

Compares two local docker images. Nothing is pulled, so both must be local.

First the config a container runs with: Entrypoint, Cmd, Env, User,
ExposedPorts, WorkingDir, Healthcheck, Labels and Volumes. Then the file
systems: it creates a container from each image without starting it, streams
docker export through a tar reader, and compares every entry's path, type,
permission bits, owner, size, link target and, for a regular file, the sha256
of its content. Modification times are ignored. The containers are removed
afterwards, even when the check fails.

The files pnpm writes about an install rather than for a package, which are
.modules.yaml, .pnpm/lock.yaml, .pnpm-workspace-state-v1.json and
.package-map.json in an install's own node_modules folder, are listed by name
whenever they differ, with the pnpm that wrote each side and the keys that
differ. So is the rest of what pnpm itself puts in an image: the command shims
it writes into a node_modules/.bin folder, a node_modules folder that holds
nothing but them, pnpm installed as a global npm package, on one line with the
version each side holds, and a link into it. None of them fails the check or
counts as allowed. When the install time is all that differs, the images
match. When more does, as after a pnpm version change, the verdict is "match
apart from pnpm's own files", which still exits 0.

  --map     renames a path of the before image, or a folder and everything
            under it, before the two are compared, for a folder the after image
            keeps under another name. What is under it is still compared entry
            by entry, under the new name
  --allow   lets one file system difference through: an exact path such as
            /app/node_modules/.modules.yaml, or a prefix ending in /

Exit codes: 0 match, 1 difference, 2 the check could not run.`;

const OPTION_SPECS = {
  before: { type: 'string' },
  after: { type: 'string' },
  map: { type: 'string', multiple: true },
  allow: { type: 'string', multiple: true },
};

/** The config fields that decide how a container from the image runs. */
export const INSPECTED_CONFIG_FIELDS = Object.freeze([
  'Entrypoint',
  'Cmd',
  'Env',
  'User',
  'ExposedPorts',
  'WorkingDir',
  'Healthcheck',
  'Labels',
  'Volumes',
]);

/** docker create refuses an image with neither Entrypoint nor Cmd unless given a command. It never runs. */
const NEVER_STARTED_COMMAND = 'true';

const COMPARED_ENTRY_FIELDS = ['type', 'mode', 'owner', 'size', 'sha256', 'linkTarget'];
const CONTENT_FIELDS = new Set(['size', 'sha256']);
const ENTRY_FIELD_LABEL = { type: 'type', mode: 'mode', owner: 'owner', size: 'size', sha256: 'sha256', linkTarget: 'target' };
const DIFFERENCE_KINDS = ['changed', 'missing', 'added'];
/** The order pnpm itself tallies its differing entries in, the new ones first. */
const PROGRAM_TALLY_ORDER = ['added', 'changed', 'missing'];
const SHORT_DIGEST_LENGTH = 12;

/** Picks the compared fields from one `docker image inspect` record. A field the image leaves out reads as null. */
export function pickInspectedConfig(inspect) {
  const config = inspect?.Config ?? {};
  return Object.fromEntries(INSPECTED_CONFIG_FIELDS.map((name) => [name, config[name] ?? null]));
}

/** A path of the image in the tar reader's form, which has no leading slash. */
function withoutLeadingSlash(path) {
  return path.replace(/^\/+/, '');
}

/** The --map rules in the tar reader's form, longest old prefix first. */
function parseImageMaps(values) {
  return parsePrefixMaps(values)
    .map(({ from, to }) => ({ from: withoutLeadingSlash(from), to: withoutLeadingSlash(to) }))
    .toSorted((left, right) => right.from.length - left.from.length);
}

/**
 * Renames the before image's entries with the --map rules and counts the renamed ones. Two entries sent to one path
 * are refused, so a rename can never hide an entry. Without a rule nothing is renamed and nothing is refused.
 * @param {import('./lib/tar.mjs').TarEntrySummary[]} entries
 */
export function renameEntries(entries, rules) {
  const byPath = new Map();
  for (const entry of entries) {
    const path = applyPrefixMaps(entry.path, rules);
    const earlier = byPath.get(path);
    if (earlier && (earlier.originalPath !== path || entry.path !== path)) {
      throw new CheckError(`--map sends both /${earlier.originalPath} and /${entry.path} to /${path}.`);
    }
    byPath.set(path, { ...entry, path, originalPath: entry.path });
  }
  const renamed = [...byPath.values()];
  return {
    entries: renamed.map(({ originalPath, ...entry }) => entry),
    renamedCount: renamed.filter((entry) => entry.path !== entry.originalPath).length,
  };
}

function renamedPart(renamedCount) {
  return countOf(renamedCount, 'entry renamed by --map', 'entries renamed by --map');
}

function entryFieldValue(entry, name) {
  return name === 'owner' ? `${entry.uid}:${entry.gid}` : entry[name];
}

/**
 * Sorts file system entries into changed (with the fields that differ), missing (before only) and
 * added (after only), and counts the identical ones.
 * @param {import('./lib/tar.mjs').TarEntrySummary[]} beforeEntries
 * @param {import('./lib/tar.mjs').TarEntrySummary[]} afterEntries
 */
export function compareFileSystems(beforeEntries, afterEntries) {
  const before = new Map(beforeEntries.map((entry) => [entry.path, entry]));
  const after = new Map(afterEntries.map((entry) => [entry.path, entry]));
  const beforePaths = [...before.keys()].sort();
  const differingFields = (path) =>
    COMPARED_ENTRY_FIELDS.map((name) => ({
      name,
      before: entryFieldValue(before.get(path), name),
      after: entryFieldValue(after.get(path), name),
    })).filter((field) => field.before !== field.after);
  const compared = beforePaths.filter((path) => after.has(path)).map((path) => ({ path, fields: differingFields(path) }));
  const changed = compared.filter((entry) => entry.fields.length > 0);
  return {
    changed,
    missing: beforePaths.filter((path) => !after.has(path)).map((path) => ({ path })),
    added: [...after.keys()]
      .sort()
      .filter((path) => !before.has(path))
      .map((path) => ({ path })),
    identical: compared.length - changed.length,
  };
}

function inspectImage(image, flag) {
  let records;
  try {
    records = JSON.parse(runCommand('docker', ['image', 'inspect', image]));
  } catch (error) {
    if (error instanceof CheckError) throw new CheckError(`${flag} ${image} is not an image docker has locally.\n${error.message}`);
    throw new CheckError(`docker image inspect ${image} printed something that is not JSON.`);
  }
  return records[0];
}

/** Creates containers that are never started, and removes every one it made. */
function createContainerTracker() {
  const created = [];
  return {
    create(imageId) {
      const containerId = runCommand('docker', ['create', '--pull', 'never', imageId, NEVER_STARTED_COMMAND]).trim();
      created.push(containerId);
      return containerId;
    },
    removeAll() {
      for (const containerId of created) {
        try {
          runCommand('docker', ['rm', '--force', containerId]);
        } catch (error) {
          process.stderr.write(`Could not remove container ${containerId}: ${error.message}\n`);
        }
      }
    },
  };
}

function collectText(stream) {
  const parts = [];
  stream.on('data', (chunk) => parts.push(chunk));
  return () => Buffer.concat(parts).toString('utf8').trim();
}

function waitForExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
}

/**
 * Streams `docker export` of a container through the tar reader, keeping the bytes of the files `keepContent` picks.
 * Both how docker ended and what the reader saw are reported.
 */
async function exportFileSystem(containerId, label, keepContent) {
  const args = ['export', containerId];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = collectText(child.stderr);
  const exited = waitForExit(child);
  const reading = readTarSummaries(child.stdout, { keepContent }).catch((error) => {
    child.kill();
    throw error;
  });
  const [read, exit] = await Promise.allSettled([reading, exited]);
  if (exit.status === 'rejected') throw new CheckError(describeCommandFailure('docker', args, exit.reason));
  if (read.status === 'fulfilled' && exit.value.code === 0) return read.value;
  if (read.status === 'rejected' && !(read.reason instanceof TarFormatError)) throw read.reason;
  const ending = exit.value.code === null ? `signal ${exit.value.signal}` : `exit ${exit.value.code}`;
  const problems = [
    exit.value.code === 0 ? null : `docker ${args.join(' ')} ended with ${ending}.`,
    stderr() === '' ? null : `stderr: ${stderr()}`,
    read.status === 'rejected' ? `The export could not be read as a tar stream: ${read.reason.message}` : null,
  ].filter((problem) => problem !== null);
  throw new CheckError([`Reading the file system of ${label} failed.`, ...problems].join('\n'));
}

function formatFieldValue(name, value) {
  if (value === undefined) return '(none)';
  if (name === 'mode') return value.toString(8).padStart(4, '0');
  if (name === 'sha256') return value.slice(0, SHORT_DIGEST_LENGTH);
  return String(value);
}

function formatField({ name, before, after }) {
  return `${ENTRY_FIELD_LABEL[name]} ${formatFieldValue(name, before)} -> ${formatFieldValue(name, after)}`;
}

function describeFileSystemDifference(kind, difference) {
  const path = `/${difference.path}`;
  if (kind !== 'changed') return path;
  return `${path}  ${difference.fields.map(formatField).join(', ')}`;
}

/** One of pnpm's own files that differs: how, and whether its install time is all that did. */
function describePnpmFile(kind, difference, beforeByPath, afterByPath) {
  const { path } = difference;
  if (kind !== 'changed') return { path, text: kind, installTimeOnly: false };
  const entryFields = difference.fields.filter(({ name }) => !CONTENT_FIELDS.has(name));
  const parts = entryFields.map(formatField);
  let installTimeOnly = entryFields.length === 0;
  const before = beforeByPath.get(path);
  const after = afterByPath.get(path);
  if (before.type === 'file' && after.type === 'file' && before.sha256 !== after.sha256) {
    const change = describeContentChange(pnpmOwnFileName(path), before.content.toString('utf8'), after.content.toString('utf8'));
    parts.push(...change.parts);
    installTimeOnly &&= change.installTimeOnly;
  }
  return { path, text: parts.join(', '), installTimeOnly };
}

/** What changed in an entry, or that it was added or is missing, leaving out the digest, which says nothing more here. */
function changeText(kind, difference) {
  if (kind !== 'changed') return kind;
  const fields = difference.fields.filter(({ name }) => name !== 'sha256');
  return fields.length > 0 ? fields.map(formatField).join(', ') : 'rewritten';
}

/** True for a node_modules folder that holds command shims and nothing else, as pnpm makes one inside a package folder. */
function holdsOnlyShims(path, entriesByPath) {
  if (!/(^|\/)node_modules$/.test(path) || entriesByPath.get(path)?.type !== 'directory') return false;
  const inside = [...entriesByPath.keys()].filter((candidate) => candidate.startsWith(`${path}/`));
  return inside.length > 0 && inside.every(isCommandShimPath);
}

/** pnpm itself as one entry: the version each side holds, and how many of its entries differ. */
function describePnpmProgram(root, counts, beforeByPath, afterByPath) {
  const versionIn = (entriesByPath) => {
    const manifest = entriesByPath.get(`${root}/package.json`);
    if (manifest?.content === undefined) return 'none';
    try {
      return JSON.parse(manifest.content.toString('utf8')).version ?? 'no version';
    } catch {
      return 'no version';
    }
  };
  const before = versionIn(beforeByPath);
  const after = versionIn(afterByPath);
  const tally = PROGRAM_TALLY_ORDER.filter((kind) => counts[kind] > 0).map((kind, index) =>
    index === 0 ? `${countOf(counts[kind], 'entry', 'entries')} ${kind}` : `${counts[kind]} ${kind}`,
  );
  return { path: root, text: `pnpm itself, ${before === after ? before : `${before} -> ${after}`}: ${tally.join(', ')}`, installTimeOnly: false };
}

/**
 * Takes pnpm's own differences out of a comparison: the files pnpm writes about an install, the command shims it writes
 * and a node_modules folder that holds nothing but them, pnpm itself installed with npm, told as one entry, and a link
 * into it. Returns them described, sorted by path, and the differences that are left.
 */
function takePnpmOwn(fileSystem, beforeByPath, afterByPath) {
  const sideOf = (kind) => (kind === 'added' ? afterByPath : beforeByPath);
  const programs = new Map();
  const pnpmFiles = [];
  const isPnpmOwn = (kind, difference) => {
    const { path } = difference;
    if (pnpmOwnFileName(path) !== null) {
      pnpmFiles.push(describePnpmFile(kind, difference, beforeByPath, afterByPath));
      return true;
    }
    const root = pnpmProgramRoot(path);
    if (root !== null) {
      const counts = programs.get(root) ?? { added: 0, changed: 0, missing: 0 };
      counts[kind] += 1;
      programs.set(root, counts);
      return true;
    }
    if ([beforeByPath.get(path)?.linkTarget, afterByPath.get(path)?.linkTarget].some(linksIntoPnpmProgram)) {
      pnpmFiles.push({ path, text: `a link to pnpm itself, ${changeText(kind, difference)}`, installTimeOnly: false });
      return true;
    }
    if (isCommandShimPath(path)) {
      const what = sideOf(kind).get(path)?.type === 'directory' ? "a folder of pnpm's command shims" : 'a command shim pnpm writes';
      pnpmFiles.push({ path, text: `${what}, ${changeText(kind, difference)}`, installTimeOnly: false });
      return true;
    }
    if (kind !== 'changed' && holdsOnlyShims(path, sideOf(kind))) {
      const what = kind === 'missing' ? "a folder that held only pnpm's command shims" : "a folder that holds only pnpm's command shims";
      pnpmFiles.push({ path, text: `${what}, ${kind}`, installTimeOnly: false });
      return true;
    }
    return false;
  };
  const others = { identical: fileSystem.identical };
  for (const kind of DIFFERENCE_KINDS) others[kind] = fileSystem[kind].filter((difference) => !isPnpmOwn(kind, difference));
  for (const [root, counts] of programs) pnpmFiles.push(describePnpmProgram(root, counts, beforeByPath, afterByPath));
  return { pnpmFiles: pnpmFiles.toSorted((left, right) => (left.path < right.path ? -1 : 1)), others };
}

/** The listing of pnpm's own files that differ, and the part of the summary line that counts them. */
function describePnpmFiles(pnpmFiles) {
  if (pnpmFiles.length === 0) return { lines: [], summary: null };
  const summary = pnpmFiles.every((file) => file.installTimeOnly)
    ? countOf(pnpmFiles.length, "of pnpm's own files differs in its install time only", "of pnpm's own files differ in their install time only")
    : countOf(pnpmFiles.length, "of pnpm's own files differs", "of pnpm's own files differ");
  return { lines: [`pnpm's own files (${pnpmFiles.length}):`, ...pnpmFiles.map((file) => `  /${file.path}  ${file.text}`)], summary };
}

function formatFailure({ configDifferences, fileSystem, allows, notAllowedCount, allowedCount, renamedCount, pnpm }) {
  const configLines = configDifferences.map(
    (difference) => `${formatJsonPath(difference.path)}: before ${formatJsonValue(difference.before)}, after ${formatJsonValue(difference.after)}`,
  );
  const fileSystemLines = DIFFERENCE_KINDS.filter((kind) => fileSystem[kind].length > 0).flatMap((kind) => [
    `${kind} (${fileSystem[kind].length}):`,
    ...fileSystem[kind].map((difference) => {
      const mark = isAllowedPath(difference.path, allows) ? '  (allowed)' : '';
      return `  ${describeFileSystemDifference(kind, difference)}${mark}`;
    }),
  ]);
  const allowedNote = allowedCount > 0 ? `, ${allowedCount} allowed` : '';
  const pnpmNote = pnpm.summary === null ? '' : `, ${pnpm.summary}`;
  const renamedNote = renamedCount > 0 ? `, ${renamedPart(renamedCount)}` : '';
  return [
    ...configLines,
    ...fileSystemLines,
    ...pnpm.lines,
    `identical: ${fileSystem.identical}`,
    `image: differs, ${countOf(configDifferences.length, 'config difference')} and ${countOf(notAllowedCount, 'filesystem difference')} not allowed${allowedNote}${pnpmNote}${renamedNote}`,
  ].join('\n');
}

function report({ configDifferences, fileSystem, allows, renamedCount, beforeByPath, afterByPath }) {
  const { pnpmFiles, others } = takePnpmOwn(fileSystem, beforeByPath, afterByPath);
  const pnpm = describePnpmFiles(pnpmFiles);
  const otherDifferences = DIFFERENCE_KINDS.flatMap((kind) => others[kind]);
  const allowedCount = otherDifferences.filter((difference) => isAllowedPath(difference.path, allows)).length;
  const notAllowedCount = otherDifferences.length - allowedCount;
  if (configDifferences.length > 0 || notAllowedCount > 0) {
    console.log(formatFailure({ configDifferences, fileSystem: others, allows, notAllowedCount, allowedCount, renamedCount, pnpm }));
    return EXIT.DIFFERENCE;
  }
  const parts = [
    pnpmFiles.every((file) => file.installTimeOnly) ? 'image: match' : `image: ${MATCH_APART_FROM_PNPM}`,
    `${countOf(INSPECTED_CONFIG_FIELDS.length, 'config field')} equal`,
    countOf(fileSystem.identical, 'identical filesystem entry', 'identical filesystem entries'),
  ];
  if (allowedCount > 0) parts.push(countOf(allowedCount, 'allowed difference'));
  if (pnpm.summary !== null) parts.push(pnpm.summary);
  if (renamedCount > 0) parts.push(renamedPart(renamedCount));
  console.log([...pnpm.lines, parts.join(', ')].join('\n'));
  return EXIT.MATCH;
}

/** Runs the image check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const beforeImage = requireOption(options, 'before');
  const afterImage = requireOption(options, 'after');
  const allows = (options.allow ?? []).map(withoutLeadingSlash);
  const renames = parseImageMaps(options.map);

  const beforeInspect = inspectImage(beforeImage, '--before');
  const afterInspect = inspectImage(afterImage, '--after');
  const configDifferences = diffJson(pickInspectedConfig(beforeInspect), pickInspectedConfig(afterInspect), ['Config']);

  const containers = createContainerTracker();
  try {
    // A before path is compared under the name --map gives it, so that name decides whether its bytes are kept.
    const isKept = (path) => pnpmOwnFileName(path) !== null || isPnpmProgramManifest(path);
    const beforeEntries = await exportFileSystem(containers.create(beforeInspect.Id), `--before ${beforeImage}`, (path) =>
      isKept(applyPrefixMaps(path, renames)),
    );
    const afterEntries = await exportFileSystem(containers.create(afterInspect.Id), `--after ${afterImage}`, isKept);
    const renamed = renameEntries(beforeEntries, renames);
    return report({
      configDifferences,
      fileSystem: compareFileSystems(renamed.entries, afterEntries),
      allows,
      renamedCount: renamed.renamedCount,
      beforeByPath: new Map(renamed.entries.map((entry) => [entry.path, entry])),
      afterByPath: new Map(afterEntries.map((entry) => [entry.path, entry])),
    });
  } finally {
    containers.removeAll();
  }
}

await runWhenStarted(import.meta.url, USAGE, main);
