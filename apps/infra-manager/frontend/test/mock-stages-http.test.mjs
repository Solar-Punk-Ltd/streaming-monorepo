/**
 * The offline mock's stage routes, over its own authenticated HTTP: a
 * deployment's public ingest address and the last push of its stage record,
 * which the deployment page's stage card reads.
 *
 * The mock is how the card is reviewed without a host, so it answers in the
 * shapes the manager does and refuses what the manager refuses.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, STAGE_PUSH_OUTCOMES } from '@streaming-infra-manager/common';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';

let child;
let base;
let cookie;

async function candidatePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function call(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(2_000),
  });
  if (path === '/auth/login') cookie = response.headers.get('set-cookie').split(';')[0];
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

async function request(path, method = 'GET', body) {
  const answer = await call(path, method, body);
  assert.ok(answer.status >= 200 && answer.status < 300, `${method} ${path} returned ${answer.status}`);
  return answer.body;
}

async function until(path, predicate) {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const value = await request(path);
    if (predicate(value)) return value;
    await delay(30);
  }
  throw new Error(`Mock transition did not finish: ${path}`);
}

before(async () => {
  const port = await candidatePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', 'dev/mock-manager.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Owned mock did not start')), 8_000);
    let output = '';
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-4_096);
      if (output.includes(`mock manager on ${base} `)) finish();
    };
    const onExit = () => finish(new Error('Owned mock exited before startup'));
    const finish = (error) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', finish);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', finish);
  });
  await request('/auth/login', 'POST', { username: DEV_USERNAME, password: DEV_PASSWORD });
});

after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
  child.kill('SIGTERM');
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
});

async function runningStreamer(name) {
  await request('/profiles', 'POST', { name, kind: 'streamer', stack_version_id: 2 });
  return until(`/profiles/${name}`, (profile) => profile.status === 'RUNNING');
}

describe('the mock stage routes', { concurrency: false, timeout: 60_000 }, () => {
  it('saves a public ingest address, clears it, and refuses one with a port', async () => {
    const profile = await runningStreamer('mock-stage-1');
    assert.equal(profile.ingest_host, null);

    const saved = await request('/profiles/mock-stage-1/ingest-host', 'PATCH', { ingest_host: 'ingest.example.org' });
    assert.equal(saved.ingest_host, 'ingest.example.org');
    assert.equal(saved.status, 'RUNNING', 'nothing was deployed');

    const refused = await call('/profiles/mock-stage-1/ingest-host', 'PATCH', {
      ingest_host: 'ingest.example.org:9000',
    });
    assert.equal(refused.status, 400);
    assert.equal((await request('/profiles/mock-stage-1')).ingest_host, 'ingest.example.org');

    const cleared = await request('/profiles/mock-stage-1/ingest-host', 'PATCH', { ingest_host: null });
    assert.equal(cleared.ingest_host, null);
  });

  it('answers a stage’s last push, and null for a deployment that is no stage and for a name with no deployment', async () => {
    await runningStreamer('mock-stage-2');
    const { registration } = await request('/stages/mock-stage-2/registration');
    assert.ok(STAGE_PUSH_OUTCOMES.includes(registration.outcome));
    assert.ok(Date.parse(registration.at) <= Date.now());
    assert.equal((await request('/profiles/viewer-eu')).kind, 'viewer');
    assert.deepEqual(await request('/stages/viewer-eu/registration'), { registration: null });
    assert.deepEqual(await request('/stages/nobody/registration'), { registration: null });
  });

  it('lists every stage without its passphrase', async () => {
    const { stages } = await request('/stages');
    assert.ok(stages.length > 0);
    for (const stage of stages) {
      assert.equal(typeof stage.name, 'string');
      assert.ok(!('srtPassphrase' in stage.record.ingest), stage.name);
      assert.equal(typeof stage.record.ingest.hasSrtPassphrase, 'boolean');
    }
  });
});
