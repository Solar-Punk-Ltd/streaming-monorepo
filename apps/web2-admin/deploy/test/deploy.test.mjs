import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { fakeAdminEnv, makeSandbox, printedCommand, removeSandboxes } from './helpers/sandbox.mjs';

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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

describe('deploy.sh to a host that was deployed to before the move', () => {
  /** The host path each profile's env file had before the move, relative to the remote path. */
  const OLD_HOST_COPY = { qa: 'web2-admin/backend/.env.qa', brandB: 'web2-admin/backend/.env.brand-b' };
  const RM_LINE = /^\[deploy\]\s+(ssh admin-host 'rm [^']+')$/m;

  /**
   * The host just after this deploy's rsync, which the rsync stub leaves to the test: the profile's
   * env file sent to backend/, beside whatever the deploys before the move left there.
   */
  const hostAfterTheRsync = (leftBeforeTheMove) => ({
    'deploy/deploy.sh': '# the deploy script the rsync sent\n',
    'backend/Dockerfile': '# the Dockerfile the rsync sent\n',
    'backend/.env.qa': fakeAdminEnv('sent'),
    ...leftBeforeTheMove,
  });

  const sandboxWithHost = (leftBeforeTheMove) =>
    makeSandbox({ checkout: { [ENV_FILES.qa.now]: fakeAdminEnv('checkout') }, host: hostAfterTheRsync(leftBeforeTheMove) });

  const deployQa = (sandbox) => sandbox.runScript(DEPLOY, ['--host=admin-host', '--profile=qa', `--remote-path=${sandbox.hostDir}`]);

  it('warns once the deploy has succeeded that the old env file is still on the host, and prints the command that removes it', () => {
    const sandbox = sandboxWithHost({ [OLD_HOST_COPY.qa]: fakeAdminEnv('old-host-copy') });

    const deployed = deployQa(sandbox);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stderr, /WARNING: this host still has \S*web2-admin\/backend\/\.env\.qa/);
    assert.equal(printedCommand(deployed.stderr, RM_LINE), `ssh admin-host 'rm ${sandbox.onHost(OLD_HOST_COPY.qa)}'`);
    assert.ok(existsSync(sandbox.onHost(OLD_HOST_COPY.qa)), 'the deploy removed the old copy itself');
  });

  it('removes the old copy and nothing else when the printed command is run', () => {
    const sandbox = sandboxWithHost({ [OLD_HOST_COPY.qa]: fakeAdminEnv('old-host-copy') });
    const rm = printedCommand(deployQa(sandbox).stderr, RM_LINE);

    const removed = sandbox.runPrinted(rm);

    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(sandbox.onHost(OLD_HOST_COPY.qa)), false, 'the old copy is still there');
    assert.ok(existsSync(sandbox.onHost('backend/.env.qa')), 'the command removed the env file the profile runs on');
  });

  it('says nothing about an old copy on a host that has none', () => {
    const sandbox = sandboxWithHost({});

    const deployed = deployQa(sandbox);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.doesNotMatch(deployed.stderr, /still has|'rm /);
  });

  it("leaves another profile's old env file out of it, since that profile's own commands still need it", () => {
    const sandbox = sandboxWithHost({ [OLD_HOST_COPY.brandB]: fakeAdminEnv('brand-b') });

    const deployed = deployQa(sandbox);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.doesNotMatch(deployed.stderr, /still has|'rm /);
    assert.ok(existsSync(sandbox.onHost(OLD_HOST_COPY.brandB)));
  });
});

describe('deploy.sh names files by paths that work from the repository root', () => {
  it('names the sample and the env file that way when the env file is missing', () => {
    const sandbox = makeSandbox();

    const refused = sandbox.runScript(DEPLOY, LOCAL_QA);

    const advice = /Copy (\S+) to (\S+) and fill in/.exec(refused.stderr);
    assert.ok(advice, refused.stderr);
    const [, sample, target] = advice;
    assert.ok(existsSync(sandbox.inCheckout(sample)), `${sample} is not there from the repository root`);
    assert.equal(target, ENV_FILES.qa.now);
  });

  it('names the env file that way when a key in it is wrong', () => {
    const broken = fakeAdminEnv('broken').replace(/^POSTGRES_PASSWORD=.*$/m, 'POSTGRES_PASSWORD=');
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: broken } });

    const refused = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, new RegExp(`ERROR: ${escapeRegExp(ENV_FILES.qa.now)}: POSTGRES_PASSWORD is missing`));
    const summary = /problem\(s\) in (\S+)\. Nothing was deployed\. See (\S+) for/.exec(refused.stderr);
    assert.ok(summary, refused.stderr);
    assert.equal(summary[1], ENV_FILES.qa.now);
    assert.ok(existsSync(sandbox.inCheckout(summary[2])), `${summary[2]} is not there from the repository root`);
  });

  it('names the env file and the commit marker that way while it deploys', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: fakeAdminEnv('checkout') } });

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stdout, new RegExp(`env file ${escapeRegExp(ENV_FILES.qa.now)}$`, 'm'));
    const marker = /commit \S+ \(written to (\S+)\)/.exec(deployed.stdout);
    assert.ok(marker, deployed.stdout);
    assert.ok(existsSync(sandbox.inCheckout(marker[1])), `${marker[1]} is not there from the repository root`);
  });

  it('prints a first-user command that works from the repository root, and says so', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: fakeAdminEnv('checkout') } });

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    const userAdd = printedCommand(deployed.stdout, /^\[deploy\]\s+(\S.*user:add <username>)$/m);
    const parts = /^(?:cd (\S+) && )?WEB2_ADMIN_ENV_FILE=(\S+) docker compose -p \S+ -f (\S+) --env-file (\S+) exec /.exec(userAdd);
    assert.ok(parts, userAdd);
    const [, folder = '.', envFromComposeDir, composeFile, envFile] = parts;
    const runDir = sandbox.inCheckout(folder);
    assert.ok(existsSync(join(runDir, composeFile)), `from the repository root, ${composeFile} is not there: ${userAdd}`);
    assert.ok(existsSync(join(runDir, envFile)), `from the repository root, ${envFile} is not there: ${userAdd}`);
    assert.ok(
      existsSync(join(dirname(join(runDir, composeFile)), envFromComposeDir)),
      `WEB2_ADMIN_ENV_FILE does not lead from the compose file to the env file: ${userAdd}`,
    );
    assert.match(deployed.stdout, /first user.*from the repository root/);
  });
});
