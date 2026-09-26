import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  CheckError,
  EXIT,
  UsageError,
  applyPrefixMaps,
  countOf,
  diffJson,
  formatJsonPath,
  formatJsonValue,
  isPlainObject,
  parseOptions,
  parsePrefixMaps,
  requireOption,
  runCommand,
  runWhenStarted,
  showHelp,
  splitPair,
} from './lib/shared.mjs';

const USAGE = `Usage: node tools/move-check/compose.mjs --before <dir> --after <dir> --file <path>
         [--before-file <path>] [--after-file <path>] [--project <name>]
         [--env KEY=VALUE]... [--map <old-prefix>=<new-prefix>]...

Renders one compose file in each of two checkouts with
docker compose config --format json and compares the results. Make the
checkouts with git worktree add, one per commit.

  --file          the compose file, relative to each checkout
  --before-file   overrides --file on the before side, for a file that moved
  --after-file    overrides --file on the after side
  --project       runs both sides under this project name. Without it compose
                  takes the name from the file's name: key or its directory,
                  and a difference there shows.
  --env           adds a variable to the environment of both renders. A .env
                  file next to the compose file is not read, so pass here what
                  the file needs.
  --map           renames a path on the before side, see below

Before comparing, every path that sits under a checkout, such as a build
context, a Dockerfile or a bind-mount source, is rewritten relative to that
checkout, and on the before side the --map renames apply to those paths.

Exit codes: 0 match, 1 difference, 2 the check could not run.`;

const OPTION_SPECS = {
  before: { type: 'string' },
  after: { type: 'string' },
  file: { type: 'string' },
  'before-file': { type: 'string' },
  'after-file': { type: 'string' },
  project: { type: 'string' },
  env: { type: 'string', multiple: true },
  map: { type: 'string', multiple: true },
};

/** An empty env file, so compose never reads a .env that sits next to the compose file. */
const NO_ENV_FILE = '/dev/null';

/** The arguments that render one compose file as JSON. */
export function composeArguments({ file, project }) {
  const projectArguments = project === undefined ? [] : ['-p', project];
  return ['compose', ...projectArguments, '--env-file', NO_ENV_FILE, '-f', file, 'config', '--format', 'json'];
}

/** Compose keeps a relative Dockerfile relative to the build context. Joining them lets the maps reach it. */
function withResolvedDockerfile(service) {
  const build = service?.build;
  if (!isPlainObject(build) || typeof build.context !== 'string' || typeof build.dockerfile !== 'string') return service;
  if (!isAbsolute(build.context) || isAbsolute(build.dockerfile)) return service;
  return { ...service, build: { ...build, dockerfile: join(build.context, build.dockerfile) } };
}

function resolveDockerfiles(config) {
  if (!isPlainObject(config?.services)) return config;
  const services = Object.fromEntries(Object.entries(config.services).map(([name, service]) => [name, withResolvedDockerfile(service)]));
  return { ...config, services };
}

function relativeToRoots(value, roots) {
  const root = roots.find((candidate) => value === candidate || value.startsWith(`${candidate}/`));
  return root === undefined ? undefined : value.slice(root.length + 1);
}

function mapStrings(value, rewrite) {
  if (typeof value === 'string') return rewrite(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, rewrite));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, rewrite)]));
  return value;
}

/**
 * Rewrites every string that is a path under one of the checkout's names relative to the checkout,
 * after joining each relative Dockerfile to its build context, and renames those paths with `rules`.
 * Returns a new config and leaves the one it was given alone.
 * @param {object} config parsed `docker compose config --format json` output
 * @param {string[]} roots the checkout as given and as its real path
 */
export function normalizeComposeConfig(config, roots, rules = []) {
  return mapStrings(resolveDockerfiles(config), (value) => {
    const relative = relativeToRoots(value, roots);
    if (relative === undefined) return value;
    return applyPrefixMaps(relative, rules) || '.';
  });
}

function checkoutNames(dir, flag) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    throw new CheckError(`${flag} ${dir} is not a directory.`);
  }
  if (!statSync(real).isDirectory()) throw new CheckError(`${flag} ${dir} is not a directory.`);
  return [...new Set([real, resolve(dir)])];
}

function renderCompose({ dir, file, flag }, project, env) {
  const roots = checkoutNames(dir, flag);
  const [real] = roots;
  let output;
  try {
    output = runCommand('docker', composeArguments({ file, project }), { cwd: real, env: { ...env, PWD: real } });
  } catch (error) {
    if (error instanceof CheckError) throw new CheckError(`Rendering ${file} in ${flag} ${dir} failed.\n${error.message}`);
    throw error;
  }
  try {
    return { roots, config: JSON.parse(output) };
  } catch {
    throw new CheckError(`docker compose config printed something that is not JSON for ${file} in ${flag} ${dir}.`);
  }
}

function parseEnvAssignments(values = []) {
  const assignments = values.map((value) => splitPair(value, '--env', '<KEY>=<VALUE>'));
  const empty = assignments.find(([key]) => key === '');
  if (empty) throw new UsageError(`--env needs a variable name before the equals sign, got "=${empty[1]}".`);
  return Object.fromEntries(assignments);
}

function composeFiles(options) {
  const beforeFile = options['before-file'] ?? options.file;
  const afterFile = options['after-file'] ?? options.file;
  if (beforeFile === undefined || afterFile === undefined) {
    throw new UsageError('Name the compose file with --file, or with both --before-file and --after-file.');
  }
  return { beforeFile, afterFile };
}

/** Runs the compose check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const beforeDir = requireOption(options, 'before');
  const afterDir = requireOption(options, 'after');
  const { beforeFile, afterFile } = composeFiles(options);
  const env = { ...process.env, ...parseEnvAssignments(options.env) };
  const rules = parsePrefixMaps(options.map);

  const before = renderCompose({ dir: beforeDir, file: beforeFile, flag: '--before' }, options.project, env);
  const after = renderCompose({ dir: afterDir, file: afterFile, flag: '--after' }, options.project, env);
  const differences = diffJson(normalizeComposeConfig(before.config, before.roots, rules), normalizeComposeConfig(after.config, after.roots));

  if (differences.length === 0) {
    const services = Object.keys(after.config?.services ?? {}).length;
    console.log(`compose: match, the same config for ${countOf(services, 'service')} on both sides`);
    return EXIT.MATCH;
  }
  const listed = differences.map(
    (difference) => `${formatJsonPath(difference.path)}: before ${formatJsonValue(difference.before)}, after ${formatJsonValue(difference.after)}`,
  );
  console.log([...listed, `compose: differs at ${countOf(differences.length, 'JSON path')}`].join('\n'));
  return EXIT.DIFFERENCE;
}

await runWhenStarted(import.meta.url, USAGE, main);
