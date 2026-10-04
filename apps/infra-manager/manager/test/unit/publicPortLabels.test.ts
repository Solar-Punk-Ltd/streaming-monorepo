/**
 * What the Containers card calls public, against what the firewall draft opens.
 *
 * `endpointKindOf` in the frontend reads a port's audience off its key, and
 * `PUBLIC_PORT_ROLES` in the shared policy is what the generated nftables draft
 * opens. The card says what a port is for, and which ports are reachable is the
 * operator's firewall, so the two agree on every port but RTMP: an ingest port
 * the card calls public and the draft leaves to the operator to open. It is a
 * manager test because the shared policy and the manager's own port table both
 * live on this side.
 *
 * The keys checked are the ones a deployment can show: the bundled port table,
 * the OME variables the engine swap resolves to, and every variable a public
 * role names. A per-rung Bee peer port is not among them, because the manager
 * starts no rung service, and `publicPortRoleServices` is the check for that.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OME_PORT_SOURCES, PUBLIC_PORT_ROLES } from '@streaming-infra-manager/common';

import { BUNDLED_PORT_TABLE } from '../../src/domain/versions/portTable.js';

const { endpointKindOf } = await import(
  new URL('../../../frontend/src/deployments/endpoints.ts', import.meta.url).href
);

/** Every port variable a public role admits, aliases included. */
function openedPortVars(): Set<string> {
  const names = new Set<string>();
  for (const role of PUBLIC_PORT_ROLES) {
    names.add(role.portVar);
    for (const alias of role.aliases ?? []) names.add(alias.portVar);
  }
  return names;
}

const PORT_KEYS = [
  ...BUNDLED_PORT_TABLE.map((port) => port.name),
  ...Object.keys(OME_PORT_SOURCES),
  ...openedPortVars(),
];

function calledPublic(): string[] {
  return [...new Set(PORT_KEYS)].filter((key) => endpointKindOf(key).audience === 'public');
}

/** The one port the card calls public and the firewall draft opens no band for. */
const OPENED_BY_THE_OPERATOR = ['SRS_RTMP_PORT'];

describe('what the port cell calls public', () => {
  it('names only ports the generated firewall opens, and RTMP, which the operator opens', () => {
    const opened = openedPortVars();

    assert.deepEqual(
      calledPublic().filter((key) => !opened.has(key)),
      OPENED_BY_THE_OPERATOR,
      'the card calls these public and the generated rules drop them from outside',
    );
  });

  it('reaches the ports that are genuinely public, so it can fail', () => {
    assert.deepEqual(calledPublic().sort(), [
      'BEE_GATEWAY_P2P_PORT',
      'BEE_UPLOADER_P2P_PORT',
      'CLIENT_PORT',
      'OME_SRT_PORT',
      'SRS_RTMP_PORT',
      'SRS_SRT_PORT',
    ]);
  });

  it('calls RTMP public though no role names it, because the card does not read the firewall draft', () => {
    assert.equal(openedPortVars().has('SRS_RTMP_PORT'), false);
    assert.equal(endpointKindOf('SRS_RTMP_PORT').audience, 'public');
  });
});
