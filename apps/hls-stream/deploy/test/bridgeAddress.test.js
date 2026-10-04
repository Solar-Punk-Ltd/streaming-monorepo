import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

/** The gateway the stubbed daemon reports for its default bridge network. */
const BRIDGE = '192.0.2.1';

/** What every admin bind falls back to in the compose files when the deploy names no bridge. */
const LOOPBACK = '127.0.0.1';

const BASE_ENV = ['STAMP=stamp', 'STREAM_KEY=key', 'BEE_UPLOADER_API_PORT=1633'];

function envText(lines = []) {
  return `${[...BASE_ENV, ...lines].join('\n')}\n`;
}

/**
 * The value compose interpolates for a key: the last line naming it across every env file it was given,
 * in the order it was given them, because a later `--env-file` wins on a duplicate key.
 */
function lastValue(envFiles, key) {
  const lines = envFiles.split('\n').filter((line) => line.startsWith(`${key}=`));
  return lines.length === 0 ? undefined : lines[lines.length - 1].slice(key.length + 1);
}

async function deployLocal(lines, env = {}, services = ['bee-uploader']) {
  const sandbox = makeSandbox({ envFiles: { '.env': envText(lines) } });
  const run = await runScript(sandbox, 'deploy.sh', services, { DOCKER_STUB_BRIDGE: `fd00::1 ${BRIDGE}`, ...env });
  assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
  return { sandbox, run };
}

/**
 * Where the stack's admin and file interfaces answer when their own setting is empty.
 *
 * A Bee API has no password and can spend the node's postage, and Docker publishes a port with rules
 * of its own that a host firewall such as ufw never sees. So the one default that stays in code is the
 * host's Docker bridge address, which containers on the host reach and nothing outside it does. The
 * compose files read it from DOCKER_BRIDGE_ADDRESS, and the deploy reads that from the daemon of the
 * host that runs compose, at deploy time.
 */
describe('the deploy reads the Docker bridge address of the host that runs compose', () => {
  it('hands compose the bridge gateway the local daemon reports, its IPv4 one', async () => {
    const { sandbox } = await deployLocal([]);

    assert.equal(lastValue(sandbox.envFiles(), 'DOCKER_BRIDGE_ADDRESS'), BRIDGE);
    assert.ok(
      sandbox.calls().some((call) => call.startsWith('network inspect bridge')),
      `the daemon was never asked: ${sandbox.calls().join(' | ')}`,
    );
  });

  it('reads it on the remote host for a remote deploy, not on the machine running the script', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, envFiles: { '.env': envText() } });
    await runScriptOk(sandbox, 'deploy.sh', ['bee-uploader'], { DOCKER_STUB_BRIDGE: BRIDGE });

    assert.ok(
      sandbox.remoteCalls().some((call) => call.startsWith('network inspect bridge')),
      `the remote daemon was never asked: ${sandbox.remoteCalls().join(' | ')}`,
    );
    assert.ok(
      !sandbox.calls().some((call) => call.startsWith('network inspect bridge')),
      'the local daemon answered for a host it does not run',
    );
    assert.equal(lastValue(sandbox.remoteEnvFiles(), 'DOCKER_BRIDGE_ADDRESS'), BRIDGE);
  });

  it('keeps an address the env file names, and does not ask the daemon', async () => {
    const { sandbox } = await deployLocal(['DOCKER_BRIDGE_ADDRESS=198.51.100.7']);

    assert.equal(lastValue(sandbox.envFiles(), 'DOCKER_BRIDGE_ADDRESS'), '198.51.100.7');
    assert.ok(!sandbox.calls().some((call) => call.startsWith('network inspect bridge')));
  });

  it('refuses an address that is not an IPv4 address, before compose runs', async () => {
    const sandbox = makeSandbox({ envFiles: { '.env': envText(['DOCKER_BRIDGE_ADDRESS=bridge.example.org']) } });
    const run = await runScript(sandbox, 'deploy.sh', ['bee-uploader']);

    assert.notEqual(run.exitCode, 0);
    assert.match(`${run.stdout}${run.stderr}`, /DOCKER_BRIDGE_ADDRESS/);
    assert.ok(!sandbox.calls().some((call) => call.startsWith('compose') && call.includes(' up ')));
  });

  it('takes the loopback address on Docker Desktop, whose bridge the host cannot reach', async () => {
    const { sandbox } = await deployLocal([], { DOCKER_STUB_OS: 'Docker Desktop' });

    assert.equal(lastValue(sandbox.envFiles(), 'DOCKER_BRIDGE_ADDRESS'), LOOPBACK);
  });

  it('names none and says so when the daemon reports no bridge, leaving the loopback fallback', async () => {
    const { sandbox, run } = await deployLocal([], { DOCKER_STUB_BRIDGE: '' });

    assert.equal(lastValue(sandbox.envFiles(), 'DOCKER_BRIDGE_ADDRESS'), undefined);
    assert.match(`${run.stdout}${run.stderr}`, /Could not read the Docker bridge address/);
    assert.match(`${run.stdout}${run.stderr}`, /127\.0\.0\.1/);
  });
});

/**
 * Under host networking Docker publishes no port, so the process's own listen address is the only bind.
 * Empty is every address, so the deploy gives the Bee nodes the bridge address as their default there,
 * and points the uploader at the address its node listens on.
 */
describe('host networking', () => {
  it('gives the Bee APIs the bridge address as their listen default', async () => {
    const { sandbox } = await deployLocal(['COMPOSE_NETWORK=host']);

    assert.equal(lastValue(sandbox.envFiles(), 'HOST_NETWORK_LISTEN'), BRIDGE);
  });

  it('falls back to the loopback address when the bridge could not be read, never to every address', async () => {
    const { sandbox } = await deployLocal(['COMPOSE_NETWORK=host'], { DOCKER_STUB_BRIDGE: '' });

    assert.equal(lastValue(sandbox.envFiles(), 'HOST_NETWORK_LISTEN'), LOOPBACK);
  });

  it('sets no listen default on a bridge network, where the process has to listen on every address of its own', async () => {
    const { sandbox } = await deployLocal([]);

    assert.equal(lastValue(sandbox.envFiles(), 'HOST_NETWORK_LISTEN'), undefined);
  });

  it('points the uploader at the address its node listens on', async () => {
    const { sandbox } = await deployLocal(['COMPOSE_NETWORK=host'], {}, ['bee-uploader', 'stream-uploader']);

    assert.equal(lastValue(sandbox.envFiles(), 'BEE_URL'), `http://${BRIDGE}:1633`);
  });

  it('points it at an explicit listen address, and at localhost for an operator who opened every address', async () => {
    const named = await deployLocal(['COMPOSE_NETWORK=host', 'BEE_UPLOADER_API_LISTEN=198.51.100.7'], {}, [
      'bee-uploader',
      'stream-uploader',
    ]);
    const open = await deployLocal(['COMPOSE_NETWORK=host', 'BEE_UPLOADER_API_LISTEN=0.0.0.0'], {}, [
      'bee-uploader',
      'stream-uploader',
    ]);

    assert.equal(lastValue(named.sandbox.envFiles(), 'BEE_URL'), 'http://198.51.100.7:1633');
    assert.equal(lastValue(open.sandbox.envFiles(), 'BEE_URL'), 'http://localhost:1633');
  });
});
