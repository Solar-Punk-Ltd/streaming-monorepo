/**
 * The release a deploy names to the stack, which the player builds in and
 * shows in its QoE overlay.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The release is the build's own, off the manifest of the build the deploy
 * was admitted on: the label it was made as and its commit. The stack's
 * parse_profile_args hands a flag it has no arm for on as a service name, and
 * deploy.sh then refuses the whole deploy, so the release goes only to a
 * version whose contract says its parser takes it. A deploy of any other
 * version is handed exactly the arguments it was handed before the release
 * existed.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultServicesFor, type StackContract } from '@streaming-infra-manager/common';

import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { releaseArgsFor, releaseOfBuild } from '../../src/domain/versions/deployRelease.js';
import { SWARM_HLS_STREAM_SOURCE } from '../../src/domain/versions/stackSources.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('deploy-release-');
process.env.SHLS_ROOT = join(root, 'bundled');
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(join(root, 'bundled'), { recursive: true });
writeFileSync(join(root, 'bundled', '.env'), 'ENGINE=srs\n');

const { buildDirFor } = await import('../../src/domain/versions/stackPaths.js');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

/** A version whose parser has no arm for the release flags, as every version before 2026-10-08. */
const OLDER: StackContract = {
  ports: [...ALLOCATION_CONTRACT.ports],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false, sharedImageTags: true, playerRelease: false },
  chequebookMinBzz: null,
  engineConfig: { srs: true, ome: false },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
  allocationProblem: null,
};

/** The same version once its parser takes `--release-label` and `--release-commit`. */
const TAKES_RELEASE: StackContract = { ...OLDER, features: { ...OLDER.features, playerRelease: true } };

const LABEL = 'QA-build-2026-10-07';
const COMMIT = `1702aff1b${'e'.repeat(31)}`;
const NEXT_COMMIT = 'f'.repeat(40);

const FEED_OWNER = `0x${'ab'.repeat(20)}`;
const FEED_TOPIC = 'swarm-stream';
const STAMP_ID = 'a'.repeat(64);

/** What a build's manifest says it is. */
interface Made {
  commit: string;
  label?: string;
}

/** A complete build of v3 on disk, made as the manifest says. */
function buildOnDisk(versionsRoot: string, buildId: string, made: Made): string {
  const dir = buildDirFor(versionsRoot, 'v3', buildId);
  mkdirSync(join(dir, 'deploy', 'scripts'), { recursive: true });
  writeFileSync(join(dir, '.env'), 'ENGINE=srs\n');
  writeFileSync(
    join(dir, BUILD_MANIFEST_FILE),
    JSON.stringify({
      commit: made.commit,
      buildId,
      builtAt: new Date().toISOString(),
      toolchain: 't',
      ...(made.label ? { label: made.label } : {}),
    }),
  );
  writeFileSync(join(dir, BUILD_COMPLETE_MARKER), '');
  return dir;
}

const stage = () =>
  makeProfile({
    name: 'stage',
    stack_version_id: 2,
    feed_owner: FEED_OWNER,
    feed_topic: FEED_TOPIC,
    stamp_id: STAMP_ID,
  });

/** A deployment on version v3, whose current build is made as `made` and whose contract is `contract`. */
async function setup(contract: StackContract, made: Made) {
  const versionsRoot = mkdtempSync(join(root, 'versions-'));
  const harness = orchestratorHarness([stage()], undefined, versionsRoot);
  const v3 = await harness.versions.insert({
    name: 'v3',
    gitRef: 'main-v3',
    rootPath: join(versionsRoot, 'v3'),
    sourceUrl: SWARM_HLS_STREAM_SOURCE.url,
  });
  buildOnDisk(versionsRoot, made.commit, made);
  await harness.versions.publish(v3.id, { buildId: made.commit, commitSha: made.commit, contract });
  const row = () => {
    const found = harness.profiles.rows.get('stage');
    if (!found) throw new Error('stage is gone');
    return found;
  };
  return { harness, v3, row, versionsRoot };
}

/** What deploy.sh was handed for one deploy of the deployment set up so. */
async function deployArgs(contract: StackContract, made: Made): Promise<string[]> {
  const { harness, row } = await setup(contract, made);
  await harness.orchestrator.startDeploy(row(), undefined);
  const run = harness.runner.runs.at(-1)!;
  assert.match(run.script, /\/deploy\.sh$/);
  return run.args;
}

const releaseFlagsIn = (args: readonly string[]): string[] => args.filter((arg) => arg.startsWith('--release-'));

describe('the release a deploy names to the stack', () => {
  it('reaches deploy.sh for a version whose parser takes it, as the label and the whole commit of the build', async () => {
    const args = await deployArgs(TAKES_RELEASE, { commit: COMMIT, label: LABEL });

    assert.deepEqual(releaseFlagsIn(args), [`--release-label=${LABEL}`, `--release-commit=${COMMIT}`]);
    // Among the overrides, before the services, as the feed and the stamp are.
    assert.ok(args.indexOf(`--release-commit=${COMMIT}`) < args.indexOf(defaultServicesFor(stage())[0]!));
  });

  /**
   * The hard requirement. An older version's parser would read either flag
   * as a service name and refuse the deploy, so its deploys are handed
   * exactly what they were handed before the release existed: what a build
   * made with no label is handed, and the list the arguments always were.
   */
  it('is not handed to an older version, whose deploy arguments are what they always were', async () => {
    const older = await deployArgs(OLDER, { commit: COMMIT, label: LABEL });

    assert.deepEqual(releaseFlagsIn(older), []);
    assert.deepEqual(older, await deployArgs(OLDER, { commit: COMMIT }));
    assert.deepEqual(older, [
      '--profile=stage',
      '--portSlot=1',
      '--host=localhost',
      `--feed-owner=${FEED_OWNER}`,
      `--feed-topic=${FEED_TOPIC}`,
      `--stamp-id=${STAMP_ID}`,
      ...defaultServicesFor(stage()),
    ]);
  });

  it('adds only the release to what a version that takes it is handed', async () => {
    const taking = await deployArgs(TAKES_RELEASE, { commit: COMMIT, label: LABEL });
    const older = await deployArgs(OLDER, { commit: COMMIT, label: LABEL });

    assert.deepEqual(
      taking.filter((arg) => !arg.startsWith('--release-')),
      older,
    );
  });

  it('names nothing for a build made with no label, so the player shows no release', async () => {
    const args = await deployArgs(TAKES_RELEASE, { commit: COMMIT });

    assert.deepEqual(releaseFlagsIn(args), []);
  });

  it('names the label alone when the manifest names a shorter commit, which the script would refuse', async () => {
    const args = await deployArgs(TAKES_RELEASE, { commit: COMMIT.slice(0, 9), label: LABEL });

    assert.deepEqual(releaseFlagsIn(args), [`--release-label=${LABEL}`]);
  });

  it('names the build the claim captured, not one published while the deploy waited to start', async () => {
    const { harness, v3, row, versionsRoot } = await setup(TAKES_RELEASE, { commit: COMMIT, label: LABEL });

    const reservation = await harness.orchestrator.reserveDeploy(row(), undefined);
    buildOnDisk(versionsRoot, NEXT_COMMIT, { commit: NEXT_COMMIT, label: 'QA-build-2026-10-08' });
    await harness.versions.publish(v3.id, { buildId: NEXT_COMMIT, commitSha: NEXT_COMMIT, contract: TAKES_RELEASE });
    await harness.orchestrator.runReserved(reservation, row());

    const run = harness.runner.runs.at(-1)!;
    assert.equal(run.options.cwd, buildDirFor(versionsRoot, 'v3', COMMIT), 'the job ran on the build the claim took');
    assert.deepEqual(releaseFlagsIn(run.args), [`--release-label=${LABEL}`, `--release-commit=${COMMIT}`]);
  });

  /**
   * Only deploy.sh builds the player. The other scripts check every flag
   * they are handed too, and a stop or a health check names no build.
   */
  it('reaches neither stop.sh nor health.sh', async () => {
    const { harness, row } = await setup(TAKES_RELEASE, { commit: COMMIT, label: LABEL });

    await harness.orchestrator.startStop(row(), undefined);
    await harness.orchestrator.startHealth(row());

    assert.deepEqual(
      harness.runner.runs.map((run) => [run.script.split('/').at(-1), releaseFlagsIn(run.args)]),
      [
        ['stop.sh', []],
        ['health.sh', []],
      ],
    );
  });
});

describe('releaseOfBuild', () => {
  const dir = (name: string) => mkdtempSync(join(root, name));

  it('reads the label and the whole commit off a complete build', () => {
    const build = buildOnDisk(dir('release-of-'), COMMIT, { commit: COMMIT, label: LABEL });

    assert.deepEqual(releaseOfBuild(build), { label: LABEL, commit: COMMIT });
  });

  it('answers null for a build made with no label', () => {
    assert.equal(releaseOfBuild(buildOnDisk(dir('release-of-'), COMMIT, { commit: COMMIT })), null);
  });

  it('answers null for a tree that is not a complete build, such as a flat legacy tree or the bundled checkout', () => {
    assert.equal(releaseOfBuild(dir('release-of-flat-')), null);

    const unfinished = buildOnDisk(dir('release-of-'), COMMIT, { commit: COMMIT, label: LABEL });
    rmSync(join(unfinished, BUILD_COMPLETE_MARKER));
    assert.equal(releaseOfBuild(unfinished), null);
  });

  it('leaves out a label the manifest holds in another shape than one', () => {
    const build = buildOnDisk(dir('release-of-'), COMMIT, { commit: COMMIT, label: 'QA build <1>' });

    assert.equal(releaseOfBuild(build), null);
  });
});

describe('releaseArgsFor', () => {
  const release = { label: LABEL, commit: COMMIT };

  it('names the label and the commit to a version that takes them', () => {
    assert.deepEqual(releaseArgsFor(TAKES_RELEASE, release), [
      `--release-label=${LABEL}`,
      `--release-commit=${COMMIT}`,
    ]);
    assert.deepEqual(releaseArgsFor(TAKES_RELEASE, { label: LABEL, commit: null }), [`--release-label=${LABEL}`]);
  });

  it('names nothing to a version that does not, to one whose contract is unknown, or without a release', () => {
    assert.deepEqual(releaseArgsFor(OLDER, release), []);
    assert.deepEqual(releaseArgsFor(null, release), []);
    assert.deepEqual(releaseArgsFor(undefined, release), []);
    assert.deepEqual(releaseArgsFor(TAKES_RELEASE, null), []);
  });
});
