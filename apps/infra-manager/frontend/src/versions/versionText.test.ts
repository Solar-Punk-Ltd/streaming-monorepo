/**
 * What the Versions page says about a version in words.
 *
 * Unit test over the text helpers alone, with no rendering. `pnpm test` in
 * frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackContract, StackVersion } from '@streaming-infra-manager/common';

import {
  describeBuild,
  describeRelease,
  describeRunningRelease,
  describeSource,
  describeVersion,
  runningReleaseKey,
  updateHint,
  versionPlacementProblem,
} from './versionText';

const COMMIT = 'ee99c368bd45c12defcb10ca726f0db0777defb0';

function version(over: Partial<StackVersion> = {}): StackVersion {
  return {
    id: 1,
    name: 'bundled',
    gitRef: COMMIT,
    commitSha: COMMIT,
    status: 'ready',
    isDefault: true,
    tested: true,
    testedInvalidatedAt: null,
    builtAt: '2026-09-09T10:00:00.000Z',
    lastError: null,
    contract: null,
    deployments: 0,
    layout: 'builds',
    buildId: COMMIT,
    previousBuildId: null,
    buildLabel: null,
    source: { url: 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git', folder: '.' },
    ...over,
  };
}

describe('where a card says the version comes from', () => {
  const MONOREPO = 'https://github.com/Solar-Punk-Ltd/streaming-monorepo.git';
  const SWARM_HLS_STREAM = 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git';

  it('names the repository and the folder a monorepo build took the stack from', () => {
    assert.equal(
      describeSource(version({ source: { url: MONOREPO, folder: 'apps/hls-stream' } })),
      'streaming-monorepo, apps/hls-stream',
    );
  });

  it('names the repository alone when the whole tree is the stack', () => {
    assert.equal(describeSource(version({ source: { url: SWARM_HLS_STREAM, folder: '.' } })), 'swarm-hls-stream');
    assert.equal(describeSource(version({ source: { url: MONOREPO, folder: '.' } })), 'streaming-monorepo');
  });

  it('names the repository alone before a first build says where in it the stack is', () => {
    assert.equal(describeSource(version({ source: { url: MONOREPO, folder: null } })), 'streaming-monorepo');
  });
});

describe('what Update does on a card', () => {
  it('says the bundled version is rebuilt from the commit the manager ships with', () => {
    assert.equal(updateHint(version()), 'Rebuild the version the manager ships with, commit ee99c36.');
  });

  it('says so without a commit when this host cannot tell which one that is', () => {
    assert.match(updateHint(version({ commitSha: null })), /^Rebuild the version the manager ships with\./);
    assert.match(updateHint(version({ commitSha: null })), /cannot tell/);
  });

  it('says nothing for a version an operator added, whose branch the button already names', () => {
    assert.equal(updateHint(version({ name: 'review-stack', gitRef: 'main-v3' })), '');
  });
});

describe('where a version deploys from', () => {
  it('names the build of a version that has one', () => {
    assert.equal(describeBuild(version()), 'build ee99c36');
  });

  it('says the bundled version runs the tree the manager shipped until it is built here', () => {
    assert.equal(describeBuild(version({ layout: 'legacy', buildId: null })), 'with the manager, legacy tree');
  });

  it('names a version and its commit', () => {
    assert.equal(describeVersion(version()), 'bundled @ ee99c36');
  });
});

describe('the release a card and a deployment page name', () => {
  it("names a version's current build by its release and the first nine characters of the commit", () => {
    assert.deepEqual(describeRelease(version({ buildLabel: 'QA-build-2026-10-07+3' })), {
      text: 'QA-build-2026-10-07+3 (ee99c368b)',
      title: COMMIT,
    });
    assert.equal(describeRelease(version()), null, 'a build made with none names nothing');
  });

  it('names what the containers run only when every one agrees on the commit and the release', () => {
    const client = { service: 'client', buildCommit: COMMIT, buildLabel: 'QA-build-2026-10-07' };
    const gateway = { ...client, service: 'bee-gateway' };
    assert.deepEqual(describeRunningRelease([client, gateway]), {
      text: 'QA-build-2026-10-07 (ee99c368b)',
      title: COMMIT,
    });
    assert.equal(describeRunningRelease([client, { ...gateway, buildLabel: null }]), null);
    assert.equal(describeRunningRelease([]), null);
  });

  it("calls it the player's version on a deployment that serves the web player, and the release anywhere else", () => {
    assert.equal(runningReleaseKey('viewer'), 'Player');
    for (const shape of ['stream', 'bee-node', 'abr-uploader', 'custom'] as const) {
      assert.equal(runningReleaseKey(shape), 'Release', shape);
    }
  });
});

describe('why a version can place no deployment', () => {
  const withContract = (allocationProblem: string | null) =>
    version({ contract: { allocationProblem } as StackContract });

  it('hands over the contract sentence, so the card and the wizard say the same thing', () => {
    const problem =
      "No port slot from 1 to 99 passes this version's port policy, so no deployment can be created from it.";
    assert.equal(versionPlacementProblem(withContract(problem)), problem);
  });

  it('says nothing for a version that can place one, and nothing for a version with no contract yet', () => {
    assert.equal(versionPlacementProblem(withContract(null)), null);
    assert.equal(versionPlacementProblem(version()), null);
  });
});
