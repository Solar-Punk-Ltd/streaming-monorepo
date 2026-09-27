import { spawn } from 'node:child_process';

import {
  CheckError,
  EXIT,
  countOf,
  describeCommandFailure,
  diffJson,
  formatJsonPath,
  formatJsonValue,
  isAllowedPath,
  parseOptions,
  requireOption,
  runCommand,
  runWhenStarted,
  showHelp,
} from './lib/shared.mjs';
import { TarFormatError, readTarSummaries } from './lib/tar.mjs';

const USAGE = `Usage: node tools/move-check/image.mjs --before <image> --after <image> [--allow <path>]...

Compares two local docker images. Nothing is pulled, so both must be local.

First the config a container runs with: Entrypoint, Cmd, Env, User,
ExposedPorts, WorkingDir, Healthcheck, Labels and Volumes. Then the file
systems: it creates a container from each image without starting it, streams
docker export through a tar reader, and compares every entry's path, type,
permission bits, owner, size, link target and, for a regular file, the sha256
of its content. Modification times are ignored. The containers are removed
afterwards, even when the check fails.

  --allow   lets one file system difference through: an exact path such as
            /app/node_modules/.modules.yaml, or a prefix ending in /

Exit codes: 0 match, 1 difference, 2 the check could not run.`;

const OPTION_SPECS = {
  before: { type: 'string' },
  after: { type: 'string' },
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
const ENTRY_FIELD_LABEL = { type: 'type', mode: 'mode', owner: 'owner', size: 'size', sha256: 'sha256', linkTarget: 'target' };
const DIFFERENCE_KINDS = ['changed', 'missing', 'added'];
const SHORT_DIGEST_LENGTH = 12;

/** Picks the compared fields from one `docker image inspect` record. A field the image leaves out reads as null. */
export function pickInspectedConfig(inspect) {
  const config = inspect?.Config ?? {};
  return Object.fromEntries(INSPECTED_CONFIG_FIELDS.map((name) => [name, config[name] ?? null]));
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

/** Streams `docker export` of a container through the tar reader. Both how docker ended and what the reader saw are reported. */
async function exportFileSystem(containerId, label) {
  const args = ['export', containerId];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = collectText(child.stderr);
  const exited = waitForExit(child);
  const reading = readTarSummaries(child.stdout).catch((error) => {
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

function describeFileSystemDifference(kind, difference) {
  const path = `/${difference.path}`;
  if (kind !== 'changed') return path;
  const fields = difference.fields.map(
    ({ name, before, after }) => `${ENTRY_FIELD_LABEL[name]} ${formatFieldValue(name, before)} -> ${formatFieldValue(name, after)}`,
  );
  return `${path}  ${fields.join(', ')}`;
}

function formatFailure({ configDifferences, fileSystem, allows, notAllowedCount, allowedCount }) {
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
  return [
    ...configLines,
    ...fileSystemLines,
    `identical: ${fileSystem.identical}`,
    `image: differs, ${countOf(configDifferences.length, 'config difference')} and ${countOf(notAllowedCount, 'filesystem difference')} not allowed${allowedNote}`,
  ].join('\n');
}

function report(configDifferences, fileSystem, allows) {
  const fileSystemDifferences = DIFFERENCE_KINDS.flatMap((kind) => fileSystem[kind]);
  const allowedCount = fileSystemDifferences.filter((difference) => isAllowedPath(difference.path, allows)).length;
  const notAllowedCount = fileSystemDifferences.length - allowedCount;
  if (configDifferences.length > 0 || notAllowedCount > 0) {
    console.log(formatFailure({ configDifferences, fileSystem, allows, notAllowedCount, allowedCount }));
    return EXIT.DIFFERENCE;
  }
  const parts = [
    'image: match',
    `${countOf(INSPECTED_CONFIG_FIELDS.length, 'config field')} equal`,
    countOf(fileSystem.identical, 'identical filesystem entry', 'identical filesystem entries'),
  ];
  if (allowedCount > 0) parts.push(countOf(allowedCount, 'allowed difference'));
  console.log(parts.join(', '));
  return EXIT.MATCH;
}

/** Runs the image check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const beforeImage = requireOption(options, 'before');
  const afterImage = requireOption(options, 'after');
  const allows = (options.allow ?? []).map((allow) => allow.replace(/^\/+/, ''));

  const beforeInspect = inspectImage(beforeImage, '--before');
  const afterInspect = inspectImage(afterImage, '--after');
  const configDifferences = diffJson(pickInspectedConfig(beforeInspect), pickInspectedConfig(afterInspect), ['Config']);

  const containers = createContainerTracker();
  try {
    const beforeEntries = await exportFileSystem(containers.create(beforeInspect.Id), `--before ${beforeImage}`);
    const afterEntries = await exportFileSystem(containers.create(afterInspect.Id), `--after ${afterImage}`);
    return report(configDifferences, compareFileSystems(beforeEntries, afterEntries), allows);
  } finally {
    containers.removeAll();
  }
}

await runWhenStarted(import.meta.url, USAGE, main);
