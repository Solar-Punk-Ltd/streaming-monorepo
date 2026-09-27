import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, describe, it } from 'node:test';

import { fakeAdminEnv, makeSandbox, removeSandboxes } from './helpers/sandbox.mjs';

after(removeSandboxes);

const DEPLOY = 'apps/web2-admin/deploy/deploy.sh';
const LOCAL_QA = ['--host=localhost', '--profile=qa'];

/**
 * Where a profile's env file is now, and where it was before the admin moved into
 * apps/web2-admin, both from the repository root.
 */
const ENV_FILES = {
  qa: { now: 'apps/web2-admin/backend/.env.qa', before: 'web2-admin/backend/.env.qa' },
  default: { now: 'apps/web2-admin/backend/.env', before: 'web2-admin/backend/.env' },
};

const MV_LINE = /^\[deploy\]\s+(mv \S+ \S+)$/m;

/**
 * The command a script printed on a line of its own for the operator to run, as the one capture
 * group of `pattern`. Fails the test, showing the output, when there is none.
 */
function printedCommand(output, pattern) {
  const match = pattern.exec(output);
  assert.ok(match, `no command matching ${pattern} in:\n${output}`);
  return match[1];
}

describe('deploy.sh in a checkout that deployed before the admin moved into apps/web2-admin', () => {
  for (const [profile, file] of Object.entries(ENV_FILES)) {
    it(`refuses while the ${profile} profile's env file is only at ${file.before}, and prints the mv that moves it`, () => {
      const sandbox = makeSandbox({ checkout: { [file.before]: fakeAdminEnv('old-path') } });

      const refused = sandbox.runScript(DEPLOY, ['--host=localhost', `--profile=${profile}`]);

      assert.equal(refused.status, 1, refused.stderr);
      assert.equal(printedCommand(refused.stderr, MV_LINE), `mv ${file.before} ${file.now}`);
      assert.match(refused.stderr, /Do not make a new one from the sample/);
    });
  }

  it('leaves the old file where it is, prints none of it, and runs nothing before refusing', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.before]: fakeAdminEnv('old-path') } });

    const refused = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(refused.status, 1, refused.stderr);
    assert.ok(existsSync(sandbox.inCheckout(ENV_FILES.qa.before)), 'the script moved the old file itself');
    assert.equal(existsSync(sandbox.inCheckout(ENV_FILES.qa.now)), false, 'the script made an env file');
    assert.doesNotMatch(refused.stdout + refused.stderr, /old-path-fixture-password/, 'the output holds what the env file holds');
    assert.deepEqual(refused.calls, [], 'a tool ran before the refusal');
  });

  it('deploys once the printed mv has been run from the repository root', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.before]: fakeAdminEnv('old-path') } });
    const mv = printedCommand(sandbox.runScript(DEPLOY, LOCAL_QA).stderr, MV_LINE);

    const moved = sandbox.runPrinted(mv);
    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(deployed.status, 0, deployed.stderr);
  });

  it('keeps the sample advice when the env file is at neither path', () => {
    const sandbox = makeSandbox();

    const refused = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /Copy \S*backend\/\.env\.sample to \S*backend\/\.env\.qa and fill in the required values/);
    assert.doesNotMatch(refused.stderr, /\bmv\b/);
  });

  it('deploys from the new path while a stale copy is still at the old one', () => {
    const sandbox = makeSandbox({
      checkout: { [ENV_FILES.qa.now]: fakeAdminEnv('new-path'), [ENV_FILES.qa.before]: fakeAdminEnv('old-path') },
    });

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
  });
});
