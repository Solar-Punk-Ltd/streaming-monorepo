/**
 * A deployment that already carries the name of a declared host-network project stops the manager.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * A deployment's compose project is its name, and KNOWN_HOST_NETWORK_PORTS is
 * matched on the project alone. A deployment created before the setting named
 * its project would have its host-network ports go unreserved from the next
 * start on, so the manager refuses to start until one of the two changes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  knownHostNetworkPorts,
  refuseDeploymentsNamedAsKnownHostNetworkProjects,
} from '../../src/domain/ports/knownHostNetworkPorts.js';

const DECLARED = knownHostNetworkPorts('edge=80/tcp,443/tcp,443/udp');

describe('a deployment that already has such a name when the manager starts', () => {
  it('stops the manager, naming the deployment and the setting', () => {
    assert.throws(
      () => refuseDeploymentsNamedAsKnownHostNetworkProjects(['stage', 'edge'], DECLARED),
      /edge.*KNOWN_HOST_NETWORK_PORTS.*edge=80\/tcp,443\/tcp,443\/udp/s,
    );
  });

  it('lets the manager start when no deployment carries a declared name', () => {
    refuseDeploymentsNamedAsKnownHostNetworkProjects(['stage', 'edge-stage'], DECLARED);
    refuseDeploymentsNamedAsKnownHostNetworkProjects(['edge'], new Map());
  });
});
