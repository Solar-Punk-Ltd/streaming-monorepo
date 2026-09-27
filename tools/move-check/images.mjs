import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CheckError,
  EXIT,
  MAX_COMMAND_OUTPUT_BYTES,
  UsageError,
  countOf,
  describeCommandFailure,
  parseOptions,
  parsePrefixMaps,
  requireOption,
  runCommand,
  runGit,
  runWhenStarted,
  showHelp,
} from './lib/shared.mjs';
import { MATCH_APART_FROM_PNPM } from './lib/pnpm-files.mjs';

const USAGE = `Usage: node tools/move-check/images.mjs --manifest <path> --base <commit> --head <commit> [--only <name>]... [--plan] [--keep] [--remove-images]

Builds every image a manifest names twice, once from a base commit and once
from a head commit, such as a pull request's base and the pull request merged
into it, and compares the two with image.mjs. Each side is built from a fresh
export of its own commit, never from the working tree, and without the build
cache, so both are real builds. What each build prints goes to stderr as it
comes, so a build that stalls shows where it stopped.

The manifest is JSON at a path from the repository root, read from each commit:

  { "images": [ { "name": "infra-manager-api",
                  "context": "apps/infra-manager",
                  "dockerfile": "apps/infra-manager/manager/Dockerfile",
                  "allow": ["/var/log/apk.log"],
                  "note": "why each allow is there" } ] }

A context and a Dockerfile are paths from the root of the repository, and a
context of . is the root itself. Each side is built as its own commit's
manifest says, so a change to how an image builds changes the manifest with
it, and the base still builds as it did. A base without the manifest is built
as the head's says. An image only one side's manifest names is reported and
not built.

What may differ is the head's manifest's to say. Each allow is handed to
image.mjs as --allow. An image may also carry "map", a list of renames each
written <old>=<new>, handed to image.mjs as --map, for a folder the head's
image keeps under another name. A note is for whoever reads the manifest.

An image may also carry "prepare", a list of commands, each a list of its
words, such as [["corepack", "pnpm", "install", "--frozen-lockfile"]]. They
run in the context, without a shell, before the build, for an image whose
Dockerfile copies what a deploy script builds first. A side that prepares
builds from an export of its own, so what it writes reaches no other image.

  --base   the commit to compare with, such as a pull request's base
  --head   the commit to check, such as the pull request merged into its base
  --plan   finds every commit, context and Dockerfile, prints the builds and builds nothing
  --only   checks one image of the head's manifest by name, and can be given more than once
  --keep   leaves the exports on disk and says where
  --remove-images
           removes both images of a pair, and the build cache, once the pair is
           compared, so a long run does not fill the disk. Without it the images
           stay, for a person to inspect

Exit codes: 0 every image matches, apart from pnpm's own files where image.mjs
says so, 1 an image differs, 2 an image could not be checked or a manifest or
an argument is wrong.`;

const OPTION_SPECS = {
  manifest: { type: 'string' },
  base: { type: 'string' },
  head: { type: 'string' },
  only: { type: 'string', multiple: true },
  plan: { type: 'boolean' },
  keep: { type: 'boolean' },
  'remove-images': { type: 'boolean' },
};

const IMAGE_CHECK = fileURLToPath(new URL('./image.mjs', import.meta.url));
const TAG_PREFIX = 'move-check-images';
const SIDES = ['base', 'head'];
const IMAGE_NAME = /^[a-z0-9][a-z0-9-]*$/;
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

/** How an image is built: its context, its Dockerfile and the commands that run before the build. */
function readBuild(entry) {
  const prepare = entry.prepare ?? [];
  if (!Array.isArray(prepare) || !prepare.every(isCommand)) {
    throw new CheckError(`${entry.name}: prepare is a list of commands, each a list of its words, got ${JSON.stringify(entry.prepare)}.`);
  }
  return {
    context: repositoryPath(entry.context, `${entry.name}: context`, { rootAllowed: true }),
    dockerfile: repositoryPath(entry.dockerfile, `${entry.name}: dockerfile`, { rootAllowed: false }),
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
    throw new CheckError(`Image ${index + 1} needs a name of lower case letters, digits and dashes, got ${JSON.stringify(entry?.name)}.`);
  }
  const allow = entry.allow ?? [];
  if (!Array.isArray(allow) || !allow.every((path) => typeof path === 'string' && path !== '')) {
    throw new CheckError(`${entry.name}: allow is a list of paths, got ${JSON.stringify(entry.allow)}.`);
  }
  return { name: entry.name, allow, map: readMap(entry), build: readBuild(entry) };
}

/** Reads and checks a whole manifest, so a mistake costs no build time. Every problem names the manifest, as `label`. */
export function parseManifest(text, label) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new CheckError(`${label} could not be read as JSON: ${error.message}`);
  }
  if (!Array.isArray(manifest?.images) || manifest.images.length === 0) {
    throw new CheckError(`${label} names no images. It needs an "images" list.`);
  }
  let images;
  try {
    images = manifest.images.map(readEntry);
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    throw new CheckError(`${label}: ${error.message}`);
  }
  const seen = new Set();
  for (const { name } of images) {
    if (seen.has(name)) throw new CheckError(`${label}: ${name} is named twice.`);
    seen.add(name);
  }
  return images;
}

function shortCommit(commit) {
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

function objectType(commit, path) {
  try {
    return runGit(['cat-file', '-t', `${commit}:${path}`]).trim();
  } catch (error) {
    if (error instanceof CheckError) return null;
    throw error;
  }
}

/** The full id of the commit a revision names. A revision that git could read as an option is refused. */
function resolveCommit(revision, flag) {
  if (revision.startsWith('-')) throw new UsageError(`${flag} takes a commit, got "${revision}".`);
  try {
    return runGit(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).trim();
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    throw new CheckError(`${flag} ${revision} is not a commit in this repository. Fetch it first.`);
  }
}

/** The manifest as a commit holds it, or null when the commit has no such file. */
function manifestAt(commit, path) {
  if (objectType(commit, path) !== 'blob') return null;
  return parseManifest(runGit(['show', `${commit}:${path}`]), `${path} at ${shortCommit(commit)}`);
}

/**
 * Pairs each image of the head's manifest with how the base builds it: the base manifest's entry of the same name,
 * or the head's own entry when the base has no manifest at all. What may differ is the head's to say.
 */
function pairImages(base, head, baseImages, headImages) {
  const baseBuildOf = (name) => (baseImages ?? headImages).find((image) => image.name === name)?.build;
  const paired = headImages.filter((image) => baseBuildOf(image.name) !== undefined);
  return {
    images: paired.map((image) => ({
      name: image.name,
      allow: image.allow,
      map: image.map,
      base: { commit: base, ...baseBuildOf(image.name) },
      head: { commit: head, ...image.build },
    })),
    onlyInHead: headImages.filter((image) => baseBuildOf(image.name) === undefined).map(({ name }) => name),
    onlyInBase: (baseImages ?? []).filter((image) => !headImages.some(({ name }) => name === image.name)).map(({ name }) => name),
  };
}

function selectImages(paired, names) {
  if (names.length === 0) return paired;
  const known = [...paired.images.map(({ name }) => name), ...paired.onlyInHead];
  for (const name of names) {
    if (!known.includes(name)) throw new UsageError(`--only ${name} names no image in the head's manifest.`);
  }
  return {
    images: paired.images.filter((image) => names.includes(image.name)),
    onlyInHead: paired.onlyInHead.filter((name) => names.includes(name)),
    onlyInBase: [],
  };
}

/** Refuses a side whose context or Dockerfile is not in its commit, before anything is built. */
function checkSide(label, side) {
  if (side.context !== '' && objectType(side.commit, side.context) !== 'tree') {
    throw new CheckError(`${label}: ${side.commit} has no ${side.context} folder.`);
  }
  if (objectType(side.commit, side.dockerfile) !== 'blob') throw new CheckError(`${label}: ${side.commit} has no ${side.dockerfile}.`);
}

function unpairedLines({ onlyInHead, onlyInBase }) {
  return [
    ...onlyInHead.map((name) => `${name}: only in the head's manifest, so there is nothing to compare it with`),
    ...onlyInBase.map((name) => `${name}: only in the base's manifest, so it is not built`),
  ];
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

/**
 * Runs a program without a shell and passes what it prints to stderr as it comes, so a build that stalls shows where
 * it stopped. What it printed is kept as well, for the verdict when it fails.
 */
function runStreamed(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const printed = { stdout: [], stderr: [] };
    for (const name of Object.keys(printed)) {
      child[name].on('data', (chunk) => {
        printed[name].push(chunk);
        process.stderr.write(chunk);
      });
    }
    child.once('error', (error) => reject(new CheckError(describeCommandFailure(command, args, error))));
    child.once('close', (status, signal) => {
      if (status === 0) return resolve();
      const textOf = (name) => Buffer.concat(printed[name]).toString('utf8');
      return reject(new CheckError(describeCommandFailure(command, args, { status, signal, stdout: textOf('stdout'), stderr: textOf('stderr') })));
    });
  });
}

/** Runs a side's prepare commands in its context, in order, and stops at the first that fails. */
async function prepare(image, sideName, exportOf) {
  const side = image[sideName];
  const dir = exportFor(image, sideName, exportOf);
  const context = side.context === '' ? dir : join(dir, side.context);
  for (const [command, ...args] of side.prepare) {
    process.stderr.write(`${image.name}: preparing ${sideName}: ${[command, ...args].join(' ')}\n`);
    await runStreamed(command, args, { cwd: context });
  }
}

async function build(image, sideName, exportOf) {
  const side = image[sideName];
  const dir = exportFor(image, sideName, exportOf);
  process.stderr.write(`${image.name}: building ${sideName} from ${shortCommit(side.commit)}\n`);
  const context = side.context === '' ? dir : join(dir, side.context);
  await runStreamed('docker', ['build', '--no-cache', '--file', join(dir, side.dockerfile), '--tag', tagOf(image.name, sideName), context]);
}

function unchecked(image, reason, detail) {
  return { outcome: 'unchecked', lines: [`${image.name}: could not be checked: ${reason}`, ...indented(detail)] };
}

/** Builds both sides of one image, compares them with image.mjs, and says how that went. */
async function checkImage(image, exportOf) {
  for (const sideName of SIDES) {
    try {
      await prepare(image, sideName, exportOf);
    } catch (error) {
      if (!(error instanceof CheckError)) throw error;
      return unchecked(image, `the ${sideName} prepare failed.`, error.message);
    }
  }
  for (const sideName of SIDES) {
    try {
      await build(image, sideName, exportOf);
    } catch (error) {
      if (!(error instanceof CheckError)) throw error;
      return unchecked(image, `the ${sideName} build failed.`, error.message);
    }
  }
  const renames = image.map.flatMap((rename) => ['--map', rename]);
  const allows = image.allow.flatMap((path) => ['--allow', path]);
  const compared = spawnSync(
    process.execPath,
    [IMAGE_CHECK, '--before', tagOf(image.name, 'base'), '--after', tagOf(image.name, 'head'), ...renames, ...allows],
    { encoding: 'utf8', maxBuffer: MAX_COMMAND_OUTPUT_BYTES },
  );
  const lines = compared.stdout.trimEnd().split('\n');
  const verdict = lines.at(-1);
  const reported = [`${image.name}: ${verdict}`, ...indented(lines.slice(0, -1).join('\n'))];
  if (compared.status === EXIT.MATCH) {
    return { outcome: verdict.startsWith(`image: ${MATCH_APART_FROM_PNPM}`) ? 'match-apart-from-pnpm' : 'match', lines: reported };
  }
  if (compared.status === EXIT.DIFFERENCE) return { outcome: 'differs', lines: reported };
  return unchecked(image, 'image.mjs could not compare the two images.', `${compared.stderr}\n${compared.stdout}`);
}

function summarize(outcomes, { onlyInHead, onlyInBase }) {
  const count = (outcome) => outcomes.filter((result) => result.outcome === outcome).length;
  const apartFromPnpm = count('match-apart-from-pnpm');
  const differing = count('differs');
  const notChecked = count('unchecked');
  const parts = [`images: ${outcomes.length} compared`, `${count('match')} match`];
  if (apartFromPnpm > 0) parts.push(`${apartFromPnpm} ${MATCH_APART_FROM_PNPM}`);
  if (differing > 0) parts.push(`${differing} ${differing === 1 ? 'differs' : 'differ'}`);
  if (notChecked > 0) parts.push(`${notChecked} could not be checked`);
  if (onlyInHead.length > 0) parts.push(`${onlyInHead.length} only in the head`);
  if (onlyInBase.length > 0) parts.push(`${onlyInBase.length} only in the base`);
  console.log(parts.join(', '));
  if (notChecked > 0) return EXIT.CANNOT_CHECK;
  return differing > 0 ? EXIT.DIFFERENCE : EXIT.MATCH;
}

/** Removes a compared pair and what building it left behind. A failure here says so and checks nothing less. */
function removeImages(image) {
  const commands = [
    ['image', 'rm', '--force', tagOf(image.name, 'base'), tagOf(image.name, 'head')],
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

async function checkImages(selected, { keep, removeImagesAfter }) {
  const root = mkdtempSync(join(tmpdir(), 'move-check-images-'));
  const exportOf = commitExporter(root);
  const outcomes = [];
  try {
    for (const image of selected.images) {
      const outcome = await checkImage(image, exportOf);
      outcomes.push(outcome);
      // Written at once and synchronously: on some platforms a pipe write from console.log waits for the event
      // loop, which the clean-up and the export of the next pair hold, so a run cut off there would lose this verdict.
      writeSync(STDOUT_FD, `${outcome.lines.join('\n')}\n`);
      if (removeImagesAfter) removeImages(image);
    }
  } finally {
    if (keep) console.log(`kept the exports in ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
  return summarize(outcomes, selected);
}

/** Runs the images check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const manifestPath = repositoryPath(requireOption(options, 'manifest'), '--manifest', { rootAllowed: false });
  const base = resolveCommit(requireOption(options, 'base'), '--base');
  const head = resolveCommit(requireOption(options, 'head'), '--head');
  const headImages = manifestAt(head, manifestPath);
  if (headImages === null) throw new CheckError(`--head: the head ${shortCommit(head)} has no ${manifestPath}.`);
  const baseImages = manifestAt(base, manifestPath);
  const selected = selectImages(pairImages(base, head, baseImages, headImages), options.only ?? []);
  for (const image of selected.images) {
    for (const sideName of SIDES) checkSide(`${image.name} ${sideName}`, image[sideName]);
  }
  const notes = [
    ...(baseImages === null ? [`images: the base ${shortCommit(base)} has no ${manifestPath}, so it is built as the head's manifest says`] : []),
    ...unpairedLines(selected),
  ];
  // Written synchronously, as each verdict is, so the notes come before them on a pipe.
  if (notes.length > 0) writeSync(STDOUT_FD, `${notes.join('\n')}\n`);
  if (options.plan) return printPlan(selected.images);
  return checkImages(selected, { keep: options.keep === true, removeImagesAfter: options['remove-images'] === true });
}

await runWhenStarted(import.meta.url, USAGE, main);
