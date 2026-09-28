#!/usr/bin/env node
/**
 * Fails when a file git tracks carries something that points at one real deployment: an IPv4
 * address outside the documentation and private ranges, an Ethereum address that is not a known
 * fake or a public contract, or a token on the hashed deny list. README.md beside this file says
 * what each rule allows and how to add to either list.
 *
 *   node scripts/public-leaks/gate.mjs [--root <dir>]
 *
 * Exits 0 with nothing found, 1 with findings, 2 when it could not run.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRules, scanText } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The lockfile names only registry packages and their integrity hashes. */
const SKIPPED_FILES = new Set(['pnpm-lock.yaml']);
const BINARY_EXTENSION = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|mp4|ts-segment|wasm)$/i;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function trackedFiles(root) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return output.split('\0').filter(Boolean);
}

function main() {
  const root =
    argument('--root') ??
    execFileSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const rules = parseRules({
    allowJson: readFileSync(join(HERE, 'allow.json'), 'utf8'),
    denyText: readFileSync(join(HERE, 'deny.sha256'), 'utf8'),
  });
  const own = new Set(['allow.json', 'deny.sha256'].map((name) => relative(root, join(HERE, name))));
  const cache = new Map();
  let count = 0;
  let files = 0;
  for (const path of trackedFiles(root)) {
    if (SKIPPED_FILES.has(path) || own.has(path) || BINARY_EXTENSION.test(path)) continue;
    let text;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    files += 1;
    for (const finding of scanText(text, rules, cache)) {
      count += 1;
      const shown =
        finding.rule === 'denied-token' ? `a denied token of ${finding.value.length} characters` : finding.value;
      console.log(`${path}:${finding.line}: ${finding.rule}: ${shown}`);
    }
  }
  if (count > 0) {
    console.log(`\n${count} finding(s) in ${files} files. See scripts/public-leaks/README.md.`);
    process.exit(1);
  }
  console.log(`public leak gate: nothing found in ${files} files.`);
}

try {
  main();
} catch (error) {
  console.error(`public leak gate could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
