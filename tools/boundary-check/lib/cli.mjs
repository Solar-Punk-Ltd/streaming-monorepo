import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** What the check exits with. `CANNOT_CHECK` covers bad arguments and anything that stops the check being made. */
export const EXIT = Object.freeze({ KEPT: 0, BROKEN: 1, CANNOT_CHECK: 2, HELP: 0 });

/** A problem with the arguments. The check prints the message and its usage, then exits 2. */
export class UsageError extends Error {}

/** A problem that stops the check before it can judge anything, such as a graph file that cannot be read. Exits 2. */
export class CheckError extends Error {}

/**
 * Parses command-line arguments strictly: an unknown option or a stray positional is a UsageError.
 * The check also accepts `--help` and `-h`.
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

/** `1 project`, `2 projects`. */
export function countOf(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Runs the check's `main` and turns what it throws into exit code 2, so exit 1 always means "a boundary is broken". */
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

/** Prints the usage for `--help`. */
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
