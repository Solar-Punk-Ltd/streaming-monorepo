import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

/** What every check exits with. `CANNOT_CHECK` covers bad arguments and anything that stops the comparison. */
export const EXIT = Object.freeze({ MATCH: 0, DIFFERENCE: 1, CANNOT_CHECK: 2, HELP: 0 });

/** Git trees, lockfiles and image exports can be large, far past execFileSync's 1 MiB default. */
const MAX_COMMAND_OUTPUT_BYTES = 1024 ** 3;
const MAX_QUOTED_OUTPUT_CHARS = 4000;

const PLAIN_JSON_KEY = /^[A-Za-z_$][\w$-]*$/;

/** A problem with the arguments. The check prints the message and its usage, then exits 2. */
export class UsageError extends Error {}

/** A problem that stops the check before it can compare, such as a revision that does not exist. Exits 2. */
export class CheckError extends Error {}

/**
 * Parses command-line arguments strictly: an unknown option or a stray positional is a UsageError.
 * Every check also accepts `--help` and `-h`.
 */
export function parseOptions(argv, optionSpecs) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { ...optionSpecs, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    });
    return values;
  } catch (error) {
    if (String(error.code).startsWith('ERR_PARSE_ARGS')) throw new UsageError(error.message);
    throw error;
  }
}

/** Returns the value of a required option, or throws a UsageError naming it. */
export function requireOption(options, name) {
  if (options[name] === undefined) throw new UsageError(`--${name} is required.`);
  return options[name];
}

/** Splits `left=right` at the first equals sign. `form` is how the usage error spells the expected shape. */
export function splitPair(value, flag, form = '<old>=<new>') {
  const separator = value.indexOf('=');
  if (separator === -1) throw new UsageError(`${flag} takes ${form}, got "${value}".`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function normalizePrefix(prefix) {
  const trimmed = prefix.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

/**
 * Parses `--map <old>=<new>` values into rename rules, longest old prefix first.
 * A rule renames the path it names and everything under it. An empty old prefix is the root.
 */
export function parsePrefixMaps(values = [], flag = '--map') {
  const rules = values.map((value) => {
    const [from, to] = splitPair(value, flag);
    return { from: normalizePrefix(from), to: normalizePrefix(to) };
  });
  const seen = new Set();
  for (const { from } of rules) {
    if (seen.has(from)) throw new UsageError(`${flag} names "${from || '.'}" more than once.`);
    seen.add(from);
  }
  return rules.toSorted((left, right) => right.from.length - left.from.length);
}

function isUnderPrefix(path, prefix) {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

/** Renames a path with the longest rule whose old prefix is the path or one of its parent directories. */
export function applyPrefixMaps(path, rules) {
  const rule = rules.find((candidate) => isUnderPrefix(path, candidate.from));
  if (!rule) return path;
  const rest = rule.from === '' ? path : path.slice(rule.from.length + 1);
  return [rule.to, rest].filter((part) => part !== '').join('/');
}

/** True when an allow entry names the path exactly, or is a prefix ending in `/` that the path sits under. */
export function isAllowedPath(path, allows) {
  return allows.some((allow) => (allow.endsWith('/') ? path.startsWith(allow) : path === allow));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lists every place two parsed JSON values differ, as `{ path, before, after }`.
 * Objects are compared key by key and arrays position by position. `undefined` marks a side that lacks the key.
 */
export function diffJson(before, after, path = []) {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => diffJson(before[key], after[key], [...path, key]));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, index) => diffJson(before[index], after[index], [...path, index])).flat();
  }
  return isDeepStrictEqual(before, after) ? [] : [{ path, before, after }];
}

/** Writes a JSON path the way a reader would type it: `services.api.volumes[0].source`. */
export function formatJsonPath(segments) {
  if (segments.length === 0) return '(the whole document)';
  return segments
    .map((segment, index) => {
      if (typeof segment === 'number') return `[${segment}]`;
      if (PLAIN_JSON_KEY.test(segment)) return index === 0 ? segment : `.${segment}`;
      return `[${JSON.stringify(segment)}]`;
    })
    .join('');
}

/** Prints one side of a difference, with a word for a side that lacks the value. */
export function formatJsonValue(value) {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

/** `1 entry`, `2 entries`. */
export function countOf(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function lastChars(text, limit) {
  return text.length > limit ? `...${text.slice(-limit)}` : text;
}

function describeCommandFailure(command, args, error) {
  if (error.code === 'ENOENT') return `${command} was not found. Install it or put it on PATH.`;
  const ending = error.status === null ? `signal ${error.signal}` : `exit ${error.status}`;
  const streams = [
    ['stderr', error.stderr],
    ['stdout', error.stdout],
  ]
    .map(([name, output]) => [name, String(output ?? '').trim()])
    .filter(([, text]) => text !== '')
    .map(([name, text]) => `${name}: ${lastChars(text, MAX_QUOTED_OUTPUT_CHARS)}`);
  return [`${command} ${args.join(' ')} failed (${ending})`, ...streams].join('\n');
}

/**
 * Runs a program without a shell and returns its standard output, as text or, with `encoding: 'buffer'`, as bytes.
 * A missing program or a non-zero exit becomes a CheckError that quotes both streams.
 */
export function runCommand(command, args, { cwd, env, encoding = 'utf8' } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      env,
      encoding,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new CheckError(describeCommandFailure(command, args, error));
  }
}

/** Runs git in the repository around the current directory. */
export function runGit(args, options = {}) {
  return runCommand('git', args, options);
}

/**
 * Runs a check's `main` and turns what it throws into exit code 2, so exit 1 always means "the sides differ".
 */
export async function runCli(usage, main, argv = process.argv.slice(2)) {
  try {
    return await main(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${usage.trimEnd()}\n`);
    } else if (error instanceof CheckError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error?.stack ?? error}\n`);
    }
    return EXIT.CANNOT_CHECK;
  }
}

/** Prints a check's usage for `--help`. */
export function showHelp(usage) {
  process.stdout.write(`${usage.trimEnd()}\n`);
  return EXIT.HELP;
}

function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(realpathSync(entry)).href === moduleUrl;
}

/** Runs `main` when the module is the script node was started with, and does nothing when it is imported. */
export async function runWhenStarted(moduleUrl, usage, main) {
  if (isMainModule(moduleUrl)) process.exitCode = await runCli(usage, main);
}
