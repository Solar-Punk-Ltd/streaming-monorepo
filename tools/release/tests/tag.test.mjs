import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitEnv } from '../lib/git.mjs';
import { DEFAULT_LIMIT, EXIT, main } from '../tag.mjs';

// The user's own git configuration stays out of every git these tests start, theirs and the script's: a global
// tag.gpgSign, push.followTags or fetch.pruneTags would change what a scratch repository does. The tags the script
// makes carry this tagger, and every date prints in one time zone whatever the machine's.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
process.env.TZ = 'UTC';

const SCRIPT = fileURLToPath(new URL('../tag.mjs', import.meta.url));
const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// Every git call the fixtures make is a minute after the last, so the order of commits and tags is certain. It starts
// in September 2026, before any tag the script makes now.
let clock = 1_790_000_000;

function gitIn(cwd, args) {
  clock += 60;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...gitEnv(), GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
  }).trim();
}

function tagsIn(dir) {
  const out = gitIn(dir, [
    'for-each-ref',
    '--format=%(refname:lstrip=2) %(objecttype) %(objectname) %(*objectname)',
    'refs/tags',
  ]);
  const entries = out === '' ? [] : out.split('\n').map((line) => line.split(' '));
  return new Map(entries.map(([name, type, object, peeled]) => [name, { type, object, target: peeled || object }]));
}

// A checkout with a bare remote, its main pushed, holding a little of what a deploy ships and a little that it does not.
function scratchRepos() {
  const base = mkdtempSync(path.join(tmpdir(), 'release-tag-'));
  scratch.push(base);
  const remote = path.join(base, 'remote.git');
  const dir = path.join(base, 'work');
  gitIn(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  gitIn(base, ['init', '-q', '-b', 'main', dir]);
  const run = (...args) => gitIn(dir, args);
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  run('remote', 'add', 'origin', remote);
  write('.gitignore', '.env.*\n');
  write('apps/a/index.ts', 'export {};\n');
  write('packages/shared/index.ts', 'export {};\n');
  write('docs/guide.md', '# Guide\n');
  write('package.json', '{}\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'first');
  run('push', '-q', 'origin', 'main');
  let mates = 0;
  return {
    base,
    dir,
    run,
    write,
    head: () => run('rev-parse', 'HEAD'),
    commit(message) {
      write(`apps/a/${message.replaceAll(' ', '-')}.ts`, 'export {};\n');
      run('add', '-A');
      run('commit', '-q', '-m', message);
      return run('rev-parse', 'HEAD');
    },
    push: () => run('push', '-q', 'origin', 'main'),
    annotatedTag: (name, message = name, target = 'HEAD') => run('tag', '-a', '-m', message, name, target),
    lightweightTag: (name, target = 'HEAD') => run('tag', name, target),
    tags: () => tagsIn(dir),
    remoteTags: () => tagsIn(remote),
    // A clone of the remote somewhere else, as a teammate's.
    teammate() {
      mates += 1;
      const mate = path.join(base, `mate-${mates}`);
      gitIn(base, ['clone', '-q', remote, mate]);
      const runMate = (...args) => gitIn(mate, args);
      return {
        run: runMate,
        commit(message) {
          writeFileSync(path.join(mate, `${message.replaceAll(' ', '-')}.txt`), `${message}\n`);
          runMate('add', '-A');
          runMate('commit', '-q', '-m', message);
          return runMate('rev-parse', 'HEAD');
        },
      };
    },
  };
}

// Runs the script in this process. With answers, it runs as in a terminal and reads them line by line from its
// input, which then ends; without, it runs as without a terminal.
async function runMain(args, answers) {
  let stdout = '';
  let stderr = '';
  const sink = (append) =>
    new Writable({
      write(chunk, _encoding, done) {
        append(String(chunk));
        done();
      },
    });
  const lines = answers ?? [];
  const code = await main(args, {
    stdin: Readable.from(lines.length > 0 ? [lines.map((line) => `${line}\n`).join('')] : []),
    stdout: sink((text) => {
      stdout += text;
    }),
    stderr: sink((text) => {
      stderr += text;
    }),
    interactive: answers !== undefined,
  });
  return { code, stdout, stderr };
}

const tag = (repo, args, answers) => runMain(['--root', repo.dir, ...args], answers);

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: gitEnv(), input: '' });
}

const LISTED =
  /^ {2}([* ]) (\d{4}-\d\d-\d\d \d\d:\d\d) {2}([0-9a-f]{9}) {2}(annotated|lightweight)\s+(\S+)(?:\s+(.*))?$/;

// The rows of the listing, as the script printed them.
function listing(stdout) {
  const lines = stdout.split('\n');
  const start = lines.indexOf('Tags, newest first:');
  const rows = [];
  if (start === -1) return rows;
  for (const line of lines.slice(start + 1)) {
    const match = LISTED.exec(line);
    if (match === null) break;
    const [, mark, date, commit, kind, name, message = ''] = match;
    rows.push({ mark, date, commit, kind, name, message });
  }
  return rows;
}

const short = (commit) => commit.slice(0, 9);

describe('the tag listing', () => {
  it('shows each tag newest first, with its date, commit, kind and message, marking the ones on this commit', async () => {
    const repo = scratchRepos();
    const first = repo.head();
    repo.annotatedTag('v1.0.0', 'The first release\nof the stages round\n\nWith a body.');
    const second = repo.commit('two');
    repo.lightweightTag('list');
    repo.annotatedTag('QA-build-2026-10-07', 'QA build for the stages round');
    repo.push();

    const result = await tag(repo, [], []);
    assert.equal(result.code, EXIT.cancelled, result.stderr);
    assert.match(result.stdout, /^ {2}branch {2}main$/m);
    assert.match(result.stdout, new RegExp(`^ {2}commit {2}${short(second)} {2}two$`, 'm'));
    const rows = listing(result.stdout);
    assert.deepEqual(
      rows.map(({ mark, commit, kind, name, message }) => ({ mark, commit, kind, name, message })),
      [
        {
          mark: '*',
          commit: short(second),
          kind: 'annotated',
          name: 'QA-build-2026-10-07',
          message: 'QA build for the stages round',
        },
        { mark: '*', commit: short(second), kind: 'lightweight', name: 'list', message: '' },
        { mark: ' ', commit: short(first), kind: 'annotated', name: 'v1.0.0', message: 'The first release' },
      ],
    );
    const made = Number(repo.run('for-each-ref', '--format=%(creatordate:unix)', 'refs/tags/v1.0.0'));
    assert.equal(rows[2].date, new Date(made * 1000).toISOString().slice(0, 16).replace('T', ' '));
    assert.match(result.stdout, /^ {2}\* is on this commit\.$/m);
    assert.match(result.stdout, /This commit already has the tag QA-build-2026-10-07, which a deploy of it shows\./);
    assert.match(result.stdout, /Nothing was tagged\./);
  });

  it(`shows the latest ${DEFAULT_LIMIT} and says how many more there are, and --limit and --all change that`, async () => {
    const repo = scratchRepos();
    const names = Array.from({ length: 23 }, (_, i) => `build-${String(i + 1).padStart(2, '0')}`);
    for (const name of names) repo.annotatedTag(name);
    const newestFirst = names.toReversed();

    const latest = await tag(repo, [], []);
    assert.deepEqual(
      listing(latest.stdout).map((row) => row.name),
      newestFirst.slice(0, DEFAULT_LIMIT),
    );
    assert.match(latest.stdout, /3 older tags are not shown: --all lists every tag\./);

    const five = await tag(repo, ['--limit', '5'], []);
    assert.deepEqual(
      listing(five.stdout).map((row) => row.name),
      newestFirst.slice(0, 5),
    );
    assert.match(five.stdout, /18 older tags are not shown/);

    const all = await tag(repo, ['--all'], []);
    assert.deepEqual(
      listing(all.stdout).map((row) => row.name),
      newestFirst,
    );
    assert.doesNotMatch(all.stdout, /older tags? (is|are) not shown/);
  });

  it('names a tag the commit has that a deploy shows only until it has an annotated one, and offers no keep', async () => {
    const repo = scratchRepos();
    repo.lightweightTag('list');
    const result = await tag(repo, [], ['']);
    assert.equal(result.code, EXIT.cancelled);
    assert.match(
      result.stdout,
      /This commit has the lightweight tag list, which a deploy of it shows until it has an annotated tag\./,
    );
    assert.match(result.stdout, /Name for the new tag \(Enter cancels\): /);
    assert.equal(repo.remoteTags().has('list'), false);
  });

  it('names a tag a deploy passes over', async () => {
    const repo = scratchRepos();
    repo.lightweightTag("x'y");
    const result = await tag(repo, [], ['']);
    assert.equal(result.code, EXIT.cancelled);
    assert.match(result.stdout, /x'y {2}\(a deploy passes over this name\)/);
    assert.match(result.stdout, /This commit has no tag a deploy can show: a deploy passes over "x'y"\./);
  });
});

describe('what a tag must name', () => {
  it('refuses a commit no branch of the remote holds, and takes one any branch holds', async () => {
    const repo = scratchRepos();
    const local = repo.commit('not pushed');
    const refused = await tag(repo, ['--name', 'v2', '--yes']);
    assert.equal(refused.code, EXIT.refused);
    assert.match(
      refused.stderr,
      new RegExp(`no branch of origin holds ${short(local)}\\. Push it first, then tag it\\.`),
    );
    assert.equal(repo.tags().has('v2'), false);

    repo.run('push', '-q', 'origin', 'HEAD:refs/heads/feature');
    const taken = await tag(repo, ['--name', 'v2', '--yes', '--no-push']);
    assert.equal(taken.code, EXIT.done, taken.stderr);
    assert.equal(repo.tags().get('v2').target, local);
  });

  it('refuses changes git has not committed in what a deploy ships, naming each path', async () => {
    const repo = scratchRepos();
    repo.write('apps/a/index.ts', 'export const changed = true;\n');
    repo.write('packages/shared/new file.ts', 'export {};\n');
    repo.write('package.json', '{ "changed": true }\n');
    repo.write('tools/new-tool.mjs', 'export {};\n');
    repo.write('docs/guide.md', '# Changed\n');
    repo.write('apps/a/.env.qa', 'SECRET=1\n');

    const result = await tag(repo, ['--name', 'v2', '--yes']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stderr, /what a deploy ships holds changes git has not committed/);
    const named = result.stderr
      .split('\n')
      .filter((line) => line.startsWith('  '))
      .map((line) => line.trim());
    assert.deepEqual(named.toSorted(), ['apps/a/index.ts', 'package.json', 'packages/shared/new file.ts', 'tools/']);
    assert.equal(repo.tags().has('v2'), false);
  });

  it('counts neither ignored files nor changes outside what ships', async () => {
    const repo = scratchRepos();
    repo.write('apps/a/.env.qa', 'SECRET=1\n');
    repo.write('docs/guide.md', '# Changed\n');
    repo.write('docs/new.md', '# New\n');
    repo.write('README.md', '# Read me\n');
    const result = await tag(repo, ['--name', 'v2', '--yes', '--no-push']);
    assert.equal(result.code, EXIT.done, result.stderr);
    assert.equal(repo.tags().get('v2').type, 'tag');
  });
});

describe('the name', () => {
  it('is refused with the reason, and asked again in a terminal, until it is one a deploy can carry', async () => {
    const repo = scratchRepos();
    const first = repo.head();
    repo.annotatedTag('taken-here');
    repo.annotatedTag('release');
    repo.annotatedTag('Case-Twin');
    const second = repo.commit('two');
    repo.push();
    const mate = repo.teammate();
    const third = mate.commit('three by a teammate');
    mate.run('tag', '-a', '-m', 'theirs', 'taken-there');
    mate.run('push', '-q', 'origin', 'main', 'refs/tags/taken-there');

    const answers = ['QA build', 'HEAD', 'taken-here', 'taken-there', 'case-twin', 'release/2026', 'v2', 'Release two'];
    const result = await tag(repo, [], [...answers, 'y']);
    assert.equal(result.code, EXIT.done, result.stderr);
    const refusals = result.stderr.split('\n').filter((line) => line.startsWith('tag: '));
    assert.deepEqual(refusals, [
      'tag: the name "QA build" may hold only letters, digits and . _ + / -, and must start with a letter or a digit.',
      'tag: git does not take HEAD as the name of a tag.',
      `tag: taken-here is taken: it names ${short(first)} (first).`,
      `tag: taken-there is taken: it names ${short(third)} (three by a teammate).`,
      'tag: case-twin differs from the tag Case-Twin only in case, which git on a Mac or on Windows mixes up.',
      'tag: release/2026 cannot sit beside the tag release: git cannot hold a tag release and tags under release/ at once.',
    ]);
    assert.equal(result.stdout.split('Name for the new tag (Enter cancels): ').length - 1, 7);
    const made = repo.tags().get('v2');
    assert.equal(made.target, second);
    assert.equal(repo.run('tag', '-l', '--format=%(contents)', 'v2'), 'Release two');
    assert.equal(repo.remoteTags().get('v2').object, made.object);
  });

  it('is refused without asking again when it came as --name', async () => {
    const repo = scratchRepos();
    const result = await tag(repo, ['--name', 'QA build', '--yes']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stderr, /^tag: the name "QA build" may hold only letters/m);
    assert.doesNotMatch(result.stdout, /Name for/);
    assert.equal(repo.tags().size, 0);
  });

  it('is refused when it is taken on another commit, here or only on the remote, saying which commit', async () => {
    const repo = scratchRepos();
    const first = repo.head();
    repo.annotatedTag('taken-here');
    repo.commit('two');
    repo.push();
    const mate = repo.teammate();
    const third = mate.commit('three by a teammate');
    mate.run('tag', '-a', '-m', 'theirs', 'taken-there');
    mate.run('push', '-q', 'origin', 'main', 'refs/tags/taken-there');
    assert.equal(repo.tags().has('taken-there'), false, 'before the run only the remote has it');

    const here = await tag(repo, ['--name', 'taken-here', '--yes']);
    assert.equal(here.code, EXIT.refused);
    assert.match(here.stderr, new RegExp(`taken-here is taken: it names ${short(first)} \\(first\\)\\.`));

    const there = await tag(repo, ['--name', 'taken-there', '--yes']);
    assert.equal(there.code, EXIT.refused);
    assert.match(
      there.stderr,
      new RegExp(`taken-there is taken: it names ${short(third)} \\(three by a teammate\\)\\.`),
    );
    assert.equal(repo.remoteTags().get('taken-there').target, third, 'the remote keeps its own');
  });

  it("is refused when git's check-ref-format refuses it", async () => {
    const repo = scratchRepos();
    // Every name lib/tagName.mjs takes, check-ref-format takes too, so a git that refuses one stands in for a git
    // whose rules grow: this one refuses refs/tags/refused-by-git and runs the real git for everything else.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = path.join(repo.base, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'git'),
      '#!/bin/sh\n' +
        'if [ "$1" = check-ref-format ] && [ "$2" = refs/tags/refused-by-git ]; then exit 1; fi\n' +
        `exec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    const searchPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${searchPath}`;
    let result;
    try {
      result = await tag(repo, ['--name', 'refused-by-git', '--yes', '--no-push']);
    } finally {
      process.env.PATH = searchPath;
    }
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stderr, /^tag: git does not take refused-by-git as the name of a tag\.$/m);
    assert.equal(repo.tags().has('refused-by-git'), false);
  });
});

describe('creating the tag', () => {
  it('creates an annotated tag with its message on this commit and pushes that tag alone', async () => {
    const repo = scratchRepos();
    repo.commit('older');
    repo.annotatedTag('local-only', 'never pushed');
    const head = repo.commit('the release');
    repo.push();
    // Settings that would push the other tag with it, or delete it on the fetch, if the script let them.
    repo.run('config', 'push.followTags', 'true');
    repo.run('config', 'fetch.prune', 'true');
    repo.run('config', 'fetch.pruneTags', 'true');

    const result = await tag(repo, [], ['QA-build-2026-10-07', '#42 QA build for the stages round', 'y']);
    assert.equal(result.code, EXIT.done, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`Create QA-build-2026-10-07 on ${short(head)} and push it to origin\\? \\[y/N\\] y`),
    );
    assert.match(result.stdout, /A deploy of this commit names its build QA-build-2026-10-07\./);
    assert.match(result.stdout, /Pushed QA-build-2026-10-07 to origin\./);
    const made = repo.tags().get('QA-build-2026-10-07');
    assert.deepEqual({ type: made.type, target: made.target }, { type: 'tag', target: head });
    assert.equal(
      repo.run('tag', '-l', '--format=%(contents)', 'QA-build-2026-10-07'),
      '#42 QA build for the stages round',
    );
    const remote = repo.remoteTags();
    assert.equal(remote.get('QA-build-2026-10-07').object, made.object);
    assert.equal(remote.has('local-only'), false, 'only the new tag is pushed');
    assert.equal(repo.tags().has('local-only'), true, 'the fetch deletes no tag of the checkout');
  });

  it('creates the tag here only with --no-push, the message being the name when none is given', async () => {
    const repo = scratchRepos();
    const head = repo.head();
    const result = await tag(repo, ['--no-push'], ['v3', '', 'y']);
    assert.equal(result.code, EXIT.done, result.stderr);
    assert.match(result.stdout, new RegExp(`Create v3 on ${short(head)}\\? \\[y/N\\] y`));
    assert.match(
      result.stdout,
      /It is not pushed \(--no-push\)\. This pushes it:\n {2}git push origin refs\/tags\/v3\n/,
    );
    assert.equal(repo.run('tag', '-l', '--format=%(contents)', 'v3'), 'v3');
    assert.equal(repo.tags().get('v3').type, 'tag');
    assert.equal(repo.remoteTags().has('v3'), false);
  });

  it('keeps the tag the commit already has, pushing it where the remote lacks it', async () => {
    const repo = scratchRepos();
    repo.annotatedTag('kept', 'made earlier');
    repo.run('checkout', '-q', '--detach');
    const before = repo.tags();

    const local = await tag(repo, ['--no-push'], ['']);
    assert.equal(local.code, EXIT.done, local.stderr);
    assert.match(local.stdout, /^ {2}branch {2}detached$/m);
    assert.match(local.stdout, /Name for a new tag \(Enter keeps kept\): /);
    assert.match(local.stdout, /Keeping kept, which this commit already has\. Nothing was created\./);
    assert.match(local.stdout, /Nothing was pushed \(--no-push\)/);
    assert.equal(repo.remoteTags().has('kept'), false);

    const pushed = await tag(repo, [], ['']);
    assert.equal(pushed.code, EXIT.done, pushed.stderr);
    assert.match(pushed.stdout, /Enter keeps it, and pushes it to origin if origin lacks it\./);
    assert.match(pushed.stdout, /Pushed kept to origin\./);
    assert.equal(repo.remoteTags().get('kept').object, before.get('kept').object);

    // The same name again, as a script passes it: a reuse, which needs no --yes.
    const again = await tag(repo, ['--name', 'kept']);
    assert.equal(again.code, EXIT.done, again.stderr);
    assert.match(again.stdout, /origin already has kept\./);
    assert.deepEqual(repo.tags(), before, 'no tag was created or moved');
  });

  it('is cancelled by an empty name, an answer other than yes, or the end of the input', async () => {
    const repo = scratchRepos();
    for (const answers of [[''], ['v2', '', 'n'], ['v2', 'a message', ''], ['v2'], []]) {
      const result = await tag(repo, [], answers);
      assert.equal(result.code, EXIT.cancelled, JSON.stringify(answers));
      assert.match(result.stdout, /Nothing was tagged\.\n$/, JSON.stringify(answers));
    }
    assert.equal(repo.tags().size, 0);
    assert.equal(repo.remoteTags().size, 0);
  });

  it('keeps the tag here when the push fails, and prints the command that pushes it again', async () => {
    const repo = scratchRepos();
    repo.run('remote', 'set-url', '--push', 'origin', path.join(repo.base, 'missing.git'));
    const result = await tag(repo, ['--name', 'v2', '--yes']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout, /Created v2 on [0-9a-f]{9}\./);
    assert.match(result.stderr, /^tag: pushing v2 to origin failed\.$/m);
    assert.match(
      result.stderr,
      /v2 stays on this machine\. This pushes it again:\n {2}git push origin refs\/tags\/v2\n/,
    );
    assert.equal(repo.tags().get('v2').type, 'tag');
    assert.equal(repo.remoteTags().has('v2'), false);
  });

  it('warns and goes on when the remote cannot be fetched', async () => {
    const repo = scratchRepos();
    repo.run('remote', 'set-url', 'origin', path.join(repo.base, 'unreachable.git'));
    const result = await tag(repo, ['--name', 'v2', '--yes', '--no-push']);
    assert.equal(result.code, EXIT.done, result.stderr);
    assert.match(
      result.stderr,
      /^tag: could not fetch the tags of origin, so a name a teammate pushed there cannot be checked\. Going on\.$/m,
    );
    assert.equal(repo.tags().get('v2').type, 'tag');
  });
});

describe('a run without a terminal', () => {
  it('needs --name, and says so before anything else', () => {
    const repo = scratchRepos();
    const result = runScript(['--root', repo.dir]);
    assert.equal(result.status, EXIT.usage);
    assert.match(result.stderr, /run it in a terminal or pass --name/);
    assert.equal(result.stdout, '');
  });

  it('needs --yes to create a tag', async () => {
    const repo = scratchRepos();
    const result = await tag(repo, ['--name', 'v2']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr, /pass --yes to create the tag/);
    assert.equal(repo.tags().size, 0);
  });

  it('creates and pushes the tag with --name and --yes', () => {
    const repo = scratchRepos();
    const result = runScript(['--root', repo.dir, '--name', 'cli-build', '--message', 'From a script', '--yes']);
    assert.equal(result.status, EXIT.done, result.stderr);
    assert.equal(repo.run('tag', '-l', '--format=%(contents)', 'cli-build'), 'From a script');
    assert.equal(repo.remoteTags().get('cli-build').object, repo.tags().get('cli-build').object);
  });
});

describe('the arguments', () => {
  it('prints its usage on --help', () => {
    const result = runScript(['--help']);
    assert.equal(result.status, EXIT.done);
    assert.match(result.stdout, /^Usage: node tools\/release\/tag\.mjs /);
    assert.match(result.stdout, /Exit status: 0 created or kept, 1 refused or failed, 2 usage error, 3 cancelled\./);
  });

  it('refuses what it does not know, with exit status 2', async () => {
    const repo = scratchRepos();
    for (const args of [
      ['--colour'],
      ['QA-build'],
      ['--name'],
      ['--name='],
      ['--yes=1'],
      ['--limit', '0'],
      ['--limit', 'ten'],
      ['--all', '--limit', '5'],
      ['--remote', '-x'],
    ]) {
      const result = await tag(repo, args, []);
      assert.equal(result.code, EXIT.usage, args.join(' '));
      assert.match(result.stderr, /^tag: .+\nUsage: /, args.join(' '));
    }
  });

  it('refuses a folder outside a checkout and a remote the checkout does not have', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'release-tag-outside-'));
    scratch.push(outside);
    const notGit = await runMain(['--root', outside, '--name', 'v2', '--yes']);
    assert.equal(notGit.code, EXIT.refused);
    assert.match(notGit.stderr, /is not inside a git checkout\./);

    const repo = scratchRepos();
    const result = await tag(repo, ['--remote', 'upstream', '--name', 'v2', '--yes']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stderr, /^tag: this checkout has no remote named upstream\. Its remotes are origin/m);
  });
});
