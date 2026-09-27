import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { DEFAULT_ROOT, cutApp, normalizeApp } from './cut.mjs';
import { UsageError, parseOptions, requireOption, runWhenStarted } from './lib/cli.mjs';
import { Refusal } from './lib/refusal.mjs';

const USAGE = `Usage: node tools/app-workspace/in-copy.mjs --app <folder> [--root <folder>] -- <command> [<argument>...]

Copies one app's folder, as git sees it on disk, into a new folder outside the checkout, cuts the app's
pnpm-lock.yaml and pnpm-workspace.yaml into the copy, runs the command there without a shell, and removes the copy
whatever the command does. Git's view is every file it tracks, with changes not yet committed, and every new file it
does not ignore. Ignored files, such as node_modules, dist and every .env, stay behind. Where the root holds no
lockfile, the apps keep their own, and the copy gets no cut.

It is how an image builds from a working checkout, for example from apps/infra-manager:
  node ../../tools/app-workspace/in-copy.mjs --app apps/infra-manager -- docker build --file manager/Dockerfile --tag manager-api .

Exits with the command's own status, or 125 when it cannot make the copy or start the command.`;

const OPTION_SPECS = {
  app: { type: 'string' },
  root: { type: 'string' },
};

/** What in-copy.mjs itself exits with, apart from every status the command can give. */
const OWN_FAILURE = 125;
const SIGNALLED = 128;

/** Every file git sees in the app folder, tracked or new and not ignored, as paths from the root. */
function listAppFiles(root, app) {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', app], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const said = String(error.stderr ?? error.message).trim();
    throw new Refusal(`in-copy.mjs copies the files git sees, and git cannot list them in ${root}: ${said}`);
  }
  return [...new Set(output.split('\0').filter((path) => path !== ''))];
}

/** Copies each listed file into `copy`, named from the app folder. A file deleted but not yet committed stays out. */
function copyAppFiles(root, app, paths, copy) {
  for (const path of paths) {
    const source = join(root, path);
    const target = join(copy, path.slice(app.length + 1));
    let entry;
    try {
      entry = lstatSync(source);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (entry.isDirectory()) throw new Refusal(`${path} is a folder git records as one entry, such as a submodule, which in-copy.mjs does not copy.`);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else {
      copyFileSync(source, target);
      chmodSync(target, entry.mode);
    }
  }
}

/** Signals that stop in-copy.mjs, from a terminal or a cancelled job. Each is passed on, and the copy goes after. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Runs the command without a shell and settles with its exit status, a signal counted as 128 plus its number the
 * way a shell counts it. While it runs, a stop signal reaches the command rather than ending in-copy.mjs, so the
 * copy is removed once the command has exited.
 */
function runCommand(command, cwd) {
  return new Promise((settle, fail) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: 'inherit' });
    const passOn = (signal) => child.kill(signal);
    for (const signal of STOP_SIGNALS) process.on(signal, passOn);
    const stopListening = () => {
      for (const signal of STOP_SIGNALS) process.off(signal, passOn);
    };
    child.on('error', (error) => {
      stopListening();
      fail(new Refusal(`${command[0]} could not start: ${error.message}`));
    });
    child.on('exit', (status, signal) => {
      stopListening();
      settle(status ?? SIGNALLED + (osConstants.signals[signal] ?? 0));
    });
  });
}

export async function main(argv) {
  const separator = argv.indexOf('--');
  const options = parseOptions(separator === -1 ? argv : argv.slice(0, separator), OPTION_SPECS);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  if (command.length === 0) throw new UsageError('Name the command to run after --.');
  const app = normalizeApp(requireOption(options, 'app'));
  const root = resolve(options.root ?? DEFAULT_ROOT);

  const paths = listAppFiles(root, app);
  const copy = mkdtempSync(join(tmpdir(), 'app-workspace-'));
  try {
    copyAppFiles(root, app, paths, copy);
    if (existsSync(join(root, 'pnpm-lock.yaml'))) process.stderr.write(`${cutApp({ root, app, out: copy })}\n`);
    process.stderr.write(`in-copy.mjs: running ${command.join(' ')} in a copy of ${app} at ${copy}\n`);
    return await runCommand(command, copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

await runWhenStarted(import.meta.url, USAGE, main, { refused: OWN_FAILURE, usage: OWN_FAILURE });
