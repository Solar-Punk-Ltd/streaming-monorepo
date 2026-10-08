/**
 * That the build container is shown the staging tree and nothing else, and
 * that an attempt is its own.
 *
 * Every deployment's secrets live in a version's flat root as `.env.<profile>`,
 * with STREAM_KEY, SRT_PASSPHRASE and STAMP in them, and the base `.env`
 * alongside. The build runs the followed branch's own install and build
 * scripts inside a container, so mounting that root, or the clone, would hand
 * a branch nobody vetted what is there. The script exports the fetched commit
 * into the attempt's staging tree, mounts that, and leaves the tree for the
 * manager to publish.
 *
 * Read from the file, as `nginxProxyHeaders.test.ts` reads nginx.conf: none of
 * this can be exercised without git, docker and a network.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitEnv } from '../../src/domain/versions/buildLabel.js';
import {
  BUILD_CONTAINER_PREFIX,
  BUILD_IMAGE,
  PINNED_PNPM,
  STACK_COMMIT_FILE,
} from '../../src/domain/versions/StackVersionService.js';
import { scratchGitEnv } from '../support/scratchGit.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUILD_SCRIPT = join(here, '..', '..', 'scripts', 'stack-version-build.sh');
/** The repository's own cut tool, which a fixture commit carries when the cut has to run for real. */
const CUT_TOOL = join(here, '..', '..', '..', '..', '..', 'tools', 'app-workspace');

const script = readFileSync(BUILD_SCRIPT, 'utf8');

/**
 * The `docker run ...` invocation, up to the image name. Matched at the start
 * of a line, because the script's own header talks about `docker run -v` too.
 */
function dockerRun(): string {
  const start = script.indexOf('\ndocker run');
  assert.notEqual(start, -1, 'no docker run in the build script');

  const end = script.indexOf('$BUILD_IMAGE', start);
  assert.notEqual(end, -1, 'the docker run does not reach the build image');
  return script.slice(start, end);
}

describe('stack-version-build.sh mounts', () => {
  it('gives the build container the staging tree', () => {
    assert.match(dockerRun(), /-v "\$STAGING:\$STAGING"/);
    assert.match(dockerRun(), /-w "\$STAGING"/);
  });

  it('never gives it the clone, and knows no flat root at all', () => {
    assert.equal(dockerRun().includes('$REPO'), false, 'the clone is mounted into the build container');
    assert.equal(script.includes('$ROOT'), false, 'the script names a flat root');
  });

  it('exports the fetched commit rather than copying the working tree', () => {
    assert.match(script, /git -C "\$REPO" archive "\$ARCHIVE_REV" \| tar -x -C "\$STAGING"/);
  });

  it('caps what the build may spend on this host', () => {
    assert.match(dockerRun(), /--memory 4g/);
    assert.match(dockerRun(), /--cpus 2/);
    assert.match(dockerRun(), /--pids-limit 512/);
  });

  it('passes no environment of its own into the container', () => {
    assert.equal(dockerRun().includes('-e '), false);
    assert.equal(dockerRun().includes('--env'), false);
  });

  it('builds with the image and the pnpm the manager records in every manifest', () => {
    assert.match(script, new RegExp(`BUILD_IMAGE="${BUILD_IMAGE}"`));
    assert.match(script, new RegExp(`PINNED_PNPM='${PINNED_PNPM}'`));
  });
});

describe('stack-version-build.sh attempts', () => {
  it('names the build container after the attempt, so boot can ask Docker whether it still runs', () => {
    assert.match(dockerRun(), new RegExp(`--name "${BUILD_CONTAINER_PREFIX}\\$ATTEMPT"`));
    assert.match(script, /\[\[ "\$ATTEMPT" =~ \^\[0-9a-f\]\{8,32\}\$ \]\]/);
  });

  it('refuses a staging tree that exists, because an attempt never shares one', () => {
    assert.match(script, /if \[ -e "\$STAGING" \]; then/);
  });

  it('leaves the commit it exported in the staging tree for the manager', () => {
    assert.match(script, new RegExp(`> "\\$STAGING/${STACK_COMMIT_FILE.replace('.', '\\.')}"`));
  });

  it('removes its staging tree on failure and leaves it on success', () => {
    assert.match(script, /if \[ "\$code" -ne 0 \]; then rm -rf "\$STAGING"; fi/);
  });

  it("copies nothing back and publishes nothing: that is the manager's", () => {
    assert.equal(script.includes('rsync'), false);
    assert.equal(script.includes('copy_when_missing'), false);
  });
});

describe('stack-version-build.sh refs', () => {
  it('takes a forty character commit as well as a branch or a tag', () => {
    assert.match(script, /REF_IS_COMMIT=/, 'the script tells a commit from a name');
    assert.match(script, /\^\[0-9a-f\]\{40\}\$/, 'a commit is forty hex characters');
  });

  it('points the existing clone at the checked url before it fetches anything', () => {
    const existing = script.slice(script.indexOf('if [ -d "$REPO/.git" ]'), script.indexOf('COMMIT="$(git -C'));
    const repointed = existing.indexOf('git -C "$REPO" remote set-url origin "$REPO_URL"');
    assert.notEqual(repointed, -1, 'the url the clone carries is never the one fetched from');
    assert.ok(repointed < existing.indexOf('git -C "$REPO" fetch'), 'the repoint comes before every fetch');
  });

  it('mirrors the tags into an existing clone, then fetches the ref on its own, a commit like a branch or a tag', () => {
    const existing = script.slice(script.indexOf('if [ -d "$REPO/.git" ]'), script.indexOf('elif [ "$REF_IS_COMMIT"'));
    const fetches = existing.match(/^\s*git -C "\$REPO" fetch .*$/gm)?.map((line) => line.trim());
    assert.deepEqual(
      fetches,
      [
        `git -C "$REPO" fetch --prune origin '+refs/tags/*:refs/tags/*'`,
        'git -C "$REPO" fetch --prune --no-tags origin "$REF"',
      ],
      'the tags as the remote has them, then the ref alone, so FETCH_HEAD names the ref and never a tag',
    );
    assert.ok(
      existing.indexOf('--no-tags origin "$REF"') <
        existing.indexOf('git -C "$REPO" checkout --detach --force FETCH_HEAD'),
      'the checkout reads the FETCH_HEAD of the ref',
    );
    assert.match(existing, /git -C "\$REPO" reset --hard FETCH_HEAD/);
  });

  it('makes an empty clone and fetches the commit into it with the tags, because clone --branch takes no commit', () => {
    const fresh = script.slice(script.indexOf('git init'), script.indexOf('COMMIT="$(git -C'));
    assert.match(fresh, /git init/);
    assert.match(fresh, /git -C "\$REPO" remote add origin "\$REPO_URL"/);
    assert.match(fresh, /git -C "\$REPO" fetch --tags origin "\$REF"/, 'the manager reads the release off the tags');
    assert.match(fresh, /git -C "\$REPO" checkout --detach --force FETCH_HEAD/);
  });

  it('keeps the clone of a branch or a tag as it was', () => {
    assert.match(script, /git clone --branch "\$REF" --single-branch "\$REPO_URL" "\$REPO"/);
    assert.match(script, /git -C "\$REPO" fetch --prune --no-tags origin "\$REF"/);
  });
});

/** Where the build script writes the folder it took the stack from, beside the commit. */
const STACK_FOLDER_FILE = '.stack-folder';

/** And the image and the pnpm it built with. */
const STACK_TOOLCHAIN_FILE = '.stack-toolchain';

/** The folder of the staging tree a commit with its lockfile at the root has the stack's own cut out of. */
const WORKSPACE_ROOT_DIR = '.workspace-root';

/** The build a commit whose stack keeps its own lockfile has always run. */
const TODAYS_BUILD = `corepack enable && corepack prepare ${PINNED_PNPM} --activate && pnpm install --frozen-lockfile && pnpm -r build`;

/**
 * A docker that writes down the command it was asked to run and every file of
 * the side folder it found in the staging tree, then exits as it is told.
 */
function recordingDocker(root: string, status = 0): { command: string; sideFolder: string } {
  const command = join(root, 'docker-command');
  const sideFolder = join(root, 'docker-side-folder');
  writeFileSync(
    join(root, 'bin', 'docker'),
    [
      '#!/bin/sh',
      'for arg in "$@"; do command="$arg"; done',
      'while [ "$#" -gt 0 ]; do if [ "$1" = -w ]; then dir="$2"; fi; shift; done',
      `printf '%s\\n' "$command" > '${command}'`,
      `if [ -d "$dir/${WORKSPACE_ROOT_DIR}" ]; then (cd "$dir" && find ${WORKSPACE_ROOT_DIR} -type f | LC_ALL=C sort) > '${sideFolder}'; fi`,
      `exit ${status}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { command, sideFolder };
}

/**
 * A docker that runs the command it was asked to run in the staging tree, as
 * the container would, beside a corepack and a pnpm that do nothing. The cut
 * is then the one part of the build that runs for real, with this host's node.
 */
function runningDocker(root: string): void {
  for (const name of ['corepack', 'pnpm'])
    writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    join(root, 'bin', 'docker'),
    [
      '#!/bin/sh',
      'for arg in "$@"; do command="$arg"; done',
      'while [ "$#" -gt 0 ]; do if [ "$1" = -w ]; then dir="$2"; fi; shift; done',
      'cd "$dir" && exec sh -c "$command"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

/** A committer time in the past, so a file dated by its commit cannot pass for one dated by the run. */
const COMMITTED_AT = '2026-01-02T03:04:05Z';

/** git in a scratch repository: none of the variables that point git elsewhere, none of the machine's configuration. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=build@example.invalid', '-c', 'user.name=Build', ...args], {
    cwd,
    encoding: 'utf8',
    env: scratchGitEnv({ GIT_AUTHOR_DATE: COMMITTED_AT, GIT_COMMITTER_DATE: COMMITTED_AT }),
  }).trim();

/**
 * A docker that does nothing, and a home that points `url` at `origin`.
 *
 * GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and GIT_CONFIG_COUNT all outrank HOME,
 * so a developer who has any of them set would send a fetch to github.com.
 * Each is given its answer here rather than inherited.
 */
function offline(root: string, url: string, origin: string): NodeJS.ProcessEnv {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), `[url "${origin}"]\n\tinsteadOf = ${url}\n`);

  // gitEnv drops GIT_DIR and the rest of what a hook or `git rebase --exec`
  // exports, which would otherwise point every `git -C "$REPO"` in the script
  // at the checkout the suite runs in.
  return {
    ...gitEnv(process.env),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
}

/** Every file under `dir`, as paths relative to it, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * The commit path run for real, against a repository on this disk and a docker
 * that does nothing. Only git runs: the fetch, the detached checkout and the
 * export are the part of this script no reading of its text can prove.
 *
 * The script may only be given the stack's own https url, so the local
 * repository is put behind that url with git's own `insteadOf` rewrite in a
 * home directory of this test's making. Nothing of the script is relaxed for
 * the test, and nothing leaves this machine.
 */
describe('stack-version-build.sh fetches a pinned commit', () => {
  const STACK_URL = 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git';

  /** An origin with two commits, a docker that does nothing, and a home that points the stack url here. */
  function fixture(root: string): { pinned: string; environment: NodeJS.ProcessEnv } {
    const origin = join(root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    // The one server setting GitHub already has: a reachable commit may be
    // asked for by name, which is what pinning a commit needs.
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    writeFileSync(join(origin, 'package.json'), '{"name":"pinned"}\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'first');
    const pinned = git(origin, 'rev-parse', 'HEAD');
    writeFileSync(join(origin, 'package.json'), '{"name":"moved-on"}\n');
    git(origin, 'commit', '-qam', 'second');

    return { pinned, environment: offline(root, STACK_URL, origin) };
  }

  /** swarm-hls-stream's whole tree is the stack, so it has no folder and no history from before one. */
  function build(root: string, repo: string, ref: string, environment: NodeJS.ProcessEnv): string {
    const staging = join(root, `staging-${ref.slice(0, 8)}`);
    execFileSync('bash', [BUILD_SCRIPT, repo, staging, ref, STACK_URL, '.', 'none', 'abcdef01'], { env: environment });
    return staging;
  }

  it('fetches it into a clone the version already has', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-commit-'));
    try {
      const { pinned, environment } = fixture(root);
      const repo = join(root, 'stack.repo');
      execFileSync('git', ['clone', '-q', join(root, 'origin'), repo]);

      const staging = build(root, repo, pinned, environment);

      assert.equal(readFileSync(join(staging, STACK_COMMIT_FILE), 'utf8').trim(), pinned);
      assert.equal(readFileSync(join(staging, 'package.json'), 'utf8'), '{"name":"pinned"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fetches from the url it was given, not the one the clone on disk carries', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-repointed-'));
    try {
      const { pinned, environment } = fixture(root);
      const repo = join(root, 'stack.repo');
      execFileSync('git', ['clone', '-q', join(root, 'origin'), repo]);
      // Anyone who can write into the versions root can do this, and the
      // versions root is bind mounted read write into the api container.
      git(repo, 'remote', 'set-url', 'origin', join(root, 'planted'));

      const staging = build(root, repo, pinned, environment);

      assert.equal(git(repo, 'config', '--get', 'remote.origin.url'), STACK_URL);
      assert.equal(readFileSync(join(staging, 'package.json'), 'utf8'), '{"name":"pinned"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fetches it into a clone that does not exist yet, where clone --branch would refuse a commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-fresh-'));
    try {
      const { pinned, environment } = fixture(root);

      const staging = build(root, join(root, 'stack.repo'), pinned, environment);

      assert.equal(readFileSync(join(staging, STACK_COMMIT_FILE), 'utf8').trim(), pinned);
      assert.equal(readFileSync(join(staging, 'package.json'), 'utf8'), '{"name":"pinned"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Every stack release tag is annotated, so a tag names a tag object of its
   * own. An Update fetches the tag into the clone the version already has, and
   * what it records has to be the commit, or it publishes a new build of the
   * same tree under an id that is no commit and clears the Tested mark.
   */
  it('records the commit an annotated tag points at, in a new clone and in the clone it already has', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-tag-'));
    try {
      const { pinned, environment } = fixture(root);
      const origin = join(root, 'origin');
      git(origin, 'tag', '-a', 'stack/v1', '-m', 'a release', pinned);
      assert.notEqual(git(origin, 'rev-parse', 'stack/v1'), pinned, 'an annotated tag is an object of its own');
      const repo = join(root, 'stack.repo');
      const added = join(root, 'staging-added');
      const updated = join(root, 'staging-updated');

      execFileSync('bash', [BUILD_SCRIPT, repo, added, 'stack/v1', STACK_URL, '.', 'none', 'abcdef01'], {
        env: environment,
      });
      execFileSync('bash', [BUILD_SCRIPT, repo, updated, 'stack/v1', STACK_URL, '.', 'none', 'abcdef02'], {
        env: environment,
      });

      assert.equal(readFileSync(join(added, STACK_COMMIT_FILE), 'utf8').trim(), pinned);
      assert.equal(readFileSync(join(updated, STACK_COMMIT_FILE), 'utf8').trim(), pinned);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The manager names a build by the tag on its commit, read in the clone once
   * the build is done, so a pinned commit has to arrive with the tags as a
   * branch or a tag already did.
   */
  it('brings the tags along with a pinned commit, into a new clone and into the clone it already has', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-tags-'));
    try {
      const { pinned, environment } = fixture(root);
      const origin = join(root, 'origin');
      git(origin, 'tag', '-a', 'QA-build-2026-10-07', '-m', 'a release', pinned);
      const fresh = join(root, 'fresh.repo');
      const existing = join(root, 'existing.repo');
      execFileSync('git', ['clone', '-q', origin, existing], { env: scratchGitEnv() });
      git(origin, 'tag', '-a', 'QA-build-2026-10-08', '-m', 'the release after it', pinned);

      execFileSync(
        'bash',
        [BUILD_SCRIPT, fresh, join(root, 'staging-fresh'), pinned, STACK_URL, '.', 'none', 'abcdef01'],
        {
          env: environment,
        },
      );
      execFileSync(
        'bash',
        [BUILD_SCRIPT, existing, join(root, 'staging-existing'), pinned, STACK_URL, '.', 'none', 'abcdef02'],
        { env: environment },
      );

      assert.deepEqual(git(fresh, 'tag', '--list').split('\n'), ['QA-build-2026-10-07', 'QA-build-2026-10-08']);
      assert.deepEqual(git(existing, 'tag', '--list').split('\n'), ['QA-build-2026-10-07', 'QA-build-2026-10-08']);
      assert.equal(readFileSync(join(root, 'staging-fresh', STACK_COMMIT_FILE), 'utf8').trim(), pinned);
      assert.equal(readFileSync(join(root, 'staging-existing', STACK_COMMIT_FILE), 'utf8').trim(), pinned);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** One more build of `ref` into `repo`, staged under a name of its own, which has to succeed. */
  function buildAgain(
    root: string,
    repo: string,
    ref: string,
    attempt: string,
    environment: NodeJS.ProcessEnv,
  ): string {
    const staging = join(root, `staging-${attempt}`);
    const run = spawnSync('bash', [BUILD_SCRIPT, repo, staging, ref, STACK_URL, '.', 'none', attempt], {
      env: environment,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `the build of ${ref} failed: ${run.stderr}`);
    return staging;
  }

  const builtCommit = (staging: string): string => readFileSync(join(staging, STACK_COMMIT_FILE), 'utf8').trim();

  /**
   * docs/releasing.md has an operator delete a mistaken tag and tag the right
   * commit, often under the same name. A fetch that keeps the clone's own tag
   * refuses to move it, "would clobber existing tag", and every later build of
   * the version failed until someone deleted the tag in the clone on the host.
   */
  it('follows a tag moved upstream between two builds, and still builds the commit the ref names', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-moved-tag-'));
    try {
      const { pinned, environment } = fixture(root);
      const origin = join(root, 'origin');
      const repo = join(root, 'stack.repo');
      const moved = git(origin, 'rev-parse', 'HEAD');
      git(origin, 'tag', '-a', 'QA-build-2026-10-07', '-m', 'a release', pinned);
      buildAgain(root, repo, pinned, 'abcdef01', environment);
      assert.equal(git(repo, 'rev-parse', 'QA-build-2026-10-07^{commit}'), pinned);

      git(origin, 'tag', '-d', 'QA-build-2026-10-07');
      git(origin, 'tag', '-a', 'QA-build-2026-10-07', '-m', 'the release, on the right commit', moved);
      const again = buildAgain(root, repo, pinned, 'abcdef02', environment);

      assert.equal(git(repo, 'rev-parse', 'QA-build-2026-10-07^{commit}'), moved, "the clone's tag follows");
      assert.equal(builtCommit(again), pinned, 'the pinned commit is still what is built');
      assert.equal(
        builtCommit(buildAgain(root, repo, 'QA-build-2026-10-07', 'abcdef03', environment)),
        moved,
        'a version that follows the tag builds the commit it moved to',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a tag deleted upstream from the clone at the next build, and keeps the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-deleted-tag-'));
    try {
      const { pinned, environment } = fixture(root);
      const origin = join(root, 'origin');
      const repo = join(root, 'stack.repo');
      git(origin, 'tag', '-a', 'QA-build-2026-10-07', '-m', 'a release', pinned);
      git(origin, 'tag', '-a', 'QA-build-mistaken', '-m', 'a mistake', pinned);
      buildAgain(root, repo, pinned, 'abcdef01', environment);
      assert.deepEqual(git(repo, 'tag', '--list').split('\n'), ['QA-build-2026-10-07', 'QA-build-mistaken']);

      git(origin, 'tag', '-d', 'QA-build-mistaken');
      const again = buildAgain(root, repo, pinned, 'abcdef02', environment);

      assert.deepEqual(git(repo, 'tag', '--list').split('\n'), ['QA-build-2026-10-07']);
      assert.equal(builtCommit(again), pinned);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says the whole tree is the stack', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-whole-'));
    try {
      const { pinned, environment } = fixture(root);

      const staging = build(root, join(root, 'stack.repo'), pinned, environment);

      assert.equal(readFileSync(join(staging, STACK_FOLDER_FILE), 'utf8'), '.\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds a tree that names no pnpm exactly as before, and records the pinned one', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-pinned-'));
    try {
      const { pinned, environment } = fixture(root);
      const record = recordingDocker(root);

      const staging = build(root, join(root, 'stack.repo'), pinned, environment);

      assert.equal(readFileSync(record.command, 'utf8'), `${TODAYS_BUILD}\n`);
      assert.equal(existsSync(record.sideFolder), false, 'a tree with no root lockfile gets no side folder');
      assert.equal(readFileSync(join(staging, STACK_TOOLCHAIN_FILE), 'utf8'), `${BUILD_IMAGE} ${PINNED_PNPM}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The same path against a monorepo, where the stack sits in apps/hls-stream
 * and the repository also holds the stack's own history from before it moved
 * there, under the same commit ids.
 */
describe('stack-version-build.sh takes the stack out of its folder in a monorepo', () => {
  const MONOREPO_URL = 'https://github.com/Solar-Punk-Ltd/streaming-monorepo.git';
  const FOLDER = 'apps/hls-stream';

  interface Monorepo {
    /** A commit of the stack's own history, the stack at the root. */
    stackOld: string;
    /** The stack head the import took in. */
    stackHead: string;
    /** A commit of the other project's history, which holds no stack at all. */
    adminOnly: string;
    /** The head of main, after the import and one change to the stack. */
    moved: string;
    /** The same stack naming its pnpm while it keeps its own lockfile, as main-v3's has done since it moved to pnpm 11.11.0. */
    ownLockfileNamed: string;
    /** A commit made once the repository became one workspace: the lockfile at the root, and none in the stack. */
    oneWorkspace: string;
    /** The same with a package every app shares under the root's packages/, which the cut carries into the stack. */
    withPackages: string;
    /** The same with no tools/app-workspace to cut the stack's lockfile out of the root one. */
    noCutTool: string;
    /** The same with a stack that names yarn rather than a pnpm. */
    yarnNamed: string;
    /** The same with a stack that holds a .workspace-root of its own. */
    sideFolderTaken: string;
    /** The same with the repository's real cut tool and a stack that names no pnpm, which the cut refuses. */
    unnamedStack: string;
    environment: NodeJS.ProcessEnv;
  }

  /** The pnpm a commit on one workspace names, in the root and in the stack alike. */
  const ONE_PNPM = 'pnpm@11.11.0+sha512.0123abcd';

  /**
   * The monorepo in miniature: the stack's history with the stack at the root,
   * another project's history beside it, a merge that takes the stack in under
   * apps/hls-stream with its commit ids kept, and one stack change on top.
   */
  function monorepo(root: string): Monorepo {
    const origin = join(root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'stack');
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    mkdirSync(join(origin, 'deploy', 'scripts'), { recursive: true });
    writeFileSync(join(origin, '.env.sample'), 'STACK_PORT=1\n');
    writeFileSync(join(origin, 'deploy', 'scripts', '_lib.sh'), 'PORT_VARS=(STACK_PORT)\n');
    writeFileSync(join(origin, 'package.json'), '{"name":"stack-old"}\n');
    writeFileSync(join(origin, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'the stack, early');
    const stackOld = git(origin, 'rev-parse', 'HEAD');
    writeFileSync(join(origin, 'package.json'), '{"name":"stack-at-the-import"}\n');
    git(origin, 'commit', '-qam', 'the stack, as the import takes it');
    const stackHead = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'switch', '-q', '--orphan', 'main');
    writeFileSync(join(origin, 'admin.txt'), 'another project\n');
    git(origin, 'add', 'admin.txt');
    git(origin, 'commit', '-qm', 'another project');
    const adminOnly = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'merge', '-q', '-s', 'ours', '--no-commit', '--allow-unrelated-histories', stackHead);
    git(origin, 'read-tree', `--prefix=${FOLDER}/`, '-u', stackHead);
    git(origin, 'commit', '-qm', 'take the stack in');
    writeFileSync(join(origin, FOLDER, 'package.json'), '{"name":"stack-in-the-monorepo"}\n');
    git(origin, 'commit', '-qam', 'the stack moves on');
    const moved = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'switch', '-q', '-c', 'own-lockfile-named');
    writeFileSync(
      join(origin, FOLDER, 'package.json'),
      `${JSON.stringify({ name: 'stack-naming-its-pnpm', packageManager: ONE_PNPM })}\n`,
    );
    git(origin, 'commit', '-qam', 'the stack names its pnpm and keeps its own lockfile');
    const ownLockfileNamed = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'switch', '-q', 'main');

    git(origin, 'switch', '-q', '-c', 'one-workspace');
    writeFileSync(join(origin, 'package.json'), `${JSON.stringify({ name: 'monorepo', packageManager: ONE_PNPM })}\n`);
    writeFileSync(join(origin, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    writeFileSync(join(origin, 'pnpm-workspace.yaml'), `packages:\n  - ${FOLDER}\n`);
    mkdirSync(join(origin, 'tools', 'app-workspace'), { recursive: true });
    writeFileSync(
      join(origin, 'tools', 'app-workspace', 'cut.mjs'),
      "// cuts the stack's own lockfile out of the root one\n",
    );
    git(origin, 'rm', '-q', join(FOLDER, 'pnpm-lock.yaml'));
    writeFileSync(
      join(origin, FOLDER, 'package.json'),
      `${JSON.stringify({ name: 'stack-on-one-workspace', packageManager: ONE_PNPM })}\n`,
    );
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'one workspace at the root');
    const oneWorkspace = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'switch', '-q', '-c', 'with-packages');
    mkdirSync(join(origin, 'packages', 'contracts', 'src'), { recursive: true });
    writeFileSync(join(origin, 'packages', 'contracts', 'package.json'), '{"name":"@example/contracts"}\n');
    writeFileSync(join(origin, 'packages', 'contracts', 'src', 'index.ts'), 'export {};\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'a package every app shares');
    const withPackages = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'switch', '-q', 'one-workspace');

    git(origin, 'switch', '-q', '-c', 'no-cut-tool');
    git(origin, 'rm', '-q', '-r', 'tools');
    git(origin, 'commit', '-qm', 'no cut tool');
    const noCutTool = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'switch', '-q', '-c', 'yarn-named', oneWorkspace);
    writeFileSync(
      join(origin, FOLDER, 'package.json'),
      `${JSON.stringify({ name: 'stack-on-yarn', packageManager: 'yarn@4.1.0' })}\n`,
    );
    git(origin, 'commit', '-qam', 'a stack that names yarn');
    const yarnNamed = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'switch', '-q', '-c', 'side-folder-taken', oneWorkspace);
    mkdirSync(join(origin, FOLDER, WORKSPACE_ROOT_DIR));
    writeFileSync(join(origin, FOLDER, WORKSPACE_ROOT_DIR, 'stray.txt'), "the stack's own\n");
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'a stack with a .workspace-root of its own');
    const sideFolderTaken = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'switch', '-q', '-c', 'unnamed-stack', oneWorkspace);
    git(origin, 'rm', '-q', '-r', 'tools');
    cpSync(CUT_TOOL, join(origin, 'tools', 'app-workspace'), {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes('node_modules'),
    });
    writeFileSync(join(origin, FOLDER, 'package.json'), `${JSON.stringify({ name: 'stack-naming-no-pnpm' })}\n`);
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'a stack on one workspace that names no pnpm');
    const unnamedStack = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'switch', '-q', 'main');

    return {
      stackOld,
      stackHead,
      adminOnly,
      moved,
      ownLockfileNamed,
      oneWorkspace,
      withPackages,
      noCutTool,
      yarnNamed,
      sideFolderTaken,
      unnamedStack,
      environment: offline(root, MONOREPO_URL, origin),
    };
  }

  interface Built {
    staging: string;
    status: number | null;
    stderr: string;
  }

  function build(
    root: string,
    ref: string,
    historyHead: string,
    environment: NodeJS.ProcessEnv,
    folder = FOLDER,
  ): Built {
    const staging = join(root, `staging-${ref.replaceAll('/', '-').slice(0, 12)}`);
    const run = spawnSync(
      'bash',
      [BUILD_SCRIPT, join(root, 'monorepo.repo'), staging, ref, MONOREPO_URL, folder, historyHead, 'abcdef01'],
      { env: environment, encoding: 'utf8' },
    );
    return { staging, status: run.status, stderr: run.stderr };
  }

  function withMonorepo(prefix: string, check: (root: string, repo: Monorepo) => void): void {
    const root = mkdtempSync(join(tmpdir(), prefix));
    try {
      check(root, monorepo(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("exports a branch's apps/hls-stream and nothing else of the repository", () => {
    withMonorepo('stack-build-mono-branch-', (root, repo) => {
      const built = build(root, 'main', repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      const stack = git(join(root, 'origin'), 'ls-tree', '-r', '--name-only', `${repo.moved}:${FOLDER}`).split('\n');
      assert.deepEqual(
        filesUnder(built.staging),
        [...stack, STACK_COMMIT_FILE, STACK_FOLDER_FILE, STACK_TOOLCHAIN_FILE].sort(),
      );
      assert.equal(readFileSync(join(built.staging, 'package.json'), 'utf8'), '{"name":"stack-in-the-monorepo"}\n');
      assert.equal(readFileSync(join(built.staging, STACK_COMMIT_FILE), 'utf8').trim(), repo.moved);
      assert.equal(readFileSync(join(built.staging, STACK_FOLDER_FILE), 'utf8'), `${FOLDER}\n`);
    });
  });

  it("exports a commit's apps/hls-stream the same way", () => {
    withMonorepo('stack-build-mono-commit-', (root, repo) => {
      const built = build(root, repo.moved, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      assert.equal(existsSync(join(built.staging, 'admin.txt')), false, 'the other project is not the stack');
      assert.equal(existsSync(join(built.staging, 'apps')), false, 'the folder is the root of the export');
      assert.equal(readFileSync(join(built.staging, 'package.json'), 'utf8'), '{"name":"stack-in-the-monorepo"}\n');
      assert.equal(readFileSync(join(built.staging, STACK_FOLDER_FILE), 'utf8'), `${FOLDER}\n`);
    });
  });

  it('dates every file with the commit, as an export of the whole tree does', () => {
    withMonorepo('stack-build-mono-times-', (root, repo) => {
      const built = build(root, repo.moved, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      for (const file of ['package.json', '.env.sample', join('deploy', 'scripts', '_lib.sh')]) {
        assert.equal(statSync(join(built.staging, file)).mtimeMs, Date.parse(COMMITTED_AT), file);
      }
    });
  });

  it("builds a commit of the stack's own history whole, since there the stack is the root", () => {
    withMonorepo('stack-build-mono-old-', (root, repo) => {
      const built = build(root, repo.stackOld, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      assert.equal(readFileSync(join(built.staging, 'package.json'), 'utf8'), '{"name":"stack-old"}\n');
      assert.equal(readFileSync(join(built.staging, STACK_COMMIT_FILE), 'utf8').trim(), repo.stackOld);
      assert.equal(readFileSync(join(built.staging, STACK_FOLDER_FILE), 'utf8'), '.\n');
    });
  });

  it('refuses a commit that is neither, in words, and leaves no staging tree', () => {
    withMonorepo('stack-build-mono-other-', (root, repo) => {
      const built = build(root, repo.adminOnly, repo.stackHead, repo.environment);

      assert.notEqual(built.status, 0);
      assert.match(built.stderr, new RegExp(`${repo.adminOnly} has no ${FOLDER}`));
      assert.equal(existsSync(built.staging), false);
    });
  });

  it("decides by the layout when the stack's history cannot be fetched", () => {
    withMonorepo('stack-build-mono-layout-', (root, repo) => {
      const unreachable = 'f'.repeat(40);

      const old = build(root, repo.stackOld, unreachable, repo.environment);
      assert.equal(old.status, 0, old.stderr);
      assert.equal(readFileSync(join(old.staging, STACK_FOLDER_FILE), 'utf8'), '.\n');

      const other = build(root, repo.adminOnly, unreachable, repo.environment);
      assert.notEqual(other.status, 0);
      assert.equal(existsSync(other.staging), false);
    });
  });

  it('refuses a folder that could leave the tree or be read as an option', () => {
    withMonorepo('stack-build-mono-folder-', (root, repo) => {
      for (const folder of ['../apps', 'apps/../..', '/apps', '-apps', 'apps/', '']) {
        const built = build(root, repo.moved, repo.stackHead, repo.environment, folder);
        assert.equal(built.status, 2, `${JSON.stringify(folder)}: ${built.stderr}`);
        assert.match(built.stderr, /<stack-folder>/);
      }
    });
  });

  /**
   * The build runs the ref's own install and build scripts over the staging
   * tree, so what the script says it exported has to be written after them, as
   * a fresh file: a file they rewrote would give the manager a false commit,
   * and a link they left in its place would carry the write outside the tree.
   */
  it('writes what it exported after the build, so the build cannot change it or write through it', () => {
    withMonorepo('stack-build-mono-hostile-', (root, repo) => {
      const kept = join(root, 'kept.txt');
      writeFileSync(kept, "not the build's to write\n");
      writeFileSync(
        join(root, 'bin', 'docker'),
        [
          '#!/bin/sh',
          'while [ "$#" -gt 0 ]; do if [ "$1" = -w ]; then dir="$2"; fi; shift; done',
          'rm -f "$dir/.stack-commit" "$dir/.stack-folder" "$dir/.stack-toolchain"',
          `ln -s '${kept}' "$dir/.stack-commit"`,
          'printf \'.\\n\' > "$dir/.stack-folder"',
          'printf \'node:0 pnpm@0.0.0\\n\' > "$dir/.stack-toolchain"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

      const built = build(root, repo.moved, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      assert.equal(
        readFileSync(kept, 'utf8'),
        "not the build's to write\n",
        'the write went through a link the build left',
      );
      assert.equal(lstatSync(join(built.staging, STACK_COMMIT_FILE)).isSymbolicLink(), false);
      assert.equal(readFileSync(join(built.staging, STACK_COMMIT_FILE), 'utf8').trim(), repo.moved);
      assert.equal(readFileSync(join(built.staging, STACK_FOLDER_FILE), 'utf8'), `${FOLDER}\n`);
      assert.equal(readFileSync(join(built.staging, STACK_TOOLCHAIN_FILE), 'utf8'), `${BUILD_IMAGE} ${PINNED_PNPM}\n`);
    });
  });

  it('refuses a history head that is not a whole commit', () => {
    withMonorepo('stack-build-mono-head-', (root, repo) => {
      const built = build(root, repo.moved, repo.stackHead.slice(0, 12), repo.environment);

      assert.equal(built.status, 2);
      assert.match(built.stderr, /<history-head>/);
    });
  });

  /**
   * Once the repository is one workspace, the lockfile sits at the root and the
   * stack's folder holds none. The build container is then shown the root's
   * lockfile, workspace file and package.json, the stack's package.json at its
   * place under them, and the commit's own cut tool, in a side folder of the
   * staging tree, and cuts the stack's own lockfile out of the root one before
   * anything is installed. The commit's own tool runs where the commit's other
   * code already runs, in the container that sees the staging tree alone.
   */
  it("builds a commit whose lockfile is at the root with the stack's own cut out of it first, in the container", () => {
    withMonorepo('stack-build-mono-root-lockfile-', (root, repo) => {
      const record = recordingDocker(root);

      const built = build(root, repo.oneWorkspace, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      assert.equal(
        readFileSync(record.command, 'utf8'),
        `node ${WORKSPACE_ROOT_DIR}/tools/app-workspace/cut.mjs --root ${WORKSPACE_ROOT_DIR} --app ${FOLDER} --out . && ` +
          `corepack enable && corepack prepare ${ONE_PNPM} --activate && pnpm install --frozen-lockfile && pnpm -r build\n`,
      );
      assert.deepEqual(readFileSync(record.sideFolder, 'utf8').trim().split('\n'), [
        `${WORKSPACE_ROOT_DIR}/${FOLDER}/package.json`,
        `${WORKSPACE_ROOT_DIR}/package.json`,
        `${WORKSPACE_ROOT_DIR}/pnpm-lock.yaml`,
        `${WORKSPACE_ROOT_DIR}/pnpm-workspace.yaml`,
        `${WORKSPACE_ROOT_DIR}/tools/app-workspace/cut.mjs`,
      ]);
      assert.equal(
        existsSync(join(built.staging, WORKSPACE_ROOT_DIR)),
        false,
        'the side folder is gone before the manager publishes',
      );
      assert.equal(readFileSync(join(built.staging, STACK_TOOLCHAIN_FILE), 'utf8'), `${BUILD_IMAGE} pnpm@11.11.0\n`);
    });
  });

  /**
   * A package every app shares sits under the root's packages/, and the cut
   * copies each one the stack links into the stack's workspace-packages/, so it
   * reads them from the side folder too. The command is the same: only what the
   * side folder holds changes.
   */
  it('shows the cut the packages every app shares when the commit has them, and runs the same command', () => {
    withMonorepo('stack-build-mono-root-packages-', (root, repo) => {
      const record = recordingDocker(root);

      const built = build(root, repo.withPackages, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      assert.equal(
        readFileSync(record.command, 'utf8'),
        `node ${WORKSPACE_ROOT_DIR}/tools/app-workspace/cut.mjs --root ${WORKSPACE_ROOT_DIR} --app ${FOLDER} --out . && ` +
          `corepack enable && corepack prepare ${ONE_PNPM} --activate && pnpm install --frozen-lockfile && pnpm -r build\n`,
      );
      assert.deepEqual(readFileSync(record.sideFolder, 'utf8').trim().split('\n'), [
        `${WORKSPACE_ROOT_DIR}/${FOLDER}/package.json`,
        `${WORKSPACE_ROOT_DIR}/package.json`,
        `${WORKSPACE_ROOT_DIR}/packages/contracts/package.json`,
        `${WORKSPACE_ROOT_DIR}/packages/contracts/src/index.ts`,
        `${WORKSPACE_ROOT_DIR}/pnpm-lock.yaml`,
        `${WORKSPACE_ROOT_DIR}/pnpm-workspace.yaml`,
        `${WORKSPACE_ROOT_DIR}/tools/app-workspace/cut.mjs`,
      ]);
      assert.equal(existsSync(join(built.staging, WORKSPACE_ROOT_DIR)), false, 'the side folder still goes');
    });
  });

  /** The script's own trace of what it archived, which a commit without packages/ must not change. */
  it('archives exactly what it did before for a commit without packages/', () => {
    withMonorepo('stack-build-mono-root-no-packages-', (root, repo) => {
      const traced = spawnSync(
        'bash',
        [
          '-x',
          BUILD_SCRIPT,
          join(root, 'monorepo.repo'),
          join(root, 'staging-traced'),
          repo.oneWorkspace,
          MONOREPO_URL,
          FOLDER,
          repo.stackHead,
          'abcdef01',
        ],
        { env: repo.environment, encoding: 'utf8' },
      );

      assert.equal(traced.status, 0, traced.stderr);
      const archives = traced.stderr.split('\n').filter((line) => /^\++ git -C \S+ archive /.test(line));
      assert.deepEqual(
        archives.map((line) => line.replace(/^\++ git -C \S+ archive \S+/, '')),
        [
          ' -- apps/hls-stream',
          ' -- package.json pnpm-lock.yaml pnpm-workspace.yaml tools/app-workspace apps/hls-stream/package.json',
        ],
      );
    });
  });

  it('builds a monorepo commit whose stack keeps its own lockfile exactly as before', () => {
    withMonorepo('stack-build-mono-own-lockfile-', (root, repo) => {
      const record = recordingDocker(root);

      const built = build(root, repo.moved, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      assert.equal(readFileSync(record.command, 'utf8'), `${TODAYS_BUILD}\n`);
      assert.equal(existsSync(record.sideFolder), false, 'a stack with its own lockfile gets no side folder');
      assert.equal(readFileSync(join(built.staging, STACK_TOOLCHAIN_FILE), 'utf8'), `${BUILD_IMAGE} ${PINNED_PNPM}\n`);
    });
  });

  /**
   * The stack as main-v3 holds it today: its own lockfile, and a pnpm named in
   * its package.json. Nothing is cut. corepack already ran the named pnpm, so
   * the build is the same, and only the pin it activates and the pnpm it
   * records now match the named one, where they said the pinned one before.
   */
  it('builds a stack that keeps its own lockfile and names its pnpm with that pnpm, and cuts nothing', () => {
    withMonorepo('stack-build-mono-own-named-', (root, repo) => {
      const record = recordingDocker(root);

      const built = build(root, repo.ownLockfileNamed, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      assert.equal(
        readFileSync(record.command, 'utf8'),
        `corepack enable && corepack prepare ${ONE_PNPM} --activate && pnpm install --frozen-lockfile && pnpm -r build\n`,
      );
      assert.equal(existsSync(record.sideFolder), false, 'a stack with its own lockfile gets no side folder');
      assert.equal(readFileSync(join(built.staging, STACK_TOOLCHAIN_FILE), 'utf8'), `${BUILD_IMAGE} pnpm@11.11.0\n`);
    });
  });

  it("builds a commit of the stack's own history exactly as before", () => {
    withMonorepo('stack-build-mono-own-history-', (root, repo) => {
      const record = recordingDocker(root);

      const built = build(root, repo.stackOld, repo.stackHead, repo.environment);

      assert.equal(built.status, 0, built.stderr);
      assert.equal(readFileSync(record.command, 'utf8'), `${TODAYS_BUILD}\n`);
      assert.equal(existsSync(record.sideFolder), false);
    });
  });

  it('removes the side folder with the rest of the staging tree when the build fails', () => {
    withMonorepo('stack-build-mono-root-failed-', (root, repo) => {
      const record = recordingDocker(root, 1);

      const built = build(root, repo.oneWorkspace, repo.stackHead, repo.environment);

      assert.notEqual(built.status, 0);
      assert.ok(existsSync(record.sideFolder), 'the failed build ran with the side folder in place');
      assert.equal(existsSync(built.staging), false, 'the staging tree went, the side folder in it');
    });
  });

  it('refuses a commit whose lockfile is at the root but that holds no tools/app-workspace, and runs nothing', () => {
    withMonorepo('stack-build-mono-no-tool-', (root, repo) => {
      const record = recordingDocker(root);

      const built = build(root, repo.noCutTool, repo.stackHead, repo.environment);

      assert.equal(built.status, 2);
      assert.match(built.stderr, /tools\/app-workspace/);
      assert.equal(existsSync(record.command), false, 'nothing of the commit ran');
      assert.equal(existsSync(built.staging), false);
    });
  });

  it('refuses a stack that names a package manager other than a pnpm, and runs nothing', () => {
    withMonorepo('stack-build-mono-yarn-', (root, repo) => {
      const record = recordingDocker(root);

      const built = build(root, repo.yarnNamed, repo.stackHead, repo.environment);

      assert.equal(built.status, 2);
      assert.match(built.stderr, /packageManager/);
      assert.match(built.stderr, /yarn@4\.1\.0/);
      assert.equal(existsSync(record.command), false, 'nothing of the commit ran');
      assert.equal(existsSync(built.staging), false);
    });
  });

  /**
   * Each app names its own pnpm, and the cut refuses one that names none rather
   * than fall back to the root's, which would hide a break of that rule. The
   * build therefore stops in the container, with the cut's own sentence.
   */
  it("stops, with the cut's own refusal, on a commit whose lockfile is at the root and whose stack names no pnpm", () => {
    withMonorepo('stack-build-mono-unnamed-', (root, repo) => {
      runningDocker(root);

      const built = build(root, repo.unnamedStack, repo.stackHead, repo.environment);

      assert.notEqual(built.status, 0);
      assert.match(built.stderr, new RegExp(`${FOLDER}/package\\.json names no packageManager`));
      assert.equal(existsSync(built.staging), false, 'the failed build takes its staging tree with it');
    });
  });

  it('refuses a stack that holds a .workspace-root of its own, where the side folder would go', () => {
    withMonorepo('stack-build-mono-side-taken-', (root, repo) => {
      const record = recordingDocker(root);

      const built = build(root, repo.sideFolderTaken, repo.stackHead, repo.environment);

      assert.equal(built.status, 2);
      assert.match(built.stderr, /\.workspace-root/);
      assert.equal(existsSync(record.command), false, 'nothing of the commit ran');
      assert.equal(existsSync(built.staging), false);
    });
  });
});
