#!/usr/bin/env node
// Publishes the images of the apps a server runs from a release tag: each image whose build inputs changed since an
// earlier tag is built and uploaded, and each one whose inputs did not is only given the new tag, which uploads nothing.
// README.md says how a release reaches the registry.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { git } from './lib/git.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IN_COPY = fileURLToPath(new URL('../app-workspace/in-copy.mjs', import.meta.url));
const DEFAULT_REGISTRY = 'ghcr.io/solar-punk-ltd';

/** A tag the registry takes as it is: letters, digits, `_`, `.` and `-`, at most 128, not starting with `.` or `-`. */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** The stack a manager build deploys first, which the manager reads from a file beside its own tree. */
const STACK_APP = 'apps/hls-stream';

/** The label that carries the stack commit, for the deploy to write where the manager reads it. */
export const STACK_COMMIT_LABEL = 'org.solarpunk.stack-commit';

/** The tag every image also carries for its build inputs, which is how a later release finds it unchanged. */
const INPUTS_TAG_PREFIX = 'inputs-';

/**
 * @typedef {object} PublishedImage
 * @property {string} name The image's name in the registry.
 * @property {string} app The app folder its build context is cut from.
 * @property {string} dockerfile The Dockerfile, from the app folder.
 * @property {string | null} buildArgPrefix The prefix of its `<prefix>_VERSION` and `<prefix>_COMMIT` build arguments.
 * @property {boolean} pinsStack Whether the image carries the stack commit, which then counts among its inputs.
 */

/** @type {readonly PublishedImage[]} */
export const IMAGES = Object.freeze([
  { name: 'streaming-manager-api', app: 'apps/infra-manager', dockerfile: 'manager/Dockerfile', buildArgPrefix: 'MANAGER', pinsStack: true },
  { name: 'streaming-manager-web', app: 'apps/infra-manager', dockerfile: 'frontend/Dockerfile', buildArgPrefix: null, pinsStack: false },
  { name: 'streaming-admin-api', app: 'apps/web2-admin', dockerfile: 'backend/Dockerfile', buildArgPrefix: 'WEB2_ADMIN', pinsStack: false },
  { name: 'streaming-admin-web', app: 'apps/web2-admin', dockerfile: 'frontend/Dockerfile', buildArgPrefix: 'WEB2_ADMIN', pinsStack: false },
]);

const USAGE = 'Usage: node tools/release/publish.mjs --tag <tag> [--registry <registry>] [--root <checkout>] [--dry-run]';

class Refusal extends Error {}

/** Runs a command, its output passed through, and answers its exit status. */
function run(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw new Refusal(`could not start ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

function mustRun(command, args, options) {
  const status = run(command, args, options);
  if (status !== 0) throw new Refusal(`${command} ${args.slice(0, 3).join(' ')} failed with status ${status}`);
}

/** Every file below a folder, as paths from it, in one order whatever the file system lists first. */
function filesUnder(folder, prefix = '') {
  return readdirSync(path.join(folder, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? filesUnder(folder, relative) : [relative];
  }).sort();
}

/** One hash over every path and file in a folder, which is an image's whole build context. */
export function hashFolder(folder) {
  const hash = createHash('sha256');
  for (const file of filesUnder(folder)) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(path.join(folder, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The hash of an app's build context as a deploy cuts it, through in-copy.mjs, so it holds what the build reads. */
function hashBuildContext(root, app) {
  const result = spawnSync(
    process.execPath,
    [IN_COPY, '--root', root, '--app', app, '--', process.execPath, fileURLToPath(import.meta.url), '--hash-folder', '.'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const hash = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{64}$/.test(hash)) throw new Refusal(`could not hash the build context of ${app}`);
  return hash;
}

/** What an image is built from: its context, its Dockerfile's name, and for a manager the stack it deploys first. */
export function inputsOf(image, contextHash, stackCommit) {
  const hash = createHash('sha256');
  hash.update(`${image.dockerfile}\0${contextHash}\0`);
  if (image.pinsStack) hash.update(stackCommit);
  return hash.digest('hex').slice(0, 32);
}

function imageExists(reference) {
  return spawnSync('docker', ['buildx', 'imagetools', 'inspect', reference], { stdio: 'ignore' }).status === 0;
}

/**
 * Publishes one image under the tag: a new tag on the image already built from the same inputs, or a build and an
 * upload when no image has those inputs yet. Answers what it did.
 */
function publishImage({ root, registry, tag, commit, stackCommit, image, dryRun }) {
  const inputs = inputsOf(image, hashBuildContext(root, image.app), stackCommit);
  const repository = `${registry}/${image.name}`;
  const byInputs = `${repository}:${INPUTS_TAG_PREFIX}${inputs}`;
  const byTag = `${repository}:${tag}`;
  if (imageExists(byInputs)) {
    if (!dryRun) mustRun('docker', ['buildx', 'imagetools', 'create', '--tag', byTag, byInputs]);
    return `${image.name}: unchanged, ${tag} added to the image of ${INPUTS_TAG_PREFIX}${inputs}`;
  }
  if (dryRun) return `${image.name}: changed, would be built and uploaded as ${tag}`;
  const buildArgs = image.buildArgPrefix
    ? ['--build-arg', `${image.buildArgPrefix}_VERSION=${tag}`, '--build-arg', `${image.buildArgPrefix}_COMMIT=${commit}`]
    : [];
  const labels = image.pinsStack ? ['--label', `${STACK_COMMIT_LABEL}=${stackCommit}`] : [];
  mustRun(process.execPath, [
    IN_COPY, '--root', root, '--app', image.app, '--',
    'docker', 'build', '--file', image.dockerfile, '--tag', byTag, '--tag', byInputs, ...buildArgs, ...labels, '.',
  ]);
  mustRun('docker', ['push', byTag]);
  mustRun('docker', ['push', byInputs]);
  return `${image.name}: changed, built and uploaded as ${tag}`;
}

function parse(argv) {
  const options = { registry: DEFAULT_REGISTRY, root: DEFAULT_ROOT, dryRun: false, tag: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Refusal(USAGE);
      return argv[index];
    };
    if (argv[index] === '--tag') options.tag = value();
    else if (argv[index] === '--registry') options.registry = value();
    else if (argv[index] === '--root') options.root = path.resolve(value());
    else if (argv[index] === '--dry-run') options.dryRun = true;
    else throw new Refusal(USAGE);
  }
  if (!options.tag) throw new Refusal(USAGE);
  if (!IMAGE_TAG.test(options.tag)) {
    throw new Refusal(`${options.tag} cannot be an image tag, which takes letters, digits, _ . and - only`);
  }
  return options;
}

export function main(argv) {
  if (argv[0] === '--hash-folder') {
    process.stdout.write(`${hashFolder(path.resolve(argv[1] ?? '.'))}\n`);
    return 0;
  }
  const options = parse(argv);
  const commit = git(options.root, ['rev-parse', '--verify', '--quiet', `refs/tags/${options.tag}^{commit}`], { allowFailure: true });
  if (!commit) throw new Refusal(`there is no tag ${options.tag} in ${options.root}`);
  const head = git(options.root, ['rev-parse', 'HEAD']);
  if (head !== commit) throw new Refusal(`the checkout is at ${head}, not at ${options.tag}, which is ${commit}`);
  const stackCommit = git(options.root, ['rev-list', '-1', commit, '--', STACK_APP]) || commit;
  for (const image of IMAGES) {
    process.stdout.write(`publish.mjs: ${publishImage({ ...options, commit, stackCommit, image })}\n`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`publish.mjs: ${error.message}\n`);
    process.exitCode = 1;
  }
}
