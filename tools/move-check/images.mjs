import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CheckError,
  EXIT,
  MAX_COMMAND_OUTPUT_BYTES,
  UsageError,
  countOf,
  parseOptions,
  parsePrefixMaps,
  requireOption,
  runCommand,
  runGit,
  runWhenStarted,
  showHelp,
} from './lib/shared.mjs';

const USAGE = `Usage: node tools/move-check/images.mjs --manifest <file> [--only <name>]... [--plan] [--keep] [--remove-images]

Builds every image a manifest names twice, once from its before commit and once
from its after commit, and compares the two with image.mjs. Each side is built
from a fresh export of its own commit, never from the working tree, and without
the build cache, so both are real builds.

The manifest is JSON:

  { "images": [ { "name": "web2-admin-backend",
                  "before": { "commit": "<id>", "context": ".", "dockerfile": "web2-admin/backend/Dockerfile" },
                  "after": { "commit": "<id>", "context": "apps/web2-admin", "dockerfile": "apps/web2-admin/backend/Dockerfile" },
                  "allow": ["/app/node_modules/.modules.yaml"],
                  "note": "why these commits" } ] }

A context and a Dockerfile are paths from the root of the repository at that
commit, and a context of . is the root itself. Each allow is handed to
image.mjs as --allow. An image may also carry "map", a list of renames each
written <old>=<new>, handed to image.mjs as --map, for a folder the after image
keeps under another name. A note is for whoever reads the manifest.

A side may also carry "prepare", a list of commands, each a list of its words,
such as [["corepack", "pnpm", "install", "--frozen-lockfile"]]. They run in the
side's context, without a shell, before its build, for an image whose
Dockerfile copies what a deploy script builds first. Such a side builds from an
export of its own, so what it builds reaches no other image.

  --plan   finds every commit, context and Dockerfile, prints the builds and builds nothing
  --only   checks one image of the manifest by name, and can be given more than once
  --keep   leaves the exports on disk and says where
  --remove-images
           removes both images of a pair, and the build cache, once the pair is
           compared, so a long run does not fill the disk. Without it the images
           stay, for a person to inspect

Exit codes: 0 every image matches, 1 an image differs, 2 an image could not be
checked or the manifest is wrong.`;

const OPTION_SPECS = {
  manifest: { type: 'string' },
  only: { type: 'string', multiple: true },
  plan: { type: 'boolean' },
  keep: { type: 'boolean' },
  'remove-images': { type: 'boolean' },
};

const IMAGE_CHECK = fileURLToPath(new URL('./image.mjs', import.meta.url));
const TAG_PREFIX = 'move-check-images';
const SIDES = ['before', 'after'];
const IMAGE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const COMMIT_ID = /^[0-9a-f]{7,40}$/;
/** One name of a path: no leading dot or dash, so `..` and anything read as an option are out. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SHORT_COMMIT_LENGTH = 12;
const STDOUT_FD = 1;

/**
 * A path from the repository root, as a manifest writes it. The context may be `.`, the root, which is
 * returned as ''. Anything that could leave the repository, or is not plain names joined by slashes, is refused.
 */
function repositoryPath(value, label, { rootAllowed }) {
  if (rootAllowed && value === '.') return '';
  if (typeof value !== 'string' || !value.split('/').every((name) => PLAIN_NAME.test(name))) {
    const root = rootAllowed ? ', or . for the root' : '';
    throw new CheckError(`${label} is a path of plain names from the repository root${root}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** A command as a manifest writes it: its words, the program first, none of them empty. */
function isCommand(value) {
  return Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === 'string' && word !== '');
}

function readSide(entry, sideName) {
  const side = entry[sideName];
  const label = `${entry.name} ${sideName}`;
  if (side === null || typeof side !== 'object') throw new CheckError(`${label} needs a commit, a context and a dockerfile.`);
  if (typeof side.commit !== 'string' || !COMMIT_ID.test(side.commit)) {
    throw new CheckError(`${label}: commit is a commit id, got ${JSON.stringify(side.commit)}.`);
  }
  const prepare = side.prepare ?? [];
  if (!Array.isArray(prepare) || !prepare.every(isCommand)) {
    throw new CheckError(`${label}: prepare is a list of commands, each a list of its words, got ${JSON.stringify(side.prepare)}.`);
  }
  return {
    commit: side.commit,
    context: repositoryPath(side.context, `${label}: context`, { rootAllowed: true }),
    dockerfile: repositoryPath(side.dockerfile, `${label}: dockerfile`, { rootAllowed: false }),
    prepare,
  };
}

/** An image's renames, each checked the way image.mjs will read it, so a broken one costs no build time. */
function readMap(entry) {
  const map = entry.map ?? [];
  if (!Array.isArray(map) || !map.every((rename) => typeof rename === 'string')) {
    throw new CheckError(`${entry.name}: map is a list of <old>=<new> renames, got ${JSON.stringify(entry.map)}.`);
  }
  try {
    parsePrefixMaps(map, `${entry.name}: map`);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new CheckError(error.message);
  }
  return map;
}

function readEntry(entry, index) {
  if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || !IMAGE_NAME.test(entry.name)) {
    throw new CheckError(`Image ${index + 1} of the manifest needs a name of lower case letters, digits and dashes, got ${JSON.stringify(entry?.name)}.`);
  }
  const allow = entry.allow ?? [];
  if (!Array.isArray(allow) || !allow.every((path) => typeof path === 'string' && path !== '')) {
    throw new CheckError(`${entry.name}: allow is a list of paths, got ${JSON.stringify(entry.allow)}.`);
  }
  return { name: entry.name, allow, map: readMap(entry), before: readSide(entry, 'before'), after: readSide(entry, 'after') };
}

/** Reads and checks the whole manifest before anything is built, so a mistake costs no build time. */
export function readManifest(path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CheckError(`--manifest ${path} could not be read as JSON: ${error.message}`);
  }
  if (!Array.isArray(manifest?.images) || manifest.images.length === 0) {
    throw new CheckError(`--manifest ${path} names no images. It needs an "images" list.`);
  }
  const images = manifest.images.map(readEntry);
  const seen = new Set();
  for (const { name } of images) {
    if (seen.has(name)) throw new CheckError(`${name} is named twice in the manifest.`);
    seen.add(name);
  }
  return images;
}

function selectImages(images, names) {
  if (names.length === 0) return images;
  for (const name of names) {
    if (!images.some((image) => image.name === name)) throw new UsageError(`--only ${name} names no image in the manifest.`);
  }
  return images.filter((image) => names.includes(image.name));
}

function objectType(commit, path) {
  try {
    return runGit(['cat-file', '-t', `${commit}:${path}`]).trim();
  } catch (error) {
    if (error instanceof CheckError) return null;
    throw error;
  }
}

/** The side with its commit written out in full, once its context and Dockerfile were found in that commit. */
function resolveSide(label, side) {
  let commit;
  try {
    commit = runGit(['rev-parse', '--verify', '--quiet', `${side.commit}^{commit}`]).trim();
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    throw new CheckError(`${label}: ${side.commit} is not a commit in this repository. Fetch it first.`);
  }
  if (side.context !== '' && objectType(commit, side.context) !== 'tree') {
    throw new CheckError(`${label}: ${commit} has no ${side.context} folder.`);
  }
  if (objectType(commit, side.dockerfile) !== 'blob') throw new CheckError(`${label}: ${commit} has no ${side.dockerfile}.`);
  return { ...side, commit };
}

function tagOf(name, sideName) {
  return `${TAG_PREFIX}/${name}:${sideName}`;
}

function printPlan(images) {
  for (const image of images) {
    console.log(image.name);
    for (const sideName of SIDES) {
      const side = image[sideName];
      const context = side.context === '' ? '.' : side.context;
      for (const command of side.prepare) console.log(`  ${sideName} ${side.commit}: in ${context}: ${command.join(' ')}`);
      console.log(`  ${sideName} ${side.commit}: docker build --no-cache --file ${side.dockerfile} --tag ${tagOf(image.name, sideName)} ${context}`);
    }
  }
  console.log(`images: plan, ${countOf(images.length, 'image')}, ${countOf(images.length * SIDES.length, 'build')}, every commit, context and Dockerfile found`);
  return EXIT.MATCH;
}

function indented(text) {
  return text.trim() === '' ? [] : text.trimEnd().split('\n').map((line) => `  ${line}`);
}

/**
 * Exports each commit once, into a folder of its own under `root`, with git's own archive of it. An `owner`
 * gets an export of its own, for a side whose prepare commands write into it.
 */
function commitExporter(root) {
  const exported = new Map();
  return (commit, owner = null) => {
    const key = owner === null ? commit : `${commit}-${owner}`;
    if (!exported.has(key)) {
      const dir = join(root, key);
      const archive = `${dir}.tar`;
      mkdirSync(dir);
      runGit(['archive', '--format=tar', `--output=${archive}`, commit]);
      runCommand('tar', ['-x', '-f', archive, '-C', dir]);
      rmSync(archive);
      exported.set(key, dir);
    }
    return exported.get(key);
  };
}

/** The export a side builds from: its commit's shared one, or one of its own when it prepares first. */
function exportFor(image, sideName, exportOf) {
  const side = image[sideName];
  return exportOf(side.commit, side.prepare.length > 0 ? `${image.name}-${sideName}` : null);
}

/** Runs a side's prepare commands in its context, in order, and stops at the first that fails. */
function prepare(image, sideName, exportOf) {
  const side = image[sideName];
  const dir = exportFor(image, sideName, exportOf);
  const context = side.context === '' ? dir : join(dir, side.context);
  for (const [command, ...args] of side.prepare) {
    process.stderr.write(`${image.name}: preparing ${sideName}: ${[command, ...args].join(' ')}\n`);
    runCommand(command, args, { cwd: context });
  }
}

function build(image, sideName, exportOf) {
  const side = image[sideName];
  const dir = exportFor(image, sideName, exportOf);
  process.stderr.write(`${image.name}: building ${sideName} from ${side.commit.slice(0, SHORT_COMMIT_LENGTH)}\n`);
  const context = side.context === '' ? dir : join(dir, side.context);
  runCommand('docker', ['build', '--no-cache', '--file', join(dir, side.dockerfile), '--tag', tagOf(image.name, sideName), context]);
}

function unchecked(image, reason, detail) {
  return { outcome: 'unchecked', lines: [`${image.name}: could not be checked: ${reason}`, ...indented(detail)] };
}

/** Builds both sides of one image, compares them with image.mjs, and says how that went. */
function checkImage(image, exportOf) {
  for (const sideName of SIDES) {
    try {
      prepare(image, sideName, exportOf);
    } catch (error) {
      if (!(error instanceof CheckError)) throw error;
      return unchecked(image, `the ${sideName} prepare failed.`, error.message);
    }
  }
  for (const sideName of SIDES) {
    try {
      build(image, sideName, exportOf);
    } catch (error) {
      if (!(error instanceof CheckError)) throw error;
      return unchecked(image, `the ${sideName} build failed.`, error.message);
    }
  }
  const renames = image.map.flatMap((rename) => ['--map', rename]);
  const allows = image.allow.flatMap((path) => ['--allow', path]);
  const compared = spawnSync(
    process.execPath,
    [IMAGE_CHECK, '--before', tagOf(image.name, 'before'), '--after', tagOf(image.name, 'after'), ...renames, ...allows],
    { encoding: 'utf8', maxBuffer: MAX_COMMAND_OUTPUT_BYTES },
  );
  const lines = compared.stdout.trimEnd().split('\n');
  if (compared.status === EXIT.MATCH) return { outcome: 'match', lines: [`${image.name}: ${lines.at(-1)}`] };
  if (compared.status === EXIT.DIFFERENCE) {
    return { outcome: 'differs', lines: [`${image.name}: ${lines.at(-1)}`, ...indented(lines.slice(0, -1).join('\n'))] };
  }
  return unchecked(image, 'image.mjs could not compare the two images.', `${compared.stderr}\n${compared.stdout}`);
}

function summarize(outcomes) {
  const count = (outcome) => outcomes.filter((result) => result.outcome === outcome).length;
  const differing = count('differs');
  const notChecked = count('unchecked');
  const parts = [`images: ${outcomes.length} compared`, `${count('match')} match`];
  if (differing > 0) parts.push(`${differing} ${differing === 1 ? 'differs' : 'differ'}`);
  if (notChecked > 0) parts.push(`${notChecked} could not be checked`);
  console.log(parts.join(', '));
  if (notChecked > 0) return EXIT.CANNOT_CHECK;
  return differing > 0 ? EXIT.DIFFERENCE : EXIT.MATCH;
}

/** Removes a compared pair and what building it left behind. A failure here says so and checks nothing less. */
function removeImages(image) {
  const commands = [
    ['image', 'rm', '--force', tagOf(image.name, 'before'), tagOf(image.name, 'after')],
    ['builder', 'prune', '--force'],
  ];
  for (const args of commands) {
    try {
      runCommand('docker', args);
    } catch (error) {
      if (!(error instanceof CheckError)) throw error;
      process.stderr.write(`${image.name}: could not clean up after the comparison. ${error.message}\n`);
    }
  }
}

function checkImages(images, { keep, removeImagesAfter }) {
  const root = mkdtempSync(join(tmpdir(), 'move-check-images-'));
  const exportOf = commitExporter(root);
  const outcomes = [];
  try {
    for (const image of images) {
      const outcome = checkImage(image, exportOf);
      outcomes.push(outcome);
      // Written at once and synchronously: on some platforms a pipe write from console.log waits for the event
      // loop, which the next pair's synchronous build holds, so a run cut off there would lose this verdict.
      writeSync(STDOUT_FD, `${outcome.lines.join('\n')}\n`);
      if (removeImagesAfter) removeImages(image);
    }
  } finally {
    if (keep) console.log(`kept the exports in ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
  return summarize(outcomes);
}

/** Runs the images check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const images = selectImages(readManifest(requireOption(options, 'manifest')), options.only ?? []);
  const resolved = images.map((image) => ({
    ...image,
    before: resolveSide(`${image.name} before`, image.before),
    after: resolveSide(`${image.name} after`, image.after),
  }));
  if (options.plan) return printPlan(resolved);
  return checkImages(resolved, { keep: options.keep === true, removeImagesAfter: options['remove-images'] === true });
}

await runWhenStarted(import.meta.url, USAGE, main);
