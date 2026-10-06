import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  type ClientShapeExpectation,
  clientShapeRefusal,
  clientShapeSummary,
  EXPECT_CLIENT_DIRTY,
  EXPECT_CLIENT_TREE,
  EXPECT_CONTRACTS_TREE,
  EXPECT_SWARM_WINDOWS_TREE,
  EXPECT_SHARED_TREE,
  parseClientBuildStamp,
  readClientShapeExpectation,
  readGitClientTrees,
} from '../src/clientShape.js';

/**
 * ⛔ Every case here is the client-side twin of the 2026-09-01 uploader sitting. `bench-on-host.sh`
 * syncs the harness checkout to the host on every run and never rebuilds the client image, so the
 * harness can parse a client that is weeks older than itself and nothing notices.
 */

const CLIENT_TREE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHARED_TREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HEAD = 'cccccccccccccccccccccccccccccccccccccccc';
const CONTRACTS_TREE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SWARM_WINDOWS_TREE = 'f'.repeat(40);

const EXPECTED: ClientShapeExpectation = {
  clientTree: CLIENT_TREE,
  sharedTree: SHARED_TREE,
  contractsTree: CONTRACTS_TREE,
  swarmWindowsTree: SWARM_WINDOWS_TREE,
  dirty: false,
  source: 'the run script',
};

function stamp(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    clientTree: CLIENT_TREE,
    sharedTree: SHARED_TREE,
    contractsTree: CONTRACTS_TREE,
    swarmWindowsTree: SWARM_WINDOWS_TREE,
    head: HEAD,
    dirty: false,
    builtAt: '2026-09-03T10:00:00Z',
    fetchBackend: '',
    exposePlayer: '',
    ...overrides,
  });
}

describe('reading the stamp a served client carries', () => {
  it('reads back everything the image wrote', () => {
    const parsed = parseClientBuildStamp(stamp());

    assert.equal(parsed?.clientTree, CLIENT_TREE);
    assert.equal(parsed?.sharedTree, SHARED_TREE);
    assert.equal(parsed?.contractsTree, CONTRACTS_TREE);
    assert.equal(parsed?.head, HEAD);
    assert.equal(parsed?.dirty, false);
    assert.equal(parsed?.builtAt, '2026-09-03T10:00:00Z');
  });

  /**
   * The SPA fallback answers a missing file with the app's own HTML at 200, so an unstamped client
   * does not 404, it returns a page. That has to read as no stamp rather than as a parse crash.
   */
  it('treats the app index answering instead of a stamp as no stamp', () => {
    assert.equal(parseClientBuildStamp('<!doctype html><html><body>app</body></html>'), null);
  });

  it('treats an empty body as no stamp', () => {
    assert.equal(parseClientBuildStamp(''), null);
  });

  /** An image built before the stamp named the contracts package, read the way a missing shared tree is. */
  it('reads a stamp with no contracts tree as an empty one', () => {
    const parsed = parseClientBuildStamp(stamp({ contractsTree: undefined }));

    assert.equal(parsed?.contractsTree, '');
    assert.equal(parsed?.clientTree, CLIENT_TREE);
  });

  /** An image built by a deploy script that passes none of the args writes exactly this. */
  it('treats a stamp with an empty client tree as no stamp', () => {
    assert.equal(parseClientBuildStamp(stamp({ clientTree: '' })), null);
  });

  /**
   * ⭐ The stamp is going to grow. A gate that refused an unknown key would turn every future
   * addition into a redeploy of every stage before the suite could run at all.
   */
  it('accepts a stamp carrying keys this harness has never heard of', () => {
    const parsed = parseClientBuildStamp(stamp({ ladderRungs: 4, builtBy: 'someone' }));

    assert.equal(parsed?.clientTree, CLIENT_TREE);
  });
});

describe('where the expectation comes from', () => {
  const fromGit = () => ({
    clientTree: 'g'.repeat(40),
    sharedTree: 'h'.repeat(40),
    contractsTree: 'i'.repeat(40),
    swarmWindowsTree: 'j'.repeat(40),
    dirty: false,
  });

  /**
   * ⛔ The run script wins, because it is the only side that can be right on the host: the rsync
   * excludes `.git`, so a harness there has no history to ask and a git answer would be absent
   * rather than wrong.
   */
  it('prefers what the run script measured on the operator machine', () => {
    const expectation = readClientShapeExpectation(
      {
        [EXPECT_CLIENT_TREE]: CLIENT_TREE,
        [EXPECT_SHARED_TREE]: SHARED_TREE,
        [EXPECT_CONTRACTS_TREE]: CONTRACTS_TREE,
        [EXPECT_CLIENT_DIRTY]: '0',
      },
      fromGit,
    );

    assert.equal(expectation?.clientTree, CLIENT_TREE);
    assert.equal(expectation?.contractsTree, CONTRACTS_TREE);
    assert.equal(expectation?.source, 'the run script');
  });

  /** A run script from before the contracts tree passes none, read the way a missing shared tree is. */
  it('expects an empty contracts tree when the run script passed none', () => {
    const expectation = readClientShapeExpectation(
      { [EXPECT_CLIENT_TREE]: CLIENT_TREE, [EXPECT_SHARED_TREE]: SHARED_TREE, [EXPECT_CLIENT_DIRTY]: '0' },
      fromGit,
    );

    assert.equal(expectation?.contractsTree, '');
  });

  it('falls back to this checkout own git when the run script said nothing', () => {
    const expectation = readClientShapeExpectation({}, fromGit);

    assert.equal(expectation?.clientTree, 'g'.repeat(40));
    assert.equal(expectation?.contractsTree, 'i'.repeat(40));
    assert.equal(expectation?.source, 'this checkout');
  });

  /** An empty variable is an unanswered question, not an expectation of an empty tree. */
  it('treats a blank run-script value as absent', () => {
    const expectation = readClientShapeExpectation(
      { [EXPECT_CLIENT_TREE]: '', [EXPECT_SHARED_TREE]: '', [EXPECT_CLIENT_DIRTY]: '0' },
      fromGit,
    );

    assert.equal(expectation?.source, 'this checkout');
  });

  it('takes a dirty run-script flag as dirty', () => {
    const expectation = readClientShapeExpectation(
      { [EXPECT_CLIENT_TREE]: CLIENT_TREE, [EXPECT_SHARED_TREE]: SHARED_TREE, [EXPECT_CLIENT_DIRTY]: '1' },
      fromGit,
    );

    assert.equal(expectation?.dirty, true);
  });

  it('has no expectation when neither side can answer', () => {
    assert.equal(
      readClientShapeExpectation({}, () => null),
      null,
    );
  });
});

describe('refusing a stage whose served client is not this checkout', () => {
  it('passes a client built from the sources this harness was checked out with', () => {
    assert.equal(clientShapeRefusal(EXPECTED, stamp()), null);
  });

  /**
   * ⛔⛔ An unknown expectation is the case that must NOT pass. It is what a run launched outside
   * both paths looks like, and passing it would leave the gate green on every stage it cannot judge,
   * which is the vacuous-green failure this repo has paid for elsewhere.
   */
  it('refuses when it has no expectation to measure against', () => {
    const refusal = clientShapeRefusal(null, stamp());

    assert.ok(refusal, 'a run with no expectation was measured against nothing and passed');
    assert.match(refusal, /E2E_EXPECT_CLIENT_TREE/);
    assert.match(refusal, /E2E_EXPECT_CONTRACTS_TREE/);
    assert.match(refusal, /bench-on-host\.sh/);
  });

  it('refuses a client serving no stamp, and names redeploying it as the fix', () => {
    const refusal = clientShapeRefusal(EXPECTED, '<!doctype html>');

    assert.ok(refusal);
    assert.match(refusal, /predates/);
    assert.match(refusal, /deploy\.sh/);
    assert.match(refusal, /client/);
  });

  it('refuses a stale client bundle', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ clientTree: 'd'.repeat(40) }));

    assert.ok(refusal, 'a client built from other sources was accepted');
    assert.match(refusal, /stale/);
  });

  /**
   * ⛔ The shared package is compiled into the bundle by vite, so a change there reaches a viewer
   * with the client sources untouched. Reading only the client tree would miss half the drift.
   */
  it('refuses a client built against a stale shared package', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ sharedTree: 'd'.repeat(40) }));

    assert.ok(refusal, 'a bundle compiled from other shared sources was accepted');
    assert.match(refusal, /stale/);
  });

  /**
   * ⛔ The contracts package reaches the bundle through the shared package, which re-exports it, so a
   * change there alone reaches a viewer with both the client and shared trees untouched.
   */
  it('refuses a client built against a stale contracts package, and names those sources', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ contractsTree: 'd'.repeat(40) }));

    assert.ok(refusal, 'a bundle compiled from other contracts sources was accepted');
    assert.match(refusal, /stale/);
    assert.match(refusal, /contracts sources: serving d{40}/);
    assert.match(refusal, new RegExp(CONTRACTS_TREE));
  });

  /**
   * What an image from before the contracts tree meets: its stamp has no such key, which reads as an
   * empty tree, and that differs from any expectation that names one, exactly as for the shared tree.
   */
  /** The window convention reaches the bundle through the shared package the same way the contracts do. */
  it('refuses a client built against a stale swarm-windows package, and names those sources', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ swarmWindowsTree: 'd'.repeat(40) }));

    assert.ok(refusal, 'a bundle compiled from other window sources was accepted');
    assert.match(refusal, /swarm-windows sources: serving d{40}/);
  });

  it('reads the swarm-windows tree the run script measured', () => {
    const expectation = readClientShapeExpectation(
      { [EXPECT_CLIENT_TREE]: CLIENT_TREE, [EXPECT_SWARM_WINDOWS_TREE]: SWARM_WINDOWS_TREE },
      () => null,
    );

    assert.equal(expectation?.swarmWindowsTree, SWARM_WINDOWS_TREE);
  });

  it('refuses a stamp with no contracts tree against an expectation that names one', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ contractsTree: undefined }));

    assert.ok(refusal, 'a stamp predating the contracts tree was accepted against one');
    assert.match(refusal, /stale/);
  });

  it('passes a stamp with no contracts tree where the expectation names none either', () => {
    assert.equal(clientShapeRefusal({ ...EXPECTED, contractsTree: '' }, stamp({ contractsTree: undefined })), null);
  });

  /** A refusal that does not print both hashes cannot be acted on without a second investigation. */
  it('prints what it found beside what it wanted, with the head and the build time', () => {
    const refusal = String(clientShapeRefusal(EXPECTED, stamp({ clientTree: 'd'.repeat(40) })));

    assert.match(refusal, new RegExp('d'.repeat(40)), 'the served hash is not in the refusal');
    assert.match(refusal, new RegExp(CLIENT_TREE), 'the wanted hash is not in the refusal');
    assert.match(refusal, new RegExp(HEAD), 'the head the client was built at is not in the refusal');
    assert.match(refusal, /2026-09-03T10:00:00Z/, 'the build time is not in the refusal');
  });

  /**
   * ⛔ A tree hash names a commit, so a build from uncommitted sources carries a hash describing
   * something other than what was built. The hashes can match exactly and mean nothing.
   */
  it('refuses a client built from uncommitted sources even when the hashes agree', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ dirty: true }));

    assert.ok(refusal, 'a build from uncommitted sources was accepted on a matching hash');
    assert.match(refusal, /uncommitted/);
  });

  it('refuses when the harness itself was synced from uncommitted sources', () => {
    const refusal = clientShapeRefusal({ ...EXPECTED, dirty: true }, stamp());

    assert.ok(refusal, 'an expectation from uncommitted sources was treated as an expectation');
    assert.match(refusal, /uncommitted/);
  });

  it('names committing or stashing as the fix for a dirty build', () => {
    assert.match(String(clientShapeRefusal(EXPECTED, stamp({ dirty: true }))), /commit or stash/);
  });

  it('names the contracts package among the sources a dirty build came from', () => {
    assert.match(String(clientShapeRefusal(EXPECTED, stamp({ dirty: true }))), /`packages\/contracts`/);
  });
});

describe('what a passing gate reports', () => {
  it('names every tree and when the client was built', () => {
    const summary = clientShapeSummary(EXPECTED, parseClientBuildStamp(stamp()));

    assert.match(summary, new RegExp(CLIENT_TREE.slice(0, 12)));
    assert.match(summary, new RegExp(SHARED_TREE.slice(0, 12)));
    assert.match(summary, new RegExp(CONTRACTS_TREE.slice(0, 12)));
    assert.match(summary, /2026-09-03T10:00:00Z/);
  });
});

/** Where the stack sits inside the one workspace in these fixtures. */
const STACK_SUBFOLDER = 'apps/hls-stream';

/** The package at the workspace root the stack's shared package re-exports. */
const CONTRACTS_PACKAGE = 'packages/contracts';

/**
 * Who a throwaway commit is by, so the fixture commits on a machine with no git identity configured.
 * PATH and HOME and nothing else of this machine's, so a `GIT_DIR` exported by whatever launched the
 * suite cannot point these calls at another repository.
 */
const FIXTURE_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_AUTHOR_NAME: 'client shape fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'client shape fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const fixtureDirs: string[] = [];

after(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: FIXTURE_ENV, stdio: 'pipe' }).trim();
}

function writeSource(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A throwaway checkout of the one workspace, the stack at {@link STACK_SUBFOLDER} and, unless
 * `contracts` is false, the contracts package at the root, committed once.
 */
function commitWorkspace({ contracts = true } = {}): { repo: string; stack: string } {
  const repo = mkdtempSync(join(tmpdir(), 'client-shape-workspace-'));
  fixtureDirs.push(repo);
  const stack = join(repo, STACK_SUBFOLDER);
  writeSource(join(stack, 'packages/client/src/index.ts'), 'export const client = 1;\n');
  writeSource(join(stack, 'packages/shared/src/index.ts'), 'export const shared = 1;\n');
  if (contracts) {
    writeSource(join(repo, CONTRACTS_PACKAGE, 'src/index.ts'), 'export const contract = 1;\n');
  }
  gitIn(repo, 'init', '-q');
  gitIn(repo, 'add', '-A');
  gitIn(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  return { repo, stack };
}

/**
 * ⛔ The side a run from a checkout takes. The stack trees are read from the stack's folder and the
 * contracts tree from the repository root, where the one workspace keeps the package, so both halves
 * need a real git in a checkout shaped like that one to say anything.
 */
describe('the trees a checkout expects, read by a real git', () => {
  it('reads the contracts tree from the repository root, beside the stack trees', () => {
    const { repo, stack } = commitWorkspace();

    const trees = readGitClientTrees(stack);

    assert.equal(trees?.contractsTree, gitIn(repo, 'rev-parse', `HEAD:${CONTRACTS_PACKAGE}`));
    assert.equal(trees?.clientTree, gitIn(repo, 'rev-parse', `HEAD:${STACK_SUBFOLDER}/packages/client`));
    assert.equal(trees?.sharedTree, gitIn(repo, 'rev-parse', `HEAD:${STACK_SUBFOLDER}/packages/shared`));
    assert.equal(trees?.dirty, false);
  });

  it('expects an empty contracts tree from a commit that has no contracts package', () => {
    const { stack } = commitWorkspace({ contracts: false });

    const trees = readGitClientTrees(stack);

    assert.equal(trees?.contractsTree, '');
    assert.notEqual(trees?.clientTree, '', 'the stack trees are read all the same');
  });

  it('counts an uncommitted change under the contracts package as dirty', () => {
    const { repo, stack } = commitWorkspace();
    writeFileSync(join(repo, CONTRACTS_PACKAGE, 'src/index.ts'), 'export const contract = 2;\n');

    assert.equal(readGitClientTrees(stack)?.dirty, true);
  });

  it('has no trees to offer outside a checkout', () => {
    const exported = mkdtempSync(join(tmpdir(), 'client-shape-export-'));
    fixtureDirs.push(exported);

    assert.equal(readGitClientTrees(exported, { ...process.env, GIT_CEILING_DIRECTORIES: dirname(exported) }), null);
  });
});
