import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { Refusal } from './refusal.mjs';

/** A problem with the arguments. The script prints the message and its usage. */
export class UsageError extends Error {}

/** Parses options strictly: an unknown option or a stray positional is a UsageError. `--help` and `-h` always work. */
export function parseOptions(argv, optionSpecs) {
  try {
    return parseArgs({
      args: argv,
      options: { ...optionSpecs, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    if (String(error.code).startsWith('ERR_PARSE_ARGS')) throw new UsageError(error.message);
    throw error;
  }
}

export function requireOption(options, name) {
  if (options[name] === undefined) throw new UsageError(`--${name} is required.`);
  return options[name];
}

/** `1 project`, `2 projects`. */
export function countOf(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Runs `main` when the module is the script node started, and turns a refusal or a usage error into its exit code.
 * @param {{ refused: number, usage: number }} codes  what each exits with
 */
export async function runWhenStarted(moduleUrl, usage, main, codes) {
  const entry = process.argv[1];
  if (!entry || pathToFileURL(realpathSync(entry)).href !== moduleUrl) return;
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${usage.trimEnd()}\n`);
      process.exitCode = codes.usage;
    } else if (error instanceof Refusal) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = codes.refused;
    } else {
      throw error;
    }
  }
}
