#!/usr/bin/env node
// Names the build a deploy is about to send: the tag on the checked-out commit, or the nearest tag before it and how
// far past it, or the short commit, ended by -dirty when the app's own files hold uncommitted changes. README.md
// says what each printed value means.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { git } from './lib/git.mjs';
import { TAG_NAME_MAX_LENGTH, isSafeTagName } from './lib/tagName.mjs';

export const SHORT_LENGTH = 9;

// What a deploy builds besides the app's own folder: the workspace packages and the root files the install reads.
export const SHARED_PATHS = Object.freeze(['packages', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const USAGE = 'Usage: node tools/release/version.mjs [--app <folder>] [--format env|json] [--root <checkout>]';

export function describeVersion({ root = DEFAULT_ROOT, app = null } = {}) {
  const top = git(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!top) throw new Error(`${root} is not inside a git checkout`);
  const commit = git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFailure: true });
  if (!commit) throw new Error(`${top} has no commit checked out`);
  const appPath = app === null ? null : checkApp(top, app);
  const short = commit.slice(0, SHORT_LENGTH);
  const tag = tagAtHead(top);
  const base = tag || nearestLabel(top, short);
  const dirty = isDirty(top, appPath);
  return { commit, short, tag, label: dirty ? `${base}-dirty` : base, dirty };
}

export function formatEnv(version) {
  return `${[
    `VERSION_COMMIT=${version.commit}`,
    `VERSION_SHORT=${version.short}`,
    `VERSION_TAG=${version.tag}`,
    `VERSION_LABEL=${version.label}`,
    `VERSION_DIRTY=${version.dirty}`,
  ].join('\n')}\n`;
}

function checkApp(top, app) {
  const normalized = path.posix.normalize(app.replaceAll('\\', '/')).replace(/\/+$/, '');
  if (
    normalized === '' ||
    normalized === '.' ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`--app must be a folder inside the checkout, relative to its root (got: ${app})`);
  }
  if (!existsSync(path.join(top, normalized))) throw new Error(`--app names no folder in the checkout: ${normalized}`);
  return normalized;
}

// An annotated tag before a lightweight one, which is what a mistyped `git tag list` leaves, and the newest first
// among equals. A name a shell or a page would have to quote is passed over.
function tagAtHead(top) {
  const out = git(top, [
    'for-each-ref',
    '--points-at=HEAD',
    '--sort=-creatordate',
    '--format=%(objecttype) %(refname:lstrip=2)',
    'refs/tags',
  ]);
  const tags = out === '' ? [] : out.split('\n').map(parseTagLine);
  const safe = tags.filter((tag) => isSafeTagName(tag.name));
  return (safe.find((tag) => tag.annotated) ?? safe[0])?.name ?? '';
}

function parseTagLine(line) {
  const space = line.indexOf(' ');
  return { annotated: line.slice(0, space) === 'tag', name: line.slice(space + 1) };
}

// The tag names git describe leaves out, so the nearest tag it answers is the nearest one a label may name: a
// character outside the set, a first character that is no letter or digit, more than 80 characters. What git
// refuses in a ref name, such as "..", never names a tag in the first place. The manager reads a stack build's
// release by the same patterns.
const DESCRIBE_EXCLUDES = Object.freeze(
  ['*[!A-Za-z0-9._+/-]*', '[!A-Za-z0-9]*', `${'?'.repeat(TAG_NAME_MAX_LENGTH + 1)}*`].flatMap((pattern) => [
    '--exclude',
    pattern,
  ]),
);

function nearestLabel(top, short) {
  const nearest = git(top, ['describe', '--tags', '--abbrev=0', ...DESCRIBE_EXCLUDES, 'HEAD'], { allowFailure: true });
  if (!nearest || !isSafeTagName(nearest)) return short;
  const distance = git(top, ['rev-list', '--count', `refs/tags/${nearest}..HEAD`]);
  return `${nearest}+${distance}`;
}

// Ignored files, the env files among them, never count. Without an app, the whole checkout does.
function isDirty(top, appPath) {
  const pathspecs = appPath === null ? [] : [appPath, ...SHARED_PATHS];
  return git(top, ['status', '--porcelain', '--untracked-files=normal', '--', ...pathspecs]) !== '';
}

function parse(argv) {
  const options = { app: null, format: 'env', root: DEFAULT_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const value = () => {
      if (equals !== -1) return arg.slice(equals + 1);
      i += 1;
      if (argv[i] === undefined) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--app') options.app = value();
    else if (flag === '--format') options.format = value();
    else if (flag === '--root') options.root = value();
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.format !== 'env' && options.format !== 'json') {
    throw new Error(`--format must be env or json (got: ${options.format})`);
  }
  return options;
}

export function main(argv) {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    process.stderr.write(`version: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const version = describeVersion({ root: options.root, app: options.app });
    process.stdout.write(options.format === 'json' ? `${JSON.stringify(version)}\n` : formatEnv(version));
    return 0;
  } catch (error) {
    process.stderr.write(`version: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
