/**
 * The release each build of the stack is made as, and where the manager
 * answers it: the label the manager was deployed with for the bundled
 * version, the tag on the commit for one an operator added, kept in the
 * build's own manifest and answered with the versions list.
 *
 * Unit test over the in-memory versions table, a scratch versions root and a
 * scratch clone for each added version. The build script is stood in for: the
 * test puts what it would leave in the staging directory. `pnpm test` in
 * manager/.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import type { StackVersion } from '@streaming-infra-manager/common';

import { EventBus } from '../../src/domain/EventBus.js';
import { MANAGER_VERSION_VARIABLE } from '../../src/domain/versions/buildLabel.js';
import {
  BUILD_COMPLETE_MARKER,
  BUILD_MANIFEST_FILE,
  readBuildManifest,
} from '../../src/domain/versions/buildManifest.js';
import { labelOfRoot } from '../../src/domain/versions/buildReferences.js';
import { commitHostConfig } from '../../src/domain/versions/hostConfigCapture.js';
import { buildDirFor, configRootFor, repoRootFor, stagingDirFor } from '../../src/domain/versions/stackPaths.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';
import { scratchRepo, type ScratchRepo } from '../support/scratchGit.js';
import { leaveBuildMarkers, V3_FIXTURE } from '../support/stackFixtures.js';

// The machine's own git configuration stays out of the git the service starts
// in a clone, as it stays out of the git this file starts.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const DEPLOYED_WITH = process.env[MANAGER_VERSION_VARIABLE];
const scratch: string[] = [];
after(() => {
  if (DEPLOYED_WITH === undefined) delete process.env[MANAGER_VERSION_VARIABLE];
  else process.env[MANAGER_VERSION_VARIABLE] = DEPLOYED_WITH;
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const PIN = 'c'.repeat(40);
const NEXT_PIN = 'd'.repeat(40);

let versionsRoot: string;
let legacyRoot: string;
let repository: InMemoryStackVersionRepository;
let runner: FakeScriptSpawner;
let service: StackVersionService;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'stack-release-'));
  scratch.push(root);
  versionsRoot = join(root, 'versions');
  mkdirSync(versionsRoot, { recursive: true });
  // The tree the manager ships with, which only the bundled version reads.
  legacyRoot = join(root, 'manager', 'swarm-hls-stream');
  cpSync(V3_FIXTURE, legacyRoot, { recursive: true });
  repository = new InMemoryStackVersionRepository();
  repository.seedBundled();
  runner = new FakeScriptSpawner();
  service = new StackVersionService(
    repository,
    runner,
    new EventBus(),
    versionsRoot,
    { openReferences: async () => [] },
    legacyRoot,
  );
  delete process.env[MANAGER_VERSION_VARIABLE];
});

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle();
  }
}

/** The clone the build script fetches an added version into, with history and tags of the test's making. */
function cloneOf(name: string): ScratchRepo {
  return scratchRepo(repoRootFor(versionsRoot, name));
}

/** What the build script leaves in the newest attempt's staging directory when it built `commit`, then the run ending. */
async function buildSucceeds(name: string, commit: string): Promise<void> {
  const staging = stagingDirFor(versionsRoot, name, runner.last.args.at(-1)!);
  cpSync(V3_FIXTURE, staging, { recursive: true });
  leaveBuildMarkers(staging, commit);
  runner.finish(0);
  await until(`${name} to settle`, async () => (await repository.findByName(name))?.status !== 'building');
}

async function added(name: string, commit: string): Promise<number> {
  await service.add(name, 'main');
  await buildSucceeds(name, commit);
  const row = await repository.findByName(name);
  assert.ok(row, `${name} exists`);
  assert.equal(row.status, 'ready', row.lastError ?? '');
  return row.id;
}

async function listed(name: string): Promise<StackVersion> {
  const row = (await service.list()).find((version) => version.name === name);
  assert.ok(row, `${name} is listed`);
  return row;
}

function manifestOf(name: string, buildId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(buildDirFor(versionsRoot, name, buildId), BUILD_MANIFEST_FILE), 'utf8'));
}

/** A settings change, so the next build of the same commit is a build of its own. */
async function changeSettings(name: string, line: string): Promise<void> {
  const configRoot = configRootFor(versionsRoot, name);
  await commitHostConfig(configRoot, {
    '.env': Buffer.from(`${readFileSync(join(configRoot, '.env'), 'utf8')}${line}\n`),
  });
}

function pinned(commit: string): void {
  writeFileSync(join(dirname(legacyRoot), '.stack-commit'), `${commit}\n`);
}

describe("the release an added version's build is made as", () => {
  it("is the tag on the commit it built, read in the version's own clone, and the versions list answers it", async () => {
    const clone = cloneOf('review-stack');
    clone.annotatedTag('QA-build-2026-10-07');
    const commit = clone.head();

    await added('review-stack', commit);

    assert.equal(manifestOf('review-stack', commit).label, 'QA-build-2026-10-07');
    assert.equal((await listed('review-stack')).buildLabel, 'QA-build-2026-10-07');
    assert.equal((await listed('bundled')).buildLabel, null, 'a version with no build of its own answers none');
  });

  it('is the nearest tag and how far past it the commit is, for a branch past its last tag', async () => {
    const clone = cloneOf('review-stack');
    clone.annotatedTag('QA-build-2026-10-07');
    clone.commit('two');
    const commit = clone.commit('three');

    await added('review-stack', commit);

    assert.equal((await listed('review-stack')).buildLabel, 'QA-build-2026-10-07+2');
  });

  it('is nothing for a commit no tag is behind, and the build publishes all the same', async () => {
    const clone = cloneOf('review-stack');
    const commit = clone.head();

    await added('review-stack', commit);

    assert.equal('label' in manifestOf('review-stack', commit), false, 'the manifest says nothing rather than null');
    assert.equal((await listed('review-stack')).buildLabel, null);
  });

  it('is nothing when the clone cannot name the commit, and the build publishes all the same', async () => {
    cloneOf('review-stack').annotatedTag('QA-build-2026-10-07');
    const elsewhere = 'f'.repeat(40);

    await added('review-stack', elsewhere);

    assert.equal((await repository.findByName('review-stack'))?.buildId, elsewhere);
    assert.equal((await listed('review-stack')).buildLabel, null);
  });

  it('is nothing for a version with no clone to read', async () => {
    await added('review-stack', 'a'.repeat(40));

    assert.equal((await listed('review-stack')).buildLabel, null);
  });

  it('stays what a build was made as when an Update adopts that build, and a new build of the commit reads it again', async () => {
    const clone = cloneOf('review-stack');
    clone.annotatedTag('QA-build-2026-10-07');
    const commit = clone.head();
    const id = await added('review-stack', commit);
    clone.annotatedTag('QA-build-2026-10-08');

    await service.update(id);
    await buildSucceeds('review-stack', commit);

    assert.equal((await repository.findByName('review-stack'))?.buildId, commit, 'the complete build it already had');
    assert.equal((await listed('review-stack')).buildLabel, 'QA-build-2026-10-07');

    await changeSettings('review-stack', 'CHEQUEBOOK_MIN_BZZ=1');
    await service.update(id);
    await buildSucceeds('review-stack', commit);

    assert.equal((await repository.findByName('review-stack'))?.buildId, `${commit}-r1`);
    assert.equal((await listed('review-stack')).buildLabel, 'QA-build-2026-10-08', 'a new build, a new label');
    assert.equal(manifestOf('review-stack', commit).label, 'QA-build-2026-10-07', 'the build before it keeps its own');
  });

  it('carries over to the build that applying its settings makes, as the commit and the toolchain do', async () => {
    const clone = cloneOf('review-stack');
    clone.annotatedTag('QA-build-2026-10-07');
    const commit = clone.head();
    const id = await added('review-stack', commit);
    clone.annotatedTag('QA-build-2026-10-08');
    await changeSettings('review-stack', 'CHEQUEBOOK_MIN_BZZ=1');

    const applied = await service.applySettings(id);

    assert.equal(applied.buildId, `${commit}-r1`);
    assert.equal(manifestOf('review-stack', applied.buildId).label, 'QA-build-2026-10-07');
    assert.equal((await listed('review-stack')).buildLabel, 'QA-build-2026-10-07');
  });
});

describe("the release the bundled version's build is made as", () => {
  it('is the label the manager was deployed with', async () => {
    process.env[MANAGER_VERSION_VARIABLE] = 'QA-build-2026-10-07';
    pinned(PIN);

    assert.ok(await service.ensureBundledBuild());
    await buildSucceeds('bundled', PIN);

    assert.equal(manifestOf('bundled', PIN).label, 'QA-build-2026-10-07');
    assert.equal((await listed('bundled')).buildLabel, 'QA-build-2026-10-07');
  });

  it('stays the label it was made with when a manager deploy builds nothing, and a moved pin builds under the new one', async () => {
    process.env[MANAGER_VERSION_VARIABLE] = 'QA-build-2026-10-07';
    pinned(PIN);
    await service.ensureBundledBuild();
    await buildSucceeds('bundled', PIN);

    // The next manager deploy changed only the manager: same pin, new label.
    process.env[MANAGER_VERSION_VARIABLE] = 'QA-build-2026-10-08';
    assert.equal(await service.ensureBundledBuild(), null, 'a deploy that changes only the manager builds nothing');
    assert.equal((await listed('bundled')).buildLabel, 'QA-build-2026-10-07');

    pinned(NEXT_PIN);
    assert.ok(await service.ensureBundledBuild());
    await buildSucceeds('bundled', NEXT_PIN);

    assert.equal((await listed('bundled')).buildLabel, 'QA-build-2026-10-08');
    assert.equal(manifestOf('bundled', PIN).label, 'QA-build-2026-10-07', 'the previous build keeps its own');
  });

  it('is nothing when the manager was deployed without one, whatever tag its clone carries', async () => {
    const clone = cloneOf('bundled');
    clone.annotatedTag('a-tag-the-clone-carries');
    const pin = clone.head();
    pinned(pin);

    await service.ensureBundledBuild();
    await buildSucceeds('bundled', pin);

    assert.equal((await repository.findByName('bundled'))?.buildId, pin);
    assert.equal((await listed('bundled')).buildLabel, null);
  });

  it('is nothing when the manager was deployed with something that is not a label', async () => {
    process.env[MANAGER_VERSION_VARIABLE] = 'QA build 2026-10-07';
    pinned(PIN);

    await service.ensureBundledBuild();
    await buildSucceeds('bundled', PIN);

    assert.equal('label' in manifestOf('bundled', PIN), false);
    assert.equal((await listed('bundled')).buildLabel, null);
  });
});

describe('what a deployment is seen to run', () => {
  /** A tree as a build leaves it, and as a deployment's own copy of one carries it. */
  function tree(manifest: Record<string, unknown>, complete = true): string {
    const dir = mkdtempSync(join(tmpdir(), 'stack-release-tree-'));
    scratch.push(dir);
    writeFileSync(join(dir, BUILD_MANIFEST_FILE), JSON.stringify(manifest));
    if (complete) writeFileSync(join(dir, BUILD_COMPLETE_MARKER), '');
    return dir;
  }

  const MANIFEST = { commit: PIN, buildId: PIN, builtAt: '2026-10-07T10:00:00.000Z', toolchain: 'synthetic' };

  it('names the release of the build the tree came from', () => {
    assert.equal(labelOfRoot(tree({ ...MANIFEST, label: 'QA-build-2026-10-07' })), 'QA-build-2026-10-07');
    assert.equal(readBuildManifest(tree({ ...MANIFEST, label: 'QA-build-2026-10-07' })).manifest?.commit, PIN);
  });

  it('names none for a build made without one, a build that did not finish, and a tree that is no build', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stack-release-empty-'));
    scratch.push(empty);
    assert.equal(labelOfRoot(tree(MANIFEST)), null);
    assert.equal(labelOfRoot(tree({ ...MANIFEST, label: 'QA-build-2026-10-07' }, false)), null);
    assert.equal(labelOfRoot(empty), null);
  });
});
