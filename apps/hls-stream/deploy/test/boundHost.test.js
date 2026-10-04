import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { makeSandbox, removeSandboxes } from './helpers/sandbox.js';

after(removeSandboxes);

const execFileAsync = promisify(execFile);

/** The gateway the stubbed daemon reports for its default bridge network. */
const BRIDGE = '192.0.2.1';

/**
 * Sources the real `bound-host.sh` from a sandbox, whose `docker` and `ssh` are stubs, and runs
 * `snippet` against it with only `env` set beside the stubs' PATH.
 */
async function withBoundHost(sandbox, snippet, env = {}) {
  const script = `source ${JSON.stringify(sandbox.scriptPath('bound-host.sh'))}\n${snippet}`;
  const { stdout } = await execFileAsync('bash', ['-c', script], {
    env: { ...env, PATH: sandbox.path },
  });
  return stdout.trim();
}

const askedTheDaemon = (calls) => calls.some((call) => call.startsWith('network inspect bridge'));

/**
 * The address a script on the deployment host dials for a port the stack published there. The Bee
 * APIs, SRS's HTTP server and API and OME's HLS port bind to the host's Docker bridge address wherever
 * their own setting is empty, so 127.0.0.1 answers for them only where the deploy fell back to it.
 */
describe('bound_host, the address a published port answers on', () => {
  it('is the bridge for an empty bind, the named address for a named one, and 127.0.0.1 for every address', async () => {
    const sandbox = makeSandbox();
    const out = await withBoundHost(
      sandbox,
      `for bind in '' 198.51.100.7 0.0.0.0 '::' '[::]'; do bound_host "$bind" ${BRIDGE}; done`,
    );

    assert.deepEqual(out.split('\n'), [BRIDGE, '198.51.100.7', '127.0.0.1', '127.0.0.1', '127.0.0.1']);
  });

  it('reads a Bee node its *_API_BIND, and its *_API_LISTEN under host networking', async () => {
    const sandbox = makeSandbox();
    const snippet = 'bee_api_bind BEE_GATEWAY; echo "-"';
    const env = { BEE_GATEWAY_API_BIND: '198.51.100.7', BEE_GATEWAY_API_LISTEN: '198.51.100.9' };

    assert.equal(await withBoundHost(sandbox, snippet, env), '198.51.100.7\n-');
    assert.equal(await withBoundHost(sandbox, snippet, { ...env, COMPOSE_NETWORK: 'host' }), '198.51.100.9\n-');
  });

  it('finds the node by its port, and takes the bridge for a port no node variable names', async () => {
    const sandbox = makeSandbox();
    const env = {
      BEE_UPLOADER_API_PORT: '10075',
      BEE_RUNG_720P_API_PORT: '11073',
      BEE_RUNG_720P_API_BIND: '198.51.100.7',
      BEE_GATEWAY_API_PORT: '10077',
      BEE_GATEWAY_API_BIND: '0.0.0.0',
    };
    const out = await withBoundHost(
      sandbox,
      `for port in 10075 11073 10077 12345; do bee_api_host_for_port "$port" ${BRIDGE}; done`,
      env,
    );

    assert.deepEqual(out.split('\n'), [BRIDGE, '198.51.100.7', '127.0.0.1', BRIDGE]);
  });
});

describe('bridge_address, the default every empty bind takes', () => {
  it('is the bridge the daemon on this host reports', async () => {
    const sandbox = makeSandbox();

    assert.equal(await withBoundHost(sandbox, 'bridge_address'), BRIDGE);
    assert.ok(askedTheDaemon(sandbox.calls()), `the daemon was never asked: ${sandbox.calls().join(' | ')}`);
  });

  it('takes DOCKER_BRIDGE_ADDRESS from the stage env when it is set, and does not ask the daemon', async () => {
    const sandbox = makeSandbox();

    assert.equal(
      await withBoundHost(sandbox, 'bridge_address', { DOCKER_BRIDGE_ADDRESS: '198.51.100.7' }),
      '198.51.100.7',
    );
    assert.ok(!askedTheDaemon(sandbox.calls()));
  });

  it('asks a remote host over ssh, not the machine running the script', async () => {
    const sandbox = makeSandbox();

    assert.equal(
      await withBoundHost(sandbox, 'bridge_address streamhost', { DOCKER_STUB_BRIDGE: '198.51.100.1' }),
      '198.51.100.1',
    );
    assert.ok(askedTheDaemon(sandbox.remoteCalls()), 'the remote daemon was never asked');
    assert.ok(!askedTheDaemon(sandbox.calls()), 'the local daemon answered for a host it does not run');
  });

  it('falls back to 127.0.0.1, as the compose files do, when no bridge can be read', async () => {
    const sandbox = makeSandbox();

    assert.equal(await withBoundHost(sandbox, 'bridge_address', { DOCKER_STUB_BRIDGE: '' }), '127.0.0.1');
    assert.equal(await withBoundHost(sandbox, 'bridge_address_on; echo "-"', { DOCKER_STUB_BRIDGE: '' }), '-');
  });
});
