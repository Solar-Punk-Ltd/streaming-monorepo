/**
 * Which Bee API a stamp operation asks, and which deployment a chequebook operation moves the chequebook of, by the
 * opaque id the funding inventory names a node with: a deployment's own `bee-uploader`, at the address the inventory
 * read it at, and nothing else.
 *
 * Unit test, no database and no node: fake deployments. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fundingNodeApiUrl, fundingNodeDeployment } from '../../src/domain/funding/fundingNodeApi.js';
import type { Profile } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';

const STAGE_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const RUNG_ID = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d';
const ABR_ID = '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c';
const LEAVING_ID = '3ebc9d61-5f70-4182-9d2e-4f5a6b7c8d9e';

/** The ids no deployment's own Bee node answers to. */
const NOT_A_NODE = [
  `${STAGE_ID}:bee-gateway`,
  `${ABR_ID}:bee-uploader`,
  `${LEAVING_ID}:bee-uploader`,
  '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf:bee-uploader',
  'bee-uploader',
  `:bee-uploader`,
];

function deployments(): { list(): Promise<Profile[]> } {
  const profiles: Profile[] = [
    makeProfile({
      name: 'stage-one',
      kind: 'streamer',
      instance_id: STAGE_ID,
      components: ['stream-uploader', 'srs', 'bee-uploader'],
    }),
    makeProfile({
      name: 'pool-720p',
      kind: 'custom',
      instance_id: RUNG_ID,
      components: ['bee-uploader'],
      port_slot: 3,
    }),
    makeProfile({
      name: 'stage-abr',
      kind: 'abr-uploader',
      instance_id: ABR_ID,
      components: ['stream-uploader', 'srs'],
      port_slot: 2,
    }),
    makeProfile({
      name: 'leaving',
      kind: 'custom',
      instance_id: LEAVING_ID,
      components: ['bee-uploader'],
      port_slot: 4,
      status: 'REMOVING',
    }),
  ];
  return { list: async () => profiles };
}

function lookup(): (nodeId: string) => Promise<string | null> {
  return fundingNodeApiUrl({
    profiles: deployments(),
    uploaderApiUrl: (profile) => `http://${profile.name}.invalid:1633`,
  });
}

describe('the Bee API of a funding node', () => {
  it('is a deployment’s own bee-uploader, a stage’s node or a rung, at the inventory’s address', async () => {
    const apiOf = lookup();
    assert.equal(await apiOf(`${STAGE_ID}:bee-uploader`), 'http://stage-one.invalid:1633');
    assert.equal(await apiOf(`${RUNG_ID}:bee-uploader`), 'http://pool-720p.invalid:1633');
  });

  it('is none for a gateway, a deployment with no Bee node, one being removed, one not here, or no id', async () => {
    const apiOf = lookup();
    for (const nodeId of NOT_A_NODE) {
      assert.equal(await apiOf(nodeId), null, nodeId);
    }
  });
});

describe('the deployment of a funding node', () => {
  it('is the deployment whose own bee-uploader the node is, by its instance id', async () => {
    const deploymentOf = fundingNodeDeployment({ profiles: deployments() });
    const stage = await deploymentOf(`${STAGE_ID}:bee-uploader`);
    assert.deepEqual([stage?.name, stage?.instance_id], ['stage-one', STAGE_ID]);
    const rung = await deploymentOf(`${RUNG_ID}:bee-uploader`);
    assert.deepEqual([rung?.name, rung?.instance_id], ['pool-720p', RUNG_ID]);
  });

  it('is none where the Bee API is none', async () => {
    const deploymentOf = fundingNodeDeployment({ profiles: deployments() });
    for (const nodeId of NOT_A_NODE) {
      assert.equal(await deploymentOf(nodeId), null, nodeId);
    }
  });
});
