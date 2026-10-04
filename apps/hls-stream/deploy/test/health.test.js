import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { stubCurl } from './helpers/curlStub.js';
import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * `health.sh`, the command an operator runs after a deploy. Not to be confused with
 * `healthcheck.test.js`, which is about the probe compose runs inside the uploader container.
 *
 * ⛔ This command exited 0 whatever it found. Every service down showed five red crosses on the
 * terminal and reported success to anything reading the status, and `deploy.sh` ends by pointing the
 * operator at it while `deploy/README.md` documents it as the way to check a stack, so the reader is
 * as likely to be a scheduled job as a person.
 */

/** Where `makeSandbox` puts the deployment config, which a test has to break to drive that case. */
function configPath(sandbox) {
  return join(sandbox.root, 'deploy', 'config.json');
}

describe('health.sh answers in its exit status as well as on the terminal', () => {
  it('exits 0 when every service answers, and says how many it asked', async () => {
    const sandbox = makeSandbox();
    stubCurl(sandbox, { status: '200' });

    const run = await runScriptOk(sandbox, 'health.sh');

    assert.match(run.stdout, /All \d+ services are healthy/);
  });

  it('exits non-zero when a service answers 503, and says how many are unhealthy', async () => {
    const sandbox = makeSandbox();
    stubCurl(sandbox, { status: '503' });

    const run = await runScript(sandbox, 'health.sh');
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, `a stack answering 503 everywhere reported success: ${said}`);
    assert.match(said, /503/, 'the status the services gave is not on the page');
    assert.match(said, /services are unhealthy/);
  });

  it('exits non-zero when nothing is listening at all', async () => {
    const sandbox = makeSandbox();
    stubCurl(sandbox, { reachable: false });

    const run = await runScript(sandbox, 'health.sh');
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, `a stack with nothing listening reported success: ${said}`);
    assert.match(said, /unreachable/);
  });

  /**
   * The quieter half of the same defect, and the one a person cannot see either. This file has no
   * `set -e`, so a `config.json` that is present but is not valid JSON does not stop anything: every
   * `get_target` call fails inside jq, `get_targets` prints nothing, the loop never runs and a stack
   * nobody looked at came out the same as a healthy one.
   */
  it('refuses when the config cannot be read, rather than checking nothing and passing', async () => {
    const sandbox = makeSandbox();
    stubCurl(sandbox, { status: '200' });
    writeFileSync(configPath(sandbox), '{ "services": { "srs": "localhost",\n');

    const run = await runScript(sandbox, 'health.sh');
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, `an unreadable config reported a healthy stack: ${said}`);
    assert.match(said, /Nothing was checked/);
    assert.match(said, /config\.json/);
  });

  it('refuses when every service is disabled, which is also a run that looked at nothing', async () => {
    const sandbox = makeSandbox({
      config: {
        services: {
          srs: false,
          ome: false,
          'stream-uploader': false,
          'bee-uploader': false,
          'bee-gateway': false,
          client: false,
        },
      },
    });
    stubCurl(sandbox, { status: '200' });

    const run = await runScript(sandbox, 'health.sh');

    assert.notEqual(run.exitCode, 0, 'a profile with nothing enabled reported a healthy stack');
    assert.match(`${run.stdout}${run.stderr}`, /Nothing was checked/);
  });
});

/**
 * Where health.sh asks an admin or file interface. The Bee APIs and the engines' HTTP ports default to
 * the host's Docker bridge address, which answers on that host alone, so they are asked there: at the
 * address compose bound them to, and over ssh on the host for a remote target.
 */
describe('health.sh asks each interface where compose bound it', () => {
  const BRIDGE = '192.0.2.1';
  const envWith = (lines) => ({ '.env': ['STAMP=stamp', 'STREAM_KEY=key', ...lines].join('\n') + '\n' });

  it('asks the Bee API and the SRS file server on the bridge, and the viewer and uploader on localhost', async () => {
    const sandbox = makeSandbox();
    stubCurl(sandbox, { status: '200' });

    const run = await runScriptOk(sandbox, 'health.sh', [], { DOCKER_STUB_BRIDGE: BRIDGE });

    assert.match(run.stdout, new RegExp(`bee-uploader \\(http://${BRIDGE}:1633/health\\)`));
    assert.match(run.stdout, new RegExp(`srs \\(http://${BRIDGE}:8080\\)`));
    assert.match(run.stdout, /client \(http:\/\/localhost:5173\/\)/);
    assert.match(run.stdout, /stream-uploader \(http:\/\/localhost:3000\/health\)/);
  });

  it('asks at an address a bind names, and on 127.0.0.1 for one bound to every address', async () => {
    const sandbox = makeSandbox({
      envFiles: envWith(['BEE_UPLOADER_API_BIND=198.51.100.7', 'SRS_HTTP_BIND=0.0.0.0']),
    });
    stubCurl(sandbox, { status: '200' });

    const run = await runScriptOk(sandbox, 'health.sh', [], { DOCKER_STUB_BRIDGE: BRIDGE });

    assert.match(run.stdout, /bee-uploader \(http:\/\/198\.51\.100\.7:1633\/health\)/);
    assert.match(run.stdout, /srs \(http:\/\/127\.0\.0\.1:8080\)/);
  });

  it('asks a remote host its admin interfaces over ssh, on that host', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });
    stubCurl(sandbox, { status: '200' });

    const run = await runScriptOk(sandbox, 'health.sh', ['bee-uploader'], { DOCKER_STUB_BRIDGE: BRIDGE });

    assert.match(run.stdout, new RegExp(`bee-uploader \\(http://${BRIDGE}:1633/health on streamhost\\)`));
    assert.ok(
      sandbox.sshCommands().some((command) => command.includes('curl') && command.includes(`${BRIDGE}:1633`)),
      `the remote host was not asked: ${sandbox.sshCommands().join(' | ')}`,
    );
  });
});
