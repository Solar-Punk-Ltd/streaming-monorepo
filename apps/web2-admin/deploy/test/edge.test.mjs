import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, describe, it } from 'node:test';

import { fakeEdgeEnv, makeSandbox, printedCommand, removeSandboxes } from './helpers/sandbox.mjs';

after(removeSandboxes);

// The edge's docs are in apps/web2-admin/deploy/README.md, and its tests sit beside the admin's.
const EDGE = 'infra/edge/edge.sh';
/** Where the edge's env file is now, and where it was before the edge moved to infra/edge, from the repository root. */
const ENV_FILE = { now: 'infra/edge/.env', before: 'deploy/edge/.env' };
const MV_LINE = /^\[edge\]\s+(mv \S+ \S+)$/m;

describe('edge.sh in a checkout that ran the edge before it moved to infra/edge', () => {
  it(`refuses while its env file is only at ${ENV_FILE.before}, and prints the mv that moves it`, () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILE.before]: fakeEdgeEnv('old-path') } });

    const refused = sandbox.runScript(EDGE, ['--host=admin-host']);

    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(printedCommand(refused.stderr, MV_LINE), `mv ${ENV_FILE.before} ${ENV_FILE.now}`);
    assert.match(refused.stderr, /Do not make a new one from the sample/);
  });

  it('leaves the old file where it is, prints none of it, and runs nothing before refusing', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILE.before]: fakeEdgeEnv('old-path') } });

    const refused = sandbox.runScript(EDGE, ['--host=admin-host']);

    assert.equal(refused.status, 1, refused.stderr);
    assert.ok(existsSync(sandbox.inCheckout(ENV_FILE.before)), 'the script moved the old file itself');
    assert.equal(existsSync(sandbox.inCheckout(ENV_FILE.now)), false, 'the script made an env file');
    assert.doesNotMatch(
      refused.stdout + refused.stderr,
      /old-path\.fixture\.invalid/,
      'the output holds what the env file holds',
    );
    assert.deepEqual(refused.calls, [], 'a tool ran before the refusal');
  });

  it('gets past its env file check once the printed mv has been run from the repository root', () => {
    const sandbox = makeSandbox({
      checkout: { [ENV_FILE.before]: fakeEdgeEnv('old-path') },
      // Somebody else's folder, so the run stops at the host check, before anything is sent.
      host: { 'not-a-checkout.txt': "somebody else's file\n" },
    });
    const mv = printedCommand(sandbox.runScript(EDGE, ['--host=admin-host']).stderr, MV_LINE);

    const moved = sandbox.runPrinted(mv);
    const run = sandbox.runScript(EDGE, ['--host=admin-host', `--remote-path=${sandbox.hostDir}`]);

    assert.equal(moved.status, 0, moved.stderr);
    assert.match(run.stdout, /rendered infra\/edge\/Caddyfile/, run.stderr);
    assert.match(run.stderr, /non-empty directory that is neither a checkout/);
  });

  it('keeps the sample advice when its env file is at neither path', () => {
    const sandbox = makeSandbox();

    const refused = sandbox.runScript(EDGE, ['--host=admin-host']);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(
      refused.stderr,
      /infra\/edge\/\.env not found\. Copy infra\/edge\/\.env\.sample to infra\/edge\/\.env/,
    );
    assert.doesNotMatch(refused.stderr, /\bmv\b/);
  });
});

describe('edge.sh on a host that runs the manager alone', () => {
  const MANAGER_ONLY_ENV = [
    '# A test fixture, not a deployment.',
    'MANAGER_DOMAIN=manager-only.fixture.invalid',
    'MANAGER_PORT=8080',
    '',
  ].join('\n');

  it('makes its folder on a host with no admin checkout and sends the edge there', () => {
    // No `host`: the folder does not exist yet, as on a host nothing of the admin's was deployed to.
    const sandbox = makeSandbox({ checkout: { [ENV_FILE.now]: MANAGER_ONLY_ENV } });

    const run = sandbox.runScript(EDGE, ['--host=manager-only-host', `--remote-path=${sandbox.hostDir}`]);

    assert.doesNotMatch(run.stderr, /could not be created/, run.stderr);
    assert.match(run.stdout, /https:\/\/manager-only\.fixture\.invalid -> 127\.0\.0\.1:8080/, run.stderr);
    assert.match(run.stdout, /web2-admin console is not served/, run.stderr);
    assert.ok(existsSync(sandbox.onHost('deploy/edge')), 'the edge folder was not made on the host');
    assert.ok(
      run.calls.some((call) => call.startsWith('rsync ') && call.includes(`${sandbox.hostDir}/deploy/edge/`)),
      `the edge was not sent to the host's edge folder:\n${run.calls.join('\n')}`,
    );
  });
});
