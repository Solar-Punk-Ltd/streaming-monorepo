/**
 * A deployment may not carry the name of a compose project KNOWN_HOST_NETWORK_PORTS declares.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * The setting is matched on the compose project label alone, and a managed
 * deployment's compose project is its name. A deployment named after a
 * declared project would have its host-network containers count as holding
 * only the declared ports, so the rest of what it listens on would never be
 * reserved and could be handed to another deployment. So the name is refused
 * when a deployment is created. knownHostNetworkStartup.test.ts covers one
 * that already exists.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { knownHostNetworkPorts } from '../../src/domain/ports/knownHostNetworkPorts.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';

const DECLARED = knownHostNetworkPorts('edge=80/tcp,443/tcp,443/udp;pool-profile-1=8443/tcp');

describe('a deployment named after a declared host-network project', () => {
  it('is refused at create, before anything is written or deployed', async () => {
    const harness = profileServiceHarness([], null, DECLARED);

    await assert.rejects(harness.service.create({ name: 'edge', kind: 'viewer' }), (err: Error) => {
      assert.equal(err.name, 'ProfileConfigError');
      assert.match(err.message, /edge/);
      assert.match(err.message, /KNOWN_HOST_NETWORK_PORTS/);
      return true;
    });
    assert.equal(harness.profiles.rows.size, 0);
    assert.deepEqual(harness.orchestrator.deploys, []);
  });

  it('is refused when a group would create a member with that name', async () => {
    const harness = profileServiceHarness([], null, DECLARED);

    await assert.rejects(
      harness.service.createGroup({ group_name: 'pool', size: 1, kind: 'viewer' }),
      /pool-profile-1.*KNOWN_HOST_NETWORK_PORTS/,
    );
    assert.equal(harness.profiles.rows.size, 0);
    assert.deepEqual(harness.groups.groups, []);
  });

  it('is refused when members appended to a group would take that name', async () => {
    const declared = knownHostNetworkPorts('pool-profile-2=8443/tcp');
    const harness = profileServiceHarness([], null, declared);
    const { group } = await harness.service.createGroup({ group_name: 'pool', size: 1, kind: 'viewer' });

    await assert.rejects(harness.service.addGroupMembers(group.id, 1), /pool-profile-2.*KNOWN_HOST_NETWORK_PORTS/);
    assert.equal(harness.profiles.rows.has('pool-profile-2'), false);
  });

  it('leaves every other name alone', async () => {
    const harness = profileServiceHarness([], null, DECLARED);
    const created = await harness.service.create({ name: 'edge-stage', kind: 'viewer' });
    assert.equal(created.name, 'edge-stage');
  });
});
