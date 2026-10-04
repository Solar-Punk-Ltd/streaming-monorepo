import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

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

/** A Bee postage batch the stamp guard is asked about, 64 hex characters like a real id. */
const BATCH = 'a'.repeat(64);

/**
 * A `curl` that answers only on the addresses in `listening`, as `host:port`, and refuses every other
 * one the way a port with nothing behind it does. Every URL it is asked for is journalled.
 */
function stubListeningCurl(sandbox, listening, { utilization = 10 } = {}) {
  const journal = join(sandbox.root, 'curl-urls');
  writeFileSync(journal, '');
  const answers = {
    '/stamps': JSON.stringify({
      stamps: [
        {
          batchID: BATCH,
          depth: 24,
          bucketDepth: 16,
          utilization,
          batchTTL: 864000,
          usable: true,
          immutableFlag: true,
        },
      ],
    }),
    '/chequebook/balance': JSON.stringify({ availableBalance: '50000000000000000' }),
    '/metrics': 'bee_pusher_total_synced 12\n',
    '/health': JSON.stringify({ status: 'ok', publishers: [{ rung: '360p', url: 'http://bee-uploader:1633' }] }),
  };
  const path = join(sandbox.binDir, 'curl');
  writeFileSync(
    `${path}.cjs`,
    `const fs = require('fs');
const url = process.argv.slice(2).find((a) => a.startsWith('http')) || '';
fs.appendFileSync(${JSON.stringify(journal)}, url + '\\n');
const { host, pathname } = new URL(url);
if (!${JSON.stringify(listening)}.includes(host)) process.exit(7);
const answer = ${JSON.stringify(answers)}[pathname];
if (answer === undefined) process.exit(22);
process.stdout.write(answer);
`,
  );
  writeFileSync(path, '#!/bin/sh\nexec node -- "$0.cjs" "$@"\n');
  chmodSync(path, 0o755);
  return () => readFileSync(journal, 'utf8').split('\n').filter(Boolean);
}

/**
 * The money guards and the node readings, which run on the deployment host and used to read every
 * node at 127.0.0.1. Nothing listens there for a Bee API on a default Linux host since the APIs bind
 * to the bridge address, so the guards got no answer at all.
 */
describe('stamp-guard.sh reads the batch where the deploy bound the node', () => {
  it('dials the bridge address when the node’s bind names none', async () => {
    const sandbox = makeSandbox();
    const urls = stubListeningCurl(sandbox, [`${BRIDGE}:10075`]);

    const run = await runScript(sandbox, 'stamp-guard.sh', ['--batch', BATCH, '--port', '10075']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.deepEqual(urls(), [`http://${BRIDGE}:10075/stamps`]);
  });

  it('dials the address the node’s bind names, and prints it in the fix it hands over', async () => {
    const sandbox = makeSandbox();
    const urls = stubListeningCurl(sandbox, ['198.51.100.7:10075'], { utilization: 250 });

    const run = await runScript(sandbox, 'stamp-guard.sh', ['--batch', BATCH, '--port', '10075'], {
      BEE_UPLOADER_API_PORT: '10075',
      BEE_UPLOADER_API_BIND: '198.51.100.7',
    });

    assert.deepEqual(urls(), ['http://198.51.100.7:10075/stamps']);
    assert.equal(run.exitCode, 1, 'a batch past the stop line was let through');
    assert.match(run.stdout, /REFUSING TO START/);
    assert.match(run.stdout, /curl -s -XPATCH http:\/\/198\.51\.100\.7:10075\/stamps\/dilute\//);
  });
});

describe('spend-ledger.sh baselines each node where the deploy bound it', () => {
  const env = (lines = []) => ({ '.env': ['STAMP=stamp', 'STREAM_KEY=key', ...lines].join('\n') + '\n' });

  it('reads the uploader on 127.0.0.1 and each Bee node on the bridge address', async () => {
    const sandbox = makeSandbox({ envFiles: env() });
    const urls = stubListeningCurl(sandbox, ['127.0.0.1:3000', `${BRIDGE}:1633`, `${BRIDGE}:1733`]);

    const run = await runScript(sandbox, 'spend-ledger.sh', ['--authorise=1', '--dry-run']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.deepEqual(urls(), [
      'http://127.0.0.1:3000/health',
      `http://${BRIDGE}:1633/chequebook/balance`,
      `http://${BRIDGE}:1733/chequebook/balance`,
    ]);
  });

  it('reads a node at the address its own bind names', async () => {
    const sandbox = makeSandbox({ envFiles: env(['BEE_GATEWAY_API_BIND=198.51.100.7']) });
    const urls = stubListeningCurl(sandbox, ['127.0.0.1:3000', `${BRIDGE}:1633`, '198.51.100.7:1733']);

    const run = await runScript(sandbox, 'spend-ledger.sh', ['--authorise=1', '--dry-run']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.ok(urls().includes('http://198.51.100.7:1733/chequebook/balance'), urls().join(' | '));
  });

  it('reads the bridge of a remote uploader host on that host, and dials the nodes there over ssh', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, envFiles: env() });
    stubListeningCurl(sandbox, ['127.0.0.1:3000', '198.51.100.1:1633', '198.51.100.1:1733']);

    const run = await runScript(sandbox, 'spend-ledger.sh', ['--authorise=1', '--dry-run'], {
      DOCKER_STUB_BRIDGE: '198.51.100.1',
    });

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.ok(askedTheDaemon(sandbox.remoteCalls()), 'the remote daemon was never asked');
    assert.ok(!askedTheDaemon(sandbox.calls()), 'the local daemon answered for a host it does not run');
    const dials = sandbox.sshCommands().filter((command) => command.includes('chequebook'));
    assert.equal(dials.length, 2, sandbox.sshCommands().join(' | '));
    assert.ok(
      dials.every((command) => command.includes("'http://198.51.100.1:")),
      dials.join(' | '),
    );
  });
});

describe('node-metrics.sh reads the nodes where the deploy bound them', () => {
  async function snapshot(sandbox, env) {
    const out = join(sandbox.root, 'snapshot.json');
    const run = await runScript(sandbox, 'node-metrics.sh', ['snapshot', out, 'test'], { PORT_SLOT: '7', ...env });
    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    return JSON.parse(readFileSync(out, 'utf8'));
  }

  it('dials both nodes on the bridge address and the uploader on 127.0.0.1', async () => {
    const sandbox = makeSandbox();
    const urls = stubListeningCurl(sandbox, [`${BRIDGE}:10075`, `${BRIDGE}:10077`, '127.0.0.1:10070']);

    const snap = await snapshot(sandbox);

    assert.deepEqual(
      new Set(urls().map((url) => new URL(url).host)),
      new Set([`${BRIDGE}:10075`, `${BRIDGE}:10077`, '127.0.0.1:10070']),
    );
    assert.equal(snap.chequebook.uploader.availableBalance, '50000000000000000');
    assert.equal(snap.chequebook.gateway.availableBalance, '50000000000000000');
    assert.equal(snap.stamps.stamps[0].batchID, BATCH);
  });

  it('dials a node at the address its own bind names', async () => {
    const sandbox = makeSandbox();
    const urls = stubListeningCurl(sandbox, ['198.51.100.7:10075', `${BRIDGE}:10077`, '127.0.0.1:10070']);

    const snap = await snapshot(sandbox, { BEE_UPLOADER_API_BIND: '198.51.100.7' });

    assert.ok(urls().includes('http://198.51.100.7:10075/stamps'), urls().join(' | '));
    assert.equal(snap.chequebook.uploader.availableBalance, '50000000000000000');
  });
});
