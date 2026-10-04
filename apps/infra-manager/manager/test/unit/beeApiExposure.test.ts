/**
 * Whether Docker publishes a Bee node's API on every address of its host, from the node container's inspect.
 *
 * Unit test, no Docker: the inspect is written out. `pnpm test` in manager/.
 *
 * Bee's API asks for no password, so one published on every address is open to whoever reaches the host. The
 * reading is Docker's own record of the published port, never a probe of the host's public address, which hairpin
 * NAT answers from inside and a provider firewall hides from outside. Under host networking nothing is published, and
 * the bind is the process's own `--api-addr`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beeApiOnEveryAddress } from '../../src/domain/stages/beeApiExposure.js';

const API = 10025;
const P2P = 10026;

function bridged(apiIps: string[], p2pIps: string[] = ['0.0.0.0', '::']) {
  return {
    networkMode: 'catalogue_default',
    cmd: ['start', `--api-addr=:${API}`],
    ports: {
      [`${API}/tcp`]: apiIps.map((ip) => ({ HostIp: ip, HostPort: String(API) })),
      [`${P2P}/tcp`]: p2pIps.map((ip) => ({ HostIp: ip, HostPort: String(P2P) })),
    },
  };
}

describe('beeApiOnEveryAddress', () => {
  it('is true when Docker reports the API port on 0.0.0.0 or ::', () => {
    assert.equal(beeApiOnEveryAddress(bridged(['0.0.0.0', '::']), API), true);
    assert.equal(beeApiOnEveryAddress(bridged(['::']), API), true);
    assert.equal(beeApiOnEveryAddress(bridged(['']), API), true);
  });

  it('is false when the API port is bound to one address, whatever the P2P port does', () => {
    assert.equal(beeApiOnEveryAddress(bridged(['192.0.2.1']), API), false);
  });

  it('is null when no binding names the API port, or the inspect is not one', () => {
    assert.equal(beeApiOnEveryAddress(bridged([]), API), null);
    assert.equal(beeApiOnEveryAddress(bridged(['0.0.0.0']), 11025), null);
    assert.equal(beeApiOnEveryAddress(null, API), null);
    assert.equal(beeApiOnEveryAddress({ ports: 'nope' }, API), null);
  });

  it('reads --api-addr under host networking, where nothing is published', () => {
    const host = (cmd: unknown[]) => ({ networkMode: 'host', ports: {}, cmd });
    assert.equal(beeApiOnEveryAddress(host(['start', `--api-addr=:${API}`]), API), true);
    assert.equal(beeApiOnEveryAddress(host(['start', `--api-addr=0.0.0.0:${API}`]), API), true);
    assert.equal(beeApiOnEveryAddress(host(['start', '--api-addr', `[::]:${API}`]), API), true);
    assert.equal(beeApiOnEveryAddress(host(['start', `--api-addr=192.0.2.1:${API}`]), API), false);
    assert.equal(beeApiOnEveryAddress(host(['start']), API), true, 'Bee’s own default is :1633, every address');
    assert.equal(beeApiOnEveryAddress(host(['start', `--api-addr=:${API}`, '--api-addr=127.0.0.1:1633']), API), false);
  });
});

describe('TargetDocker.beeApiInspect', () => {
  it('reads the node’s inspect over ssh on another host, by both compose labels, and answers none without a node', async () => {
    const { TargetDocker } = await import('../../src/domain/ports/TargetDocker.js');
    const commands: string[][] = [];
    let output = `${JSON.stringify(bridged(['0.0.0.0', '::']))}\n`;
    const docker = new TargetDocker({ daemonId: async () => 'local' }, async (file, args) => {
      commands.push([file, ...args]);
      return output;
    });

    assert.deepEqual(await docker.beeApiInspect('catalogue', 'deploy@bee-1'), bridged(['0.0.0.0', '::']));
    const remote = commands[0]!.at(-1)!;
    assert.equal(commands[0]![0], 'ssh');
    assert.match(remote, /label=com\.docker\.compose\.project=catalogue/);
    assert.match(remote, /label=com\.docker\.compose\.service=bee-uploader/);

    output = '';
    assert.equal(await docker.beeApiInspect('catalogue', 'deploy@bee-1'), null);
    await assert.rejects(docker.beeApiInspect("catalogue'; rm -rf /", 'deploy@bee-1'), /Invalid Compose project/);
  });

  it('reads the local daemon through its own reader', async () => {
    const { TargetDocker } = await import('../../src/domain/ports/TargetDocker.js');
    const docker = new TargetDocker(
      { daemonId: async () => 'local', beeApiInspect: async () => bridged(['192.0.2.1']) },
      async () => assert.fail('no ssh for the local daemon'),
    );
    assert.equal(beeApiOnEveryAddress(await docker.beeApiInspect('catalogue', 'localhost'), API), false);
  });
});
