import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { Refusal } from './refusal.mjs';

/** An env file's name: .env itself, or .env, a dot and anything after it, such as .env.local. */
export const ENV_FILE_NAME = /^\.env(\..+)?$/;

/** The first env file at or under `path`, found by its name, with links looked at and never followed, or null. */
export function envFileAt(path) {
  if (ENV_FILE_NAME.test(basename(path))) return path;
  if (!lstatSync(path).isDirectory()) return null;
  for (const name of readdirSync(path).sort()) {
    const found = envFileAt(join(path, name));
    if (found !== null) return found;
  }
  return null;
}

/** Every file git sees under `folder`, tracked or new and not ignored, as paths from the root. Throws when git cannot. */
export function gitFilesUnder(root, folder) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', folder], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return [...new Set(output.split('\0').filter((path) => path !== ''))];
}

/**
 * Copies each listed file, a path from the root under `folder`, into `into`, named from `folder`. Links stay links. A
 * file deleted but not yet committed stays out.
 */
export function copyFiles(root, folder, paths, into) {
  for (const path of paths) {
    const source = join(root, path);
    const target = join(into, path.slice(folder.length + 1));
    let entry;
    try {
      entry = lstatSync(source);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (entry.isDirectory())
      throw new Refusal(
        `${path} is a folder git records as one entry, such as a submodule, which tools/app-workspace does not copy.`,
      );
    mkdirSync(dirname(target), { recursive: true });
    if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else {
      copyFileSync(source, target);
      chmodSync(target, entry.mode);
    }
  }
}
