#!/usr/bin/env node
// Tags the commit checked out for a release, by hand, before its deploys: shows the commit and the tags there are,
// asks for a name, then creates an annotated tag on the commit and pushes that tag alone. Every deploy names its build
// after the tag on its commit (version.mjs), so the name is the operator's to choose: no scheme is suggested or
// enforced beyond what a deploy can carry. README.md says what each step checks, docs/releasing.md when it runs.
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { git } from './lib/git.mjs';
import { isSafeTagName, tagNameProblem } from './lib/tagName.mjs';
import { SHARED_PATHS, SHORT_LENGTH, describeVersion } from './version.mjs';

export const EXIT = Object.freeze({ done: 0, refused: 1, usage: 2, cancelled: 3 });

export const DEFAULT_LIMIT = 20;

// What a deploy ships: the apps, what they build with besides their own folders, the scripts a deploy runs and what the
// hosts need. A tag must name exactly that, so a change git has not committed anywhere in it refuses the tag. Ignored
// files, the env files among them, never count, and neither does anything outside it, such as docs/.
export const SHIPPED_PATHS = Object.freeze(['apps', 'tools', 'infra', ...SHARED_PATHS]);

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// In the operator's own time zone, the same for the commit and every tag.
const DATE_FORMAT = 'format-local:%Y-%m-%d %H:%M';
// How many changed paths a refusal names before it counts the rest, and how wide the listing's name column grows.
const PATHS_SHOWN = 20;
const NAME_COLUMN = 32;

const USAGE =
  'Usage: node tools/release/tag.mjs [--name <tag>] [--message <text>] [--yes] [--no-push] [--remote <name>] ' +
  '[--all | --limit <n>] [--root <checkout>]';

const HELP = `${USAGE}

Tags the commit checked out for a release and pushes the tag. It shows the commit and the tags there are, asks for a
name and a message, and asks before it creates anything. docs/releasing.md says when to run it.

  --name <tag>       The tag's name. Required without a terminal on stdin.
  --message <text>   The tag's message. Default: the name.
  --yes              Create the tag without asking. Required without a terminal, to create one.
  --no-push          Create the tag on this machine only.
  --remote <name>    The remote whose tags a name is checked against, and that gets the tag. Default: origin.
  --all              List every tag, not only the latest ${DEFAULT_LIMIT}.
  --limit <n>        List the latest n tags.
  --root <checkout>  The checkout to tag. Default: the one this script is in.
  -h, --help         Show this help.

Exit status: 0 created or kept, 1 refused or failed, 2 usage error, 3 cancelled.
`;

// Ends a run with an exit status and what to say about it.
class Stop extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cancelled = () => new Stop(EXIT.cancelled, 'Nothing was tagged.');

function parse(argv) {
  const options = {
    name: null,
    message: null,
    yes: false,
    push: true,
    remote: 'origin',
    all: false,
    limit: null,
    root: DEFAULT_ROOT,
    help: false,
  };
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
    const plain = () => {
      if (equals !== -1) throw new Error(`${flag} takes no value`);
      return true;
    };
    if (flag === '--name') options.name = value();
    else if (flag === '--message') options.message = value();
    else if (flag === '--yes') options.yes = plain();
    else if (flag === '--no-push') options.push = !plain();
    else if (flag === '--remote') options.remote = value();
    else if (flag === '--all') options.all = plain();
    else if (flag === '--limit') options.limit = value();
    else if (flag === '--root') options.root = value();
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg} (a name is given as --name <tag>)`);
  }
  if (options.name === '') throw new Error('--name needs a value');
  if (options.remote === '' || options.remote.startsWith('-')) {
    throw new Error(`--remote needs the name of a remote (got: ${options.remote})`);
  }
  if (options.limit !== null) {
    if (options.all) throw new Error('--all and --limit do not go together');
    if (!/^[1-9][0-9]*$/.test(options.limit)) {
      throw new Error(`--limit must be a whole number above 0 (got: ${options.limit})`);
    }
    options.limit = Number(options.limit);
  }
  return options;
}

// Answers each question with the next line of the input. A line that came before its question waits for it, which is
// how a test drives the questions through a stream. The end of the input, or Ctrl-C at a question, answers null.
function lineReader(input, output) {
  let reader = null;
  let ended = false;
  let waiting = null;
  const early = [];
  // A terminal shows what was typed. An answer read from a stream is written out, so the dialogue reads the same.
  const echo = !input.isTTY;
  const answer = (line) => {
    if (waiting === null) return false;
    const resolve = waiting;
    waiting = null;
    resolve(line);
    return true;
  };
  const start = () => {
    reader = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
    reader.on('line', (line) => {
      if (!answer(line)) early.push(line);
    });
    reader.on('close', () => {
      ended = true;
      // Ctrl-D or Ctrl-C at a question leaves the cursor after it on a terminal.
      if (waiting !== null && !echo) output.write('\n');
      answer(null);
    });
    reader.on('SIGINT', () => reader.close());
  };
  return {
    async ask(question) {
      if (reader === null && !ended) start();
      let line;
      if (early.length > 0) {
        output.write(question);
        line = early.shift();
      } else if (ended) {
        output.write(question);
        line = null;
      } else {
        reader.setPrompt(question);
        reader.prompt();
        line = await new Promise((resolve) => {
          waiting = resolve;
        });
      }
      if (echo) output.write(`${line ?? ''}\n`);
      return line;
    },
    // The terminal goes back to its own line editing before git runs, so an ssh passphrase prompt works as usual.
    close() {
      ended = true;
      reader?.close();
    },
  };
}

export async function main(argv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const interactive = io.interactive ?? Boolean(stdin.isTTY);
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    stderr.write(`tag: ${error.message}\n${USAGE}\n`);
    return EXIT.usage;
  }
  if (options.help) {
    stdout.write(HELP);
    return EXIT.done;
  }
  if (!interactive && options.name === null) {
    stderr.write('tag: stdin is not a terminal, so there is nobody to ask: run it in a terminal or pass --name\n');
    return EXIT.usage;
  }
  const answers = interactive ? lineReader(stdin, stdout) : null;
  const ui = {
    interactive,
    say: (text = '') => stdout.write(`${text}\n`),
    warn: (text) => stderr.write(`tag: ${text}\n`),
    ask: (question) => answers.ask(question),
    doneAsking: () => answers?.close(),
  };
  try {
    return await tagCheckout(options, ui);
  } catch (error) {
    if (error instanceof Stop && error.status === EXIT.cancelled) ui.say(error.message);
    else ui.warn(error.message);
    return error instanceof Stop ? error.status : EXIT.refused;
  } finally {
    answers?.close();
  }
}

async function tagCheckout(options, ui) {
  const { top, commit } = findCommit(options.root);
  const short = commit.slice(0, SHORT_LENGTH);
  const remote = knownRemote(top, options.remote);

  ui.say(`Fetching the tags of ${remote}...`);
  const fetchFailure = fetchTags(top, remote);
  if (fetchFailure !== null) {
    ui.warn(
      `could not fetch the tags of ${remote}, so a name a teammate pushed there cannot be checked. Going on.\n` +
        indent(fetchFailure),
    );
  }
  ui.say();

  showCommit(ui, top, commit, short);
  refuseWhatDoesNotShip(top, remote, commit, short, fetchFailure !== null);

  const tags = readTags(top);
  showTags(ui, tags, commit, options.all ? tags.length : (options.limit ?? DEFAULT_LIMIT));

  // The tag a deploy of this commit shows, offered to keep when it is annotated, as a release tag is. A lightweight
  // one is often a mistyped `git tag list`, so it is named but not pushed unless its name is typed.
  const shown = describeVersion({ root: top }).tag;
  const kept = tags.find((tag) => tag.name === shown && tag.annotated) ?? null;
  ui.say();
  if (kept !== null) {
    ui.say(`This commit already has the tag ${kept.name}, which a deploy of it shows.`);
    ui.say(
      options.push
        ? `Enter keeps it, and pushes it to ${remote} if ${remote} lacks it. A new name adds another tag.`
        : 'Enter keeps it. A new name adds another tag.',
    );
  } else if (shown !== '') {
    ui.say(`This commit has the lightweight tag ${shown}, which a deploy of it shows until it has an annotated tag.`);
  } else {
    const passedOver = tags.filter((tag) => tag.target === commit).map((tag) => JSON.stringify(tag.name));
    ui.say(
      passedOver.length > 0
        ? `This commit has no tag a deploy can show: a deploy passes over ${passedOver.join(', ')}.`
        : 'This commit has no tag yet.',
    );
  }

  const choice = await chooseName(options, ui, { top, commit, tags, kept });
  if (choice.keep) {
    const { name } = choice.keep;
    ui.say(`Keeping ${name}, which this commit already has. Nothing was created.`);
    if (options.message !== null) ui.say('--message is not used: a tag that stays keeps its own message.');
    if (!options.push) {
      ui.say(`Nothing was pushed (--no-push). Where ${remote} lacks ${name}, this pushes it:`);
      ui.say(`  ${pushCommand(remote, name)}`);
      return EXIT.done;
    }
    ui.doneAsking();
    return pushTag(ui, top, remote, name);
  }

  const { name } = choice;
  const message = await chooseMessage(options, ui, name);
  await confirm(
    options,
    ui,
    options.push ? `Create ${name} on ${short} and push it to ${remote}? [y/N] ` : `Create ${name} on ${short}? [y/N] `,
  );
  ui.doneAsking();
  try {
    // Whitespace cleanup, not git's default strip, so a message that starts with # keeps that line.
    git(top, ['tag', '-a', '--cleanup=whitespace', '-m', message, name, commit]);
  } catch (error) {
    throw new Stop(EXIT.refused, `creating ${name} failed.\n${indent(gitSaid(error))}`);
  }
  ui.say(`Created ${name} on ${short}. A deploy of this commit names its build ${describeVersion({ root: top }).tag}.`);
  if (!options.push) {
    ui.say(`It is not pushed (--no-push). This pushes it:\n  ${pushCommand(remote, name)}`);
    return EXIT.done;
  }
  return pushTag(ui, top, remote, name);
}

function findCommit(root) {
  const top = git(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!top) throw new Stop(EXIT.refused, `${root} is not inside a git checkout.`);
  const commit = git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFailure: true });
  if (!commit) throw new Stop(EXIT.refused, `${top} has no commit checked out.`);
  return { top, commit };
}

function knownRemote(top, remote) {
  const remotes = git(top, ['remote']).split('\n').filter(Boolean);
  if (remotes.includes(remote)) return remote;
  const others = remotes.length > 0 ? ` Its remotes are ${remotes.join(', ')}, and --remote names one.` : '';
  throw new Stop(EXIT.refused, `this checkout has no remote named ${remote}.${others}`);
}

// Brings the remote's tags here, and its branches with them, so a name a teammate pushed is refused like one made here
// and the check that the commit is pushed reads the remote as it is. --no-prune-tags keeps a fetch.pruneTags setting
// from deleting a tag of this checkout that the remote lacks, or replacing one it holds on another commit. Answers
// what git said when the fetch failed, and null when it did not.
function fetchTags(top, remote) {
  try {
    git(top, ['fetch', '--tags', '--no-prune-tags', '--', remote]);
    return null;
  } catch (error) {
    return gitSaid(error);
  }
}

function showCommit(ui, top, commit, short) {
  const branch = git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }) || 'detached';
  const [subject, date] = git(top, [
    'log',
    '-1',
    '--no-show-signature',
    '--format=%s%x00%cd',
    `--date=${DATE_FORMAT}`,
    commit,
  ]).split('\0');
  ui.say('The commit to tag:');
  ui.say(`  branch  ${branch}`);
  ui.say(`  commit  ${short}  ${subject}`);
  ui.say(`  date    ${date}`);
}

// A tag names exactly what gets deployed: a commit of the remote's history, with nothing that ships changed beside it.
function refuseWhatDoesNotShip(top, remote, commit, short, fetchFailed) {
  const problems = [];
  const holders = git(top, ['for-each-ref', `--contains=${commit}`, '--format=%(refname)', `refs/remotes/${remote}`]);
  if (holders === '') {
    const fetchFirst = fetchFailed ? `, or git fetch ${remote} if it is pushed already` : '';
    problems.push(`no branch of ${remote} holds ${short}. Push it first${fetchFirst}, then tag it.`);
  }
  const changed = shippedChanges(top);
  if (changed.length > 0) {
    const listed = changed.slice(0, PATHS_SHOWN).map((file) => `  ${file}`);
    if (changed.length > PATHS_SHOWN) listed.push(`  and ${changed.length - PATHS_SHOWN} more`);
    problems.push(
      'what a deploy ships holds changes git has not committed, so a tag would not name what gets deployed. ' +
        `Commit them or set them aside first:\n${listed.join('\n')}`,
    );
  }
  if (problems.length > 0) throw new Stop(EXIT.refused, problems.join('\ntag: '));
}

// The paths under SHIPPED_PATHS that hold a change or a new file git does not ignore, names only. Porcelain v2 starts
// every entry with its kind, and -z leaves each path as it is, spaces and quotes included.
function shippedChanges(top) {
  const entries = git(top, ['status', '--porcelain=v2', '-z', '--untracked-files=normal', '--', ...SHIPPED_PATHS])
    .split('\0')
    .filter(Boolean);
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.startsWith('? ')) paths.push(entry.slice(2));
    else if (entry.startsWith('1 ')) paths.push(afterFields(entry, 8));
    else if (entry.startsWith('u ')) paths.push(afterFields(entry, 10));
    else if (entry.startsWith('2 ')) {
      paths.push(afterFields(entry, 9));
      i += 1; // the path it was renamed or copied from
    }
  }
  return paths;
}

// What follows the first count space-separated fields of a status entry: its path, which may hold spaces.
function afterFields(entry, count) {
  let at = 0;
  for (let field = 0; field < count; field += 1) at = entry.indexOf(' ', at) + 1;
  return entry.slice(at);
}

const TAG_FIELDS = [
  '%(refname:lstrip=2)',
  '%(objecttype)',
  '%(objectname)',
  '%(*objecttype)',
  '%(*objectname)',
  `%(creatordate:${DATE_FORMAT})`,
  '%(contents:lines=1)',
];

// Every tag, newest first: an annotated tag by the time it was made, a lightweight one by its commit's. The target is
// the commit a tag names, through an annotated tag to what it points at.
function readTags(top) {
  const out = git(top, ['for-each-ref', '--sort=-creatordate', `--format=${TAG_FIELDS.join('%00')}%00`, 'refs/tags']);
  if (out === '') return [];
  return out.split('\0\n').map((record) => {
    const [name, type, object, peeledType, peeled, date, firstLine] = record.split('\0');
    const annotated = type === 'tag';
    let target = annotated ? peeled : object;
    // A git that peels one level answers a tag for a tag of a tag, so the rest is peeled here.
    if (annotated && peeledType === 'tag') {
      target = git(top, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{}`], { allowFailure: true }) ?? peeled;
    }
    // A lightweight tag has no message: what git answers for it is its commit's.
    return { name, annotated, target, date, firstLine: annotated ? firstLine : '' };
  });
}

function showTags(ui, tags, commit, limit) {
  ui.say();
  if (tags.length === 0) {
    ui.say('There are no tags yet.');
    return;
  }
  const listed = tags.slice(0, limit);
  const width = Math.min(NAME_COLUMN, Math.max(...listed.map((tag) => tag.name.length)));
  ui.say('Tags, newest first:');
  for (const tag of listed) {
    const mark = tag.target === commit ? '*' : ' ';
    const kind = tag.annotated ? 'annotated  ' : 'lightweight';
    const message = tag.firstLine === tag.name ? '' : tag.firstLine;
    const note = isSafeTagName(tag.name) ? '' : '(a deploy passes over this name)';
    const rest = [tag.name.padEnd(width), message, note].filter((part) => part.trim() !== '').join('  ');
    ui.say(`  ${mark} ${tag.date.padEnd(16)}  ${tag.target.slice(0, SHORT_LENGTH)}  ${kind}  ${rest}`.trimEnd());
  }
  const more = tags.length - listed.length;
  if (more > 0) {
    ui.say(`  ${more} older ${more === 1 ? 'tag is' : 'tags are'} not shown: --all lists every tag.`);
  }
  if (listed.some((tag) => tag.target === commit)) ui.say('  * is on this commit.');
}

async function chooseName(options, ui, context) {
  if (options.name !== null) {
    const verdict = judgeName(options.name, context);
    if (verdict.refusal !== undefined) throw new Stop(EXIT.refused, verdict.refusal);
    return verdict;
  }
  const question =
    context.kept === null
      ? 'Name for the new tag (Enter cancels): '
      : `Name for a new tag (Enter keeps ${context.kept.name}): `;
  for (;;) {
    const line = await ui.ask(question);
    if (line === null) throw cancelled();
    const name = line.trim();
    if (name === '') {
      if (context.kept !== null) return { keep: context.kept };
      throw cancelled();
    }
    const verdict = judgeName(name, context);
    if (verdict.refusal === undefined) return verdict;
    ui.warn(verdict.refusal);
  }
}

// Answers { name } for a new tag, { keep } for the name of a tag already on this commit, or { refusal } with why the
// name cannot be used. The tags were fetched from the remote first, so a name taken there counts as taken here.
function judgeName(name, { top, commit, tags }) {
  const problem = tagNameProblem(name);
  if (problem !== null) return { refusal: `the name ${JSON.stringify(name)} ${problem}.` };
  // git tag refuses HEAD, which check-ref-format lets through.
  if (name === 'HEAD' || git(top, ['check-ref-format', `refs/tags/${name}`], { allowFailure: true }) === null) {
    return { refusal: `git does not take ${name} as the name of a tag.` };
  }
  const same = tags.find((tag) => tag.name === name);
  if (same !== undefined) {
    if (same.target === commit) return { keep: same };
    return { refusal: `${name} is taken: it names ${describeCommit(top, same.target)}.` };
  }
  // Two names that differ only in case are one file on the file system of a Mac or of Windows, where git then reads
  // one tag's commit for the other's. And git cannot hold a tag beside tags whose names go on under it, as release
  // and release/2026: git tag would refuse either only after the confirmation.
  const lower = name.toLowerCase();
  const twin = tags.find((tag) => tag.name.toLowerCase() === lower);
  if (twin !== undefined) {
    return {
      refusal: `${name} differs from the tag ${twin.name} only in case, which git on a Mac or on Windows mixes up.`,
    };
  }
  const nested = tags.find((tag) => {
    const other = tag.name.toLowerCase();
    return lower.startsWith(`${other}/`) || other.startsWith(`${lower}/`);
  });
  if (nested !== undefined) {
    const outer = nested.name.length < name.length ? nested.name : name;
    return {
      refusal: `${name} cannot sit beside the tag ${nested.name}: git cannot hold a tag ${outer} and tags under ${outer}/ at once.`,
    };
  }
  return { name };
}

function describeCommit(top, object) {
  const subject = git(top, ['log', '-1', '--no-show-signature', '--format=%s', object], { allowFailure: true });
  const short = object.slice(0, SHORT_LENGTH);
  return subject ? `${short} (${subject})` : short;
}

async function chooseMessage(options, ui, name) {
  if (options.message !== null) return options.message.trim() === '' ? name : options.message;
  if (!ui.interactive) return name;
  const line = await ui.ask('Message (Enter uses the name): ');
  if (line === null) throw cancelled();
  return line.trim() === '' ? name : line.trim();
}

async function confirm(options, ui, question) {
  if (options.yes) return;
  if (!ui.interactive) {
    throw new Stop(EXIT.usage, 'stdin is not a terminal, so there is nobody to confirm: pass --yes to create the tag');
  }
  const line = await ui.ask(question);
  if (line === null || !/^y(es)?$/i.test(line.trim())) throw cancelled();
}

// Pushes the one tag. --no-follow-tags keeps a push.followTags setting from sending other tags with it, and the
// porcelain output tells a tag the remote already had from a new one. The user's own ssh and git setup carries it.
function pushTag(ui, top, remote, name) {
  try {
    const out = git(top, ['push', '--porcelain', '--no-follow-tags', '--', remote, `refs/tags/${name}`]);
    const line = out.split('\n').find((entry) => entry.includes(`\trefs/tags/${name}:`));
    ui.say(line?.startsWith('=') ? `${remote} already has ${name}.` : `Pushed ${name} to ${remote}.`);
    return EXIT.done;
  } catch (error) {
    ui.warn(
      `pushing ${name} to ${remote} failed.\n${indent(gitSaid(error))}\n` +
        `${name} stays on this machine. This pushes it again:\n  ${pushCommand(remote, name)}`,
    );
    return EXIT.refused;
  }
}

function pushCommand(remote, name) {
  const word = /^[A-Za-z0-9._/-]+$/.test(remote) ? remote : `'${remote.replaceAll("'", "'\\''")}'`;
  return `git push ${word} refs/tags/${name}`;
}

// What a failed fetch or push said: the refs it refused and git's own errors, without the lines about what went well.
function gitSaid(error) {
  const cause = error.cause ?? {};
  const refused = String(cause.stdout ?? '')
    .split('\n')
    .filter((line) => line.startsWith('!'))
    .map((line) => line.split('\t').slice(1).join(' '));
  const said = String(cause.stderr ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && !line.startsWith('From ') && (!line.startsWith(' ') || line.startsWith(' ! ')));
  const lines = [...refused, ...said];
  return lines.length > 0 ? lines.join('\n') : error.message;
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `  ${line.trim()}`)
    .join('\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
