/**
 * KNOWN_HOST_NETWORK_PORTS: host-network containers whose ports the operator declares.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * A host-network container publishes nothing Docker can report, so the port
 * scan cannot tell which ports it holds and every caller of the scan refuses
 * while one runs. A host's edge reverse proxy runs that way for good, which
 * left no deployment on such a host removable. The setting names such a
 * container by its compose project together with the ports it holds, so those
 * ports count as bound and the container no longer blocks the rest.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { knownHostNetworkPorts } from '../../src/domain/ports/knownHostNetworkPorts.js';
import { collectPublishedPorts } from '../../src/domain/ports/publishedPorts.js';
import { config } from '../../src/utils/config.js';

const EDGE_ID = 'e'.repeat(64);
const OTHER_ID = 'f'.repeat(64);

const edgeProxy = { id: EDGE_ID, project: 'edge', service: 'caddy', ports: {}, networkMode: 'host' };

const stage = {
  id: 'a'.repeat(64),
  project: 'stage',
  service: 'srs',
  ports: { '1935/tcp': [{ HostIp: '0.0.0.0', HostPort: '10012' }] },
  networkMode: 'bridge',
};

const EDGE_PORTS = knownHostNetworkPorts('edge=80/tcp,443/tcp,443/udp');

describe('host-network containers the operator declares', () => {
  it('lets a named host-network project through, so a removal on that host can be verified', () => {
    const snapshot = collectPublishedPorts([edgeProxy, stage], EDGE_PORTS);
    assert.deepEqual(snapshot.unverifiedProjects, []);
  });

  it('counts the declared ports as bindings of that project, so a reservation on them is still refused', () => {
    const snapshot = collectPublishedPorts([edgeProxy, stage], EDGE_PORTS);
    const edge = snapshot.bindings.filter((binding) => binding.project === 'edge');
    assert.deepEqual(edge, [
      { project: 'edge', service: null, port: 80, protocol: 'tcp' },
      { project: 'edge', service: null, port: 443, protocol: 'tcp' },
      { project: 'edge', service: null, port: 443, protocol: 'udp' },
    ]);
    assert.ok(snapshot.bindings.some((binding) => binding.project === 'stage' && binding.port === 10012));
  });

  // Copilot's review of #120: a declared project with several host-network containers claimed each port once per
  // container, under owners the inventory takes for different holders of one port.
  it('counts a declared project with several host-network containers once, under the project', () => {
    const sidecar = { ...edgeProxy, id: OTHER_ID, service: 'certbot' };
    const snapshot = collectPublishedPorts([edgeProxy, sidecar], EDGE_PORTS);
    assert.deepEqual(snapshot.unverifiedProjects, []);
    const edge = snapshot.bindings.filter((binding) => binding.project === 'edge');
    assert.equal(edge.length, 3);
    for (const binding of edge) assert.equal(binding.containerId, undefined);
  });

  it('keeps a host-network project the setting does not name unverified', () => {
    const other = { ...edgeProxy, id: OTHER_ID, project: 'monitoring' };
    const snapshot = collectPublishedPorts([edgeProxy, other], EDGE_PORTS);
    assert.deepEqual(snapshot.unverifiedProjects, ['monitoring']);
    assert.ok(!snapshot.bindings.some((binding) => binding.project === 'monitoring'));
  });

  it('keeps a host-network container with no compose project unverified', () => {
    const unlabelled = { ...edgeProxy, id: OTHER_ID, project: null, service: null };
    const snapshot = collectPublishedPorts([unlabelled], EDGE_PORTS);
    assert.deepEqual(snapshot.unverifiedProjects, [`external:${OTHER_ID}`]);
  });

  it('changes nothing when the setting is unset', () => {
    assert.equal(config.knownHostNetworkPorts.size, 0);
    assert.deepEqual(collectPublishedPorts([edgeProxy]).unverifiedProjects, ['edge']);
    assert.deepEqual(collectPublishedPorts([edgeProxy], knownHostNetworkPorts(undefined)).unverifiedProjects, ['edge']);
  });
});

describe('the KNOWN_HOST_NETWORK_PORTS setting', () => {
  it('is empty when the operator set nothing', () => {
    for (const empty of [undefined, '', '   ']) {
      assert.equal(knownHostNetworkPorts(empty).size, 0);
    }
  });

  it('reads projects separated by semicolons, each with its ports, trimmed', () => {
    const known = knownHostNetworkPorts(' edge = 80/tcp, 443/tcp ,443/udp ; monitoring=9100/tcp ');
    assert.deepEqual([...known.keys()], ['edge', 'monitoring']);
    assert.deepEqual(known.get('edge'), [
      { port: 80, protocol: 'tcp' },
      { port: 443, protocol: 'tcp' },
      { port: 443, protocol: 'udp' },
    ]);
    assert.deepEqual(known.get('monitoring'), [{ port: 9100, protocol: 'tcp' }]);
  });

  it('stops the manager on a malformed value, naming the setting', () => {
    for (const malformed of [
      'edge',
      'edge=',
      '=80/tcp',
      'edge=80',
      'edge=tcp:80',
      'edge=80/sctp',
      'edge=0/tcp',
      'edge=65536/tcp',
      'edge=80/tcp,,443/tcp',
      'edge=80/tcp;',
      'edge=80/tcp;edge=443/tcp',
      'edge=80/tcp,80/tcp',
      'Edge Proxy=80/tcp',
      'edge=80/tcp=443/tcp',
    ]) {
      assert.throws(() => knownHostNetworkPorts(malformed), /KNOWN_HOST_NETWORK_PORTS/, malformed);
    }
  });
});
