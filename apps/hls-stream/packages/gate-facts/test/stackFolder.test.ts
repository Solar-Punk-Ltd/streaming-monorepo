import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectChecks } from '../src/collectChecks.js';
import { collectDiff } from '../src/collectDiff.js';
import { collectProvenance } from '../src/collectProvenance.js';
import type { Fact, FactGroup } from '../src/types.js';

/** Where the stack sits inside a larger repository, as it does in the monorepo. */
const STACK_SUBFOLDER = 'apps/hls-stream';

/** The branch every fixture's change is measured from, and the head it is measured at. */
const BASE = 'base';
const HEAD = 'HEAD';

/**
 * Who a throwaway commit is by, given here so the fixture commits on a machine with no git identity
 * configured. Each commit also passes `commit.gpgsign=false` for a machine that signs by default.
 */
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'gate facts fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'gate facts fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/** File contents by path, relative to the folder they are written under. */
type FileTree = Readonly<Record<string, string>>;

interface FixtureCommit {
  stack: FileTree;
  /** Written from the root of the larger repository, and only when the stack sits in a subfolder of one. */
  outside: FileTree;
}

interface Fixture {
  repo: string;
  stack: string;
}

/** A pnpm lockfile pinning `specs`, in the shape `lockfileVersions` reads. */
function lockfileOf(specs: readonly string[]): string {
  const entries = specs.flatMap((spec) => [`  ${spec}:`, '    resolution: {integrity: sha512-fixture}', '']);
  return ["lockfileVersion: '9.0'", '', 'packages:', '', ...entries].join('\n');
}

const BASE_COMMIT: FixtureCommit = {
  stack: {
    'pnpm-lock.yaml': lockfileOf(['express@5.2.1', 'left-pad@1.3.0']),
    'packages/stream-uploader/src/engine.ts': "export const engine = 'srs';\n",
    'packages/cli/src/stamp.ts': 'export const stamp = 1;\n',
    'deploy/scripts/clean.sh': 'echo clean\n',
    'README.md': '# The stack\n',
  },
  outside: {
    'apps/web2-admin/src/page.ts': 'export const page = 1;\n',
    'README.md': '# The platform\n',
  },
};

/**
 * The change under measurement. The lockfile drops a package and adds none, so it moves with nothing
 * to look up at the registry. Every commit touches the stack as well as the outside, because the
 * commits row counts every commit in the range: one that touched only the outside would be counted
 * from a subfolder and has no counterpart in a checkout of the stack on its own.
 */
const CHANGE_COMMITS: readonly FixtureCommit[] = [
  {
    stack: {
      'pnpm-lock.yaml': lockfileOf(['express@5.2.1']),
      'packages/stream-uploader/src/engine.ts': "export const engine = 'ome';\n",
    },
    outside: { 'apps/web2-admin/src/page.ts': 'export const page = 2;\n' },
  },
  {
    stack: {
      'packages/cli/src/stamp.ts': [
        'export const stamp = 2;',
        'export const again = 3;',
        'export const thrice = 4;',
        '',
      ].join('\n'),
      'deploy/scripts/clean.sh': 'echo clean all\n',
      'README.md': '# The streaming stack\n',
    },
    outside: { 'README.md': '# The streaming platform\n' },
  },
];

/**
 * What the base gains after the change has branched off it: source and a CI file in the stack, and a
 * file outside it, none of which the change touches.
 */
const BASE_MOVES_ON: FixtureCommit = {
  stack: {
    'packages/audit-gate/src/later.ts': ['export const later = 1;', 'export const laterStill = 2;', ''].join('\n'),
    '.github/workflows/later.yml': 'name: later\n',
  },
  outside: { 'apps/web2-admin/src/later.ts': 'export const later = 1;\n' },
};

/** A change that leaves the lockfile exactly as it was where the change branched off. */
const CHANGE_LEAVING_THE_LOCKFILE: readonly FixtureCommit[] = [
  { stack: { 'packages/stream-uploader/src/engine.ts': "export const engine = 'ome';\n" }, outside: {} },
];

/** The base bumping a package the change never touched, after the change has branched off it. */
const BASE_BUMPS_A_PACKAGE: FixtureCommit = {
  stack: { 'pnpm-lock.yaml': lockfileOf(['express@5.2.2', 'left-pad@1.3.0']) },
  outside: {},
};

const fixtureDirs: string[] = [];

after(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

/** This machine's PATH, which finds git for the fixtures and for the collectors alike. */
const MACHINE_PATH = process.env.PATH ?? '';

/**
 * Stand-ins that print nothing and succeed, for the commands a collector starts besides git. First on
 * PATH, they keep a fixture from running the stack's own scripts or reaching the registry.
 */
function writeStubCommands(names: readonly string[]): string {
  const dir = tempDir('gate-facts-stubs-');
  for (const name of names) {
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return dir;
}

const STUB_BIN = writeStubCommands(['pnpm', 'npm']);

/**
 * One git call in `dir`, trimmed, with PATH and HOME and nothing else of this machine's, so a
 * `GIT_DIR` or `GIT_INDEX_FILE` exported by whatever launched the suite cannot point the fixture's own
 * calls at some other repository. A refusal throws with git's own message on it.
 */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { PATH: MACHINE_PATH, HOME: process.env.HOME, ...FIXTURE_IDENTITY },
    stdio: 'pipe',
  }).trim();
}

function writeTree(root: string, tree: FileTree): void {
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** Writes `change` into the fixture and commits it on whichever branch is checked out. */
function commitChange(fixture: Fixture, change: FixtureCommit, message: string): void {
  writeTree(fixture.stack, change.stack);
  if (fixture.stack !== fixture.repo) {
    writeTree(fixture.repo, change.outside);
  }
  gitIn(fixture.repo, 'add', '-A');
  gitIn(fixture.repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
}

/**
 * A throwaway repository with the stack at `stackPath` inside it: a base commit, a `base` branch on it,
 * and the change on top, which is `CHANGE_COMMITS` unless `changes` names another. An empty `stackPath`
 * is the stack checked out on its own. `rootFiles` go into the base commit at the root of a larger
 * repository and never change.
 */
function commitFixture(
  stackPath: string,
  rootFiles: FileTree = {},
  changes: readonly FixtureCommit[] = CHANGE_COMMITS,
): Fixture {
  const repo = tempDir('gate-facts-repo-');
  const fixture = { repo, stack: join(repo, stackPath) };

  gitIn(repo, 'init', '-q');
  writeTree(repo, rootFiles);
  commitChange(fixture, BASE_COMMIT, 'base');
  gitIn(repo, 'branch', BASE);
  changes.forEach((change, index) => commitChange(fixture, change, `change ${index + 1}`));
  return fixture;
}

/**
 * Commits `change` onto the base after the change under measurement has branched off it, the way the
 * base moves on while a pull request is open, then checks the change out again.
 */
function moveBaseOn(fixture: Fixture, change: FixtureCommit = BASE_MOVES_ON): void {
  const changeBranch = gitIn(fixture.repo, 'branch', '--show-current');
  gitIn(fixture.repo, 'switch', '-q', BASE);
  commitChange(fixture, change, 'the base moves on');
  gitIn(fixture.repo, 'switch', '-q', changeBranch);
}

/**
 * Leaves the base only as `origin/base`, which is how a single-branch clone, a CI checkout or a worktree
 * holds it: no local branch of that name exists.
 */
function keepBaseOnlyAsRemote(fixture: Fixture): void {
  gitIn(fixture.repo, 'update-ref', `refs/remotes/origin/${BASE}`, BASE);
  gitIn(fixture.repo, 'branch', '-D', BASE);
}

/**
 * Runs a collector the way `pnpm gate:facts` runs it: from the stack's folder, which every command a
 * collector starts takes as its working directory. node:test runs a file's tests one at a time, so the
 * change of directory cannot reach another test.
 */
async function collectFrom<T>(folder: string, collect: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  process.chdir(folder);
  process.env.PATH = [STUB_BIN, MACHINE_PATH].join(delimiter);
  try {
    return await collect();
  } finally {
    process.chdir(cwd);
    process.env.PATH = MACHINE_PATH;
  }
}

/** Each row's value by its key, which is what a reader of the artifact compares. */
function valuesByKey(group: FactGroup): Record<string, string> {
  return Object.fromEntries(group.facts.map((fact) => [fact.key, fact.value]));
}

function failedKeys(group: FactGroup): string[] {
  return group.facts.filter((fact) => fact.failed).map((fact) => fact.key);
}

function rowNamed(group: FactGroup, key: string): Fact {
  const row = group.facts.find((fact) => fact.key === key);
  assert.ok(row, `the ${group.title} group has no ${key} row`);
  return row;
}

/** The tool's own entry point, which `pnpm gate:facts` runs through tsx. */
const ENTRY_POINT = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/** Found from this package, because a fixture folder has no node_modules to find tsx in. */
const TSX_LOADER = import.meta.resolve('tsx');

interface ToolRun {
  stdout: string;
  stderr: string;
}

/**
 * Runs the whole tool from `folder` as `pnpm gate:facts` runs it, with the stand-ins first on PATH. Of
 * this machine's environment only PATH and HOME reach it, for the reason `gitIn` gives, and tsx's cache
 * stays off as the suite's own test script has it.
 */
function runGateFacts(folder: string, args: readonly string[]): ToolRun {
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, ENTRY_POINT, ...args], {
    cwd: folder,
    encoding: 'utf8',
    env: { PATH: [STUB_BIN, MACHINE_PATH].join(delimiter), HOME: process.env.HOME, TSX_DISABLE_CACHE: '1' },
  });
  if (result.error) {
    throw result.error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/** The artifact's table row for `key`, as a reader of the printed artifact sees it. */
function artifactRow(run: ToolRun, key: string): string {
  const row = run.stdout.split('\n').find((line) => line.startsWith(`| ${key} |`));
  assert.ok(row, `the artifact has no ${key} row, and the tool wrote this to stderr:\n${run.stderr}`);
  return row;
}

/**
 * ⛔⛔ What a path means to git depends on where it is asked from, and the stack no longer sits at the
 * root of its repository. A path after `<ref>:` is read from the repository root, `git diff` names
 * every path in the repository from that root, and `git status` covers the whole repository. All three
 * agree with the stack's folder for a checkout of the stack on its own, and part ways once it sits in a
 * subfolder of a larger repository, as it does under apps/hls-stream in the monorepo.
 *
 * So each collector runs against a real git in throwaway repositories: a checkout of the stack on its
 * own, which must keep the facts it gets today, and the same stack under apps/hls-stream of a larger
 * repository that changes files outside it, which must give the same facts and nothing from outside.
 */
describe('the diff facts read by a real git, wherever the stack sits', () => {
  const diffFrom = (fixture: Fixture) => collectFrom(fixture.stack, () => collectDiff(BASE, HEAD));

  it('gives a checkout of the stack on its own the facts it gave before', async () => {
    const diff = await diffFrom(commitFixture(''));

    assert.deepEqual(valuesByKey(diff), {
      'files changed': '5',
      commits: '2',
      'src lines changed': '6',
      'surfaces touched': '4 (deploy, src, config, docs)',
      'mutation check': 'applies',
      'source with no mutation harness': '1: packages/cli/src/stamp.ts',
    });
    assert.deepEqual(failedKeys(diff), []);
  });

  it('gives the same facts from the stack folder of a larger repository, and nothing from outside it', async () => {
    const nested = commitFixture(STACK_SUBFOLDER);
    const changedOutside = gitIn(nested.repo, 'diff', '--name-only', `${BASE}..${HEAD}`)
      .split('\n')
      .filter((path) => !path.startsWith(`${STACK_SUBFOLDER}/`));
    assert.notDeepEqual(changedOutside, [], 'the fixture has to change files outside the stack for this case to see');

    assert.deepEqual(await diffFrom(nested), await diffFrom(commitFixture('')));
  });

  it('counts only the change once the base has moved on past the point the change branched from', async () => {
    const movedOn = commitFixture(STACK_SUBFOLDER);
    moveBaseOn(movedOn);
    assert.notEqual(
      gitIn(movedOn.stack, 'diff', '--name-only', '--relative', `${HEAD}...${BASE}`),
      '',
      'the fixture has to be one where the base changed files in the stack after the change branched off it',
    );

    // The commits row is held to the same count: the base's own commit is not the change's.
    assert.deepEqual(await diffFrom(movedOn), await diffFrom(commitFixture('')));
  });
});

describe('the provenance facts read by a real git, wherever the stack sits', () => {
  const provenanceFrom = (fixture: Fixture) => collectFrom(fixture.stack, () => collectProvenance(BASE, HEAD));

  /** The row every provenance group starts with, whose value is what a reader of the artifact compares. */
  const introducedRow = async (fixture: Fixture) => {
    const group = await provenanceFrom(fixture);
    assert.ok(group, 'the change moved a lockfile, so there is a provenance group');
    return rowNamed(group, 'versions introduced');
  };

  it('reads the lockfile of a checkout of the stack on its own as before', async () => {
    assert.deepEqual(await provenanceFrom(commitFixture('')), {
      title: 'Provenance of introduced versions',
      facts: [
        {
          key: 'versions introduced',
          value: '0, though the lockfile did change. Nothing new resolved, so there is nothing to check.',
          command: `git diff ${BASE}...${HEAD} -- :/pnpm-lock.yaml`,
        },
      ],
    });
  });

  it("reads the stack's own lockfile from the stack folder of a larger repository", async () => {
    const nested = commitFixture(STACK_SUBFOLDER);
    const standalone = await introducedRow(commitFixture(''));

    const row = await introducedRow(nested);

    assert.equal(row.value, standalone.value);
    assert.equal(row.command, `git diff ${BASE}...${HEAD} -- :/${STACK_SUBFOLDER}/pnpm-lock.yaml`);
  });

  it('reads every lockfile of the repository, and one the change left alone introduces nothing', async () => {
    const nested = commitFixture(STACK_SUBFOLDER, { 'pnpm-lock.yaml': lockfileOf(['react@19.0.0']) });
    assert.equal(
      gitIn(nested.repo, 'show', `${HEAD}:pnpm-lock.yaml`),
      gitIn(nested.repo, 'show', `${BASE}:pnpm-lock.yaml`),
      "the fixture's root lockfile has to be there and unchanged while the stack's moves",
    );
    const standalone = await introducedRow(commitFixture(''));

    const row = await introducedRow(nested);

    assert.equal(row.value, standalone.value);
    assert.equal(row.command, `git diff ${BASE}...${HEAD} -- :/${STACK_SUBFOLDER}/pnpm-lock.yaml :/pnpm-lock.yaml`);
  });

  it("counts a version the change brings into another app's lockfile, which the dependency rule covers too", async () => {
    const adminLockfile = 'apps/web2-admin/pnpm-lock.yaml';
    const nested = commitFixture(STACK_SUBFOLDER, { [adminLockfile]: lockfileOf(['react@19.0.0']) }, [
      ...CHANGE_COMMITS,
      { stack: {}, outside: { [adminLockfile]: lockfileOf(['react@19.0.0', 'react-dom@19.0.0']) } },
    ]);

    assert.equal((await introducedRow(nested)).value, '1');
  });

  it('introduces nothing when the apps own lockfiles become one at the root holding the same versions', async () => {
    const adminLockfile = 'apps/web2-admin/pnpm-lock.yaml';
    const stackLockfile = `${STACK_SUBFOLDER}/pnpm-lock.yaml`;
    const nested = commitFixture(STACK_SUBFOLDER, { [adminLockfile]: lockfileOf(['react@19.0.0']) }, []);
    rmSync(join(nested.repo, adminLockfile));
    rmSync(join(nested.repo, stackLockfile));
    writeTree(nested.repo, { 'pnpm-lock.yaml': lockfileOf(['express@5.2.1', 'left-pad@1.3.0', 'react@19.0.0']) });
    gitIn(nested.repo, 'add', '-A');
    gitIn(nested.repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one workspace at the root');

    const row = await introducedRow(nested);

    assert.equal(row.value, '0, though the lockfile did change. Nothing new resolved, so there is nothing to check.');
    assert.equal(row.command, `git diff ${BASE}...${HEAD} -- :/${stackLockfile} :/${adminLockfile} :/pnpm-lock.yaml`);
  });

  it('reports no version introduced when only the base bumped a package after the branch point', async () => {
    const nested = commitFixture(STACK_SUBFOLDER, {}, CHANGE_LEAVING_THE_LOCKFILE);
    moveBaseOn(nested, BASE_BUMPS_A_PACKAGE);
    assert.notEqual(
      gitIn(nested.stack, 'show', `${BASE}:./pnpm-lock.yaml`),
      gitIn(nested.stack, 'show', `${HEAD}:./pnpm-lock.yaml`),
      "the fixture's base has to hold a lockfile the change never had",
    );

    // No group at all, which is how the artifact says the change left the lockfile untouched.
    assert.equal(await provenanceFrom(nested), null);
  });
});

describe('the working tree row read by a real git, wherever the stack sits', () => {
  const checksFrom = (fixture: Fixture) => collectFrom(fixture.stack, () => collectChecks(fixture.stack));
  const editStackReadme = (fixture: Fixture) => writeFileSync(join(fixture.stack, 'README.md'), '# An edit\n');
  const editOutside = (fixture: Fixture) => {
    writeFileSync(join(fixture.repo, 'apps/web2-admin/src/page.ts'), 'export const page = 3;\n');
    writeFileSync(join(fixture.repo, 'stray.txt'), 'untracked\n');
  };

  it('calls a checkout of the stack on its own clean, and dirty once a tracked file in it changes', async () => {
    const standalone = commitFixture('');
    const clean = rowNamed(await checksFrom(standalone), 'working tree');
    assert.deepEqual({ value: clean.value, failed: clean.failed }, { value: 'clean', failed: false });

    editStackReadme(standalone);
    const dirty = rowNamed(await checksFrom(standalone), 'working tree');

    assert.match(dirty.value, /^DIRTY/);
    assert.equal(dirty.failed, true);
  });

  it('calls the stack clean from a subfolder when only files outside it changed', async () => {
    const nested = commitFixture(STACK_SUBFOLDER);
    editOutside(nested);
    assert.notEqual(gitIn(nested.repo, 'status', '--porcelain'), '', 'the fixture has to be dirty outside the stack');

    assert.deepEqual(await checksFrom(nested), await checksFrom(commitFixture('')));
  });

  it('still calls the stack dirty from a subfolder when a file inside it changed', async () => {
    const standalone = commitFixture('');
    const nested = commitFixture(STACK_SUBFOLDER);
    editStackReadme(standalone);
    editStackReadme(nested);
    editOutside(nested);

    assert.deepEqual(await checksFrom(nested), await checksFrom(standalone));
  });
});

/**
 * The diff and the lockfile have to be read from one base. The diff falls back to `origin/<base>` when
 * no local branch of that name exists, and the lockfile read took the name as given, so in exactly the
 * checkouts that fallback exists for the run stopped at "invalid object name" and printed nothing.
 */
describe('the whole tool run by a real git, where the base exists only as origin/base', () => {
  it('reads the lockfile from the same origin/base the diff is measured from', () => {
    const fixture = commitFixture(STACK_SUBFOLDER);
    keepBaseOnlyAsRemote(fixture);
    assert.throws(
      () => gitIn(fixture.stack, 'show', `${BASE}:./pnpm-lock.yaml`),
      /invalid object name/,
      'the fixture has to be one where the base name alone names no commit',
    );
    const head = gitIn(fixture.stack, 'rev-parse', '--short', HEAD);

    const run = runGateFacts(fixture.stack, ['--base', BASE]);

    assert.equal(
      artifactRow(run, 'versions introduced'),
      `| versions introduced | 0, though the lockfile did change. Nothing new resolved, so there is nothing to check. | \`git diff origin/${BASE}...${head} -- :/${STACK_SUBFOLDER}/pnpm-lock.yaml\` |`,
    );
    assert.equal(artifactRow(run, 'commits'), `| commits | 2 | \`git rev-list --count origin/${BASE}..${head}\` |`);
  });
});
