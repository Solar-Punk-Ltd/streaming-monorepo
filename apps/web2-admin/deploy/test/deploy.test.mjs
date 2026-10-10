import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
    assert.doesNotMatch(
      refused.stdout + refused.stderr,
      /old-path-fixture-password/,
      'the output holds what the env file holds',
    );
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
    assert.match(
      refused.stderr,
      /Copy \S*backend\/\.env\.sample to \S*backend\/\.env\.qa and fill in the required values/,
    );
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
    makeSandbox({
      checkout: { [ENV_FILES.qa.now]: fakeAdminEnv('checkout') },
      host: hostAfterTheRsync(leftBeforeTheMove),
    });

  const deployQa = (sandbox) =>
    sandbox.runScript(DEPLOY, ['--host=admin-host', '--profile=qa', `--remote-path=${sandbox.hostDir}`]);

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
    const parts =
      /^(?:cd (\S+) && )?WEB2_ADMIN_ENV_FILE=(\S+) docker compose -p \S+ -f (\S+) --env-file (\S+) exec /.exec(userAdd);
    assert.ok(parts, userAdd);
    const [, folder = '.', envFromComposeDir, composeFile, envFile] = parts;
    const runDir = sandbox.inCheckout(folder);
    assert.ok(
      existsSync(join(runDir, composeFile)),
      `from the repository root, ${composeFile} is not there: ${userAdd}`,
    );
    assert.ok(existsSync(join(runDir, envFile)), `from the repository root, ${envFile} is not there: ${userAdd}`);
    assert.ok(
      existsSync(join(dirname(join(runDir, composeFile)), envFromComposeDir)),
      `WEB2_ADMIN_ENV_FILE does not lead from the compose file to the env file: ${userAdd}`,
    );
    assert.match(deployed.stdout, /first user.*from the repository root/);
  });
});

describe('deploy.sh and the INGEST_* keys the stream stage replaced', () => {
  it('deploys an env file with none of them, since the admin needs no stage to start', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: fakeAdminEnv('no-ingest') } });

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.doesNotMatch(deployed.stderr, /INGEST_/);
  });

  it('deploys an env file that still sets them, and names each one it sets as no longer read', () => {
    const stale = `${fakeAdminEnv('stale-ingest')}INGEST_HOST=ingest.fixture.invalid\nINGEST_KEY_VERIFIED=maybe\n`;
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: stale } });

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stderr, /WARNING: INGEST_HOST is no longer read/);
    assert.match(deployed.stderr, /WARNING: INGEST_KEY_VERIFIED is no longer read/);
    assert.doesNotMatch(deployed.stderr, /INGEST_SRT_PORT/);
  });
});

describe('deploy.sh and the keys the catalogue stamp replaced', () => {
  it('deploys an env file with no Bee node and no batch in it', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: fakeAdminEnv('no-bee') } });

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.doesNotMatch(deployed.stderr, /BEE_URL|POSTAGE_BATCH_ID/);
  });

  it('deploys an env file that still sets BEE_URL and POSTAGE_BATCH_ID, checks neither, and names each as no longer read', () => {
    const stale = `${fakeAdminEnv('stale')}BEE_URL=not-a-url\nPOSTAGE_BATCH_ID=not-a-batch\n`;
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: stale } });

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stderr, /WARNING: BEE_URL is no longer read/);
    assert.match(deployed.stderr, /WARNING: POSTAGE_BATCH_ID is no longer read/);
    assert.doesNotMatch(deployed.stderr, /must be|missing or empty/);
  });
});

describe('deploy.sh and the published test values', () => {
  const SAMPLE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const SAMPLE_TOKEN = 'change-me-to-32-or-more-random-characters';

  const withSampleKey = (env) =>
    env.replace(/^FEED_PRIVATE_KEY=.*$/m, `FEED_PRIVATE_KEY=${SAMPLE_KEY.toUpperCase().replace('0X', '0x')}`);
  const withSampleToken = (env) => env.replace(/^INTERNAL_API_TOKEN=.*$/m, `INTERNAL_API_TOKEN=${SAMPLE_TOKEN}`);

  it('refuses the public Hardhat FEED_PRIVATE_KEY, in either case, and runs nothing', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: withSampleKey(fakeAdminEnv('sample-key')) } });

    const refused = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /ERROR: \S+: FEED_PRIVATE_KEY is the public Hardhat test key\. Anyone/);
    assert.match(refused.stderr, /1 problem\(s\) in \S+\. Nothing was deployed\./);
    assert.deepEqual(refused.calls, [], 'a tool ran before the refusal');
  });

  it('refuses the sample INTERNAL_API_TOKEN and runs nothing', () => {
    const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: withSampleToken(fakeAdminEnv('sample-token')) } });

    const refused = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /ERROR: \S+: INTERNAL_API_TOKEN is the placeholder from \.env\.sample/);
    assert.deepEqual(refused.calls, [], 'a tool ran before the refusal');
  });

  it('names both in one run, and the option that lets a test install through', () => {
    const sandbox = makeSandbox({
      checkout: { [ENV_FILES.qa.now]: withSampleToken(withSampleKey(fakeAdminEnv('sample-both'))) },
    });

    const refused = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /FEED_PRIVATE_KEY is the public Hardhat test key/);
    assert.match(refused.stderr, /INTERNAL_API_TOKEN is the placeholder/);
    assert.match(refused.stderr, /2 problem\(s\) in /);
    assert.match(refused.stderr, /--allow-sample-secrets/);
  });

  it('deploys them with --allow-sample-secrets, and warns about each', () => {
    const sandbox = makeSandbox({
      checkout: { [ENV_FILES.qa.now]: withSampleToken(withSampleKey(fakeAdminEnv('sample-allowed'))) },
    });

    const deployed = sandbox.runScript(DEPLOY, [...LOCAL_QA, '--allow-sample-secrets']);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stderr, /WARNING: FEED_PRIVATE_KEY is the public Hardhat test key/);
    assert.match(deployed.stderr, /WARNING: INTERNAL_API_TOKEN is the placeholder/);
    assert.doesNotMatch(deployed.stderr, /ERROR/);
  });

  it('says nothing about either with values of your own, with or without the option', () => {
    for (const args of [LOCAL_QA, [...LOCAL_QA, '--allow-sample-secrets']]) {
      const sandbox = makeSandbox({ checkout: { [ENV_FILES.qa.now]: fakeAdminEnv('own-values') } });

      const deployed = sandbox.runScript(DEPLOY, args);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.doesNotMatch(deployed.stderr, /Hardhat|placeholder/);
    }
  });

  it('names the option in --help', () => {
    const sandbox = makeSandbox();

    const help = sandbox.runScript(DEPLOY, ['--help']);

    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^\s+--allow-sample-secrets\s+\S/m);
    assert.match(help.stdout, /^Usage: deploy\.sh .*\[--allow-sample-secrets\]/m);
  });
});

describe('deploy.sh and the funding keys', () => {
  /** Values of the right shape that are not the sample's. */
  const SECRET = 'a1'.repeat(32);
  const TOKEN = 'fixture-funding-token-of-more-than-thirty-two-characters';
  const SET_UP = 'MANAGER_FUNDING_URL=https://manager.example.org';
  const SAMPLE_SECRET = '0123456789abcdef'.repeat(4);
  const SAMPLE_TOKEN = 'change-me-to-the-managers-funding-api-token';

  /** A deploy of the qa profile whose env file is the fixture with `lines` added, with `args` added to the command. */
  const deployWith = (lines, args = []) => {
    const env = `${fakeAdminEnv('funding')}${lines.map((line) => `${line}\n`).join('')}`;
    return makeSandbox({ checkout: { [ENV_FILES.qa.now]: env } }).runScript(DEPLOY, [...LOCAL_QA, ...args]);
  };

  it('deploys an env file with none of them, and says nothing of them', () => {
    const deployed = deployWith([]);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.doesNotMatch(deployed.stderr, /BRAND_WALLET_SECRET|MANAGER_FUNDING/);
  });

  it('deploys funding set up with a secret and a token of its own, and prints neither', () => {
    const deployed = deployWith([SET_UP, `BRAND_WALLET_SECRET=${SECRET}`, `MANAGER_FUNDING_TOKEN=${TOKEN}`]);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.doesNotMatch(deployed.stderr, /BRAND_WALLET_SECRET|MANAGER_FUNDING/);
    assert.equal((deployed.stdout + deployed.stderr).includes(SECRET), false);
    assert.equal((deployed.stdout + deployed.stderr).includes(TOKEN), false);
  });

  it('deploys a secret alone, which gives the API its wallet before funding is set up', () => {
    const deployed = deployWith([`BRAND_WALLET_SECRET=${SECRET.toUpperCase()}`]);

    assert.equal(deployed.status, 0, deployed.stderr);
  });

  it('refuses funding set up without a BRAND_WALLET_SECRET, and runs nothing', () => {
    for (const lines of [
      [SET_UP, `MANAGER_FUNDING_TOKEN=${TOKEN}`],
      [SET_UP, 'BRAND_WALLET_SECRET=', `MANAGER_FUNDING_TOKEN=${TOKEN}`],
    ]) {
      const refused = deployWith(lines);

      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /ERROR: \S+: BRAND_WALLET_SECRET is missing or empty/);
      assert.match(refused.stderr, /1 problem\(s\) in /);
      assert.deepEqual(refused.calls, [], 'a tool ran before the refusal');
    }
  });

  it('refuses a BRAND_WALLET_SECRET that is not 64 hex characters, set up or not, and prints none of it', () => {
    for (const secret of [SECRET.slice(2), `0x${SECRET}`, `${SECRET.slice(2)}zz`]) {
      for (const lines of [
        [`BRAND_WALLET_SECRET=${secret}`],
        [SET_UP, `BRAND_WALLET_SECRET=${secret}`, `MANAGER_FUNDING_TOKEN=${TOKEN}`],
      ]) {
        const refused = deployWith(lines);

        assert.equal(refused.status, 1, refused.stderr);
        assert.match(refused.stderr, /BRAND_WALLET_SECRET must be 64 hex characters/);
        assert.equal((refused.stdout + refused.stderr).includes(secret.replace(/^0x/, '')), false, secret);
      }
    }
  });

  it('refuses a MANAGER_FUNDING_TOKEN under 32 characters or with a space, and prints none of it', () => {
    for (const [token, problem] of [
      ['', /MANAGER_FUNDING_TOKEN must be at least 32 characters \(got 0\)/],
      ['short-funding-token', /MANAGER_FUNDING_TOKEN must be at least 32 characters \(got 19\)/],
      ['"a funding token with spaces, long enough"', /MANAGER_FUNDING_TOKEN must be printable ASCII with no space/],
    ]) {
      const refused = deployWith([SET_UP, `BRAND_WALLET_SECRET=${SECRET}`, `MANAGER_FUNDING_TOKEN=${token}`]);

      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, problem);
      if (token !== '') assert.equal((refused.stdout + refused.stderr).includes(token.replaceAll('"', '')), false);
    }
  });

  it('refuses a MANAGER_FUNDING_TOKEN with any character beyond printable ASCII, as the API does, and prints none of it', () => {
    for (const [what, token] of [
      ['a letter beyond ASCII', 'fixture-funding-token-of-thirty-two-characters-é'],
      ['a tab', '"fixture-funding-token\twith-a-tab-inside-it"'],
      ['a zero-width space', 'fixture-funding-token\u200bwith-a-zero-width-space'],
    ]) {
      const refused = deployWith([SET_UP, `BRAND_WALLET_SECRET=${SECRET}`, `MANAGER_FUNDING_TOKEN=${token}`]);

      assert.equal(refused.status, 1, `${what}: ${refused.stderr}`);
      assert.match(refused.stderr, /MANAGER_FUNDING_TOKEN must be printable ASCII with no space/, what);
      assert.equal((refused.stdout + refused.stderr).includes('fixture-funding-token'), false, what);
    }
  });

  it('deploys a MANAGER_FUNDING_TOKEN of any printable ASCII, punctuation included', () => {
    const deployed = deployWith([
      SET_UP,
      `BRAND_WALLET_SECRET=${SECRET}`,
      'MANAGER_FUNDING_TOKEN=!fixture~funding+token/0123456789=_-*',
    ]);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.doesNotMatch(deployed.stderr, /MANAGER_FUNDING/);
  });

  it('refuses a MANAGER_FUNDING_TOKEN without MANAGER_FUNDING_URL, as the API does', () => {
    const refused = deployWith([`BRAND_WALLET_SECRET=${SECRET}`, `MANAGER_FUNDING_TOKEN=${TOKEN}`]);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /MANAGER_FUNDING_TOKEN is set without MANAGER_FUNDING_URL/);
  });

  it("refuses the sample's secret and token, naming both and the option that lets a test install through", () => {
    const refused = deployWith([
      SET_UP,
      `BRAND_WALLET_SECRET=${SAMPLE_SECRET}`,
      `MANAGER_FUNDING_TOKEN=${SAMPLE_TOKEN}`,
    ]);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /ERROR: \S+: BRAND_WALLET_SECRET is the placeholder from \.env\.sample/);
    assert.match(refused.stderr, /ERROR: \S+: MANAGER_FUNDING_TOKEN is the placeholder from \.env\.sample/);
    assert.match(refused.stderr, /2 problem\(s\) in /);
    assert.match(refused.stderr, /--allow-sample-secrets/);
    assert.deepEqual(refused.calls, [], 'a tool ran before the refusal');
  });

  it("refuses the sample's secret before funding is set up too, since the first start creates the wallet with it", () => {
    const refused = deployWith([`BRAND_WALLET_SECRET=${SAMPLE_SECRET.toUpperCase()}`]);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /BRAND_WALLET_SECRET is the placeholder from \.env\.sample/);
  });

  it('deploys them with --allow-sample-secrets, and warns about each', () => {
    const deployed = deployWith(
      [SET_UP, `BRAND_WALLET_SECRET=${SAMPLE_SECRET}`, `MANAGER_FUNDING_TOKEN=${SAMPLE_TOKEN}`],
      ['--allow-sample-secrets'],
    );

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stderr, /WARNING: BRAND_WALLET_SECRET is the placeholder/);
    assert.match(deployed.stderr, /WARNING: MANAGER_FUNDING_TOKEN is the placeholder/);
    assert.doesNotMatch(deployed.stderr, /ERROR/);
  });

  it('refuses the values the committed .env.sample ships, once its token line is uncommented', () => {
    const sample = readFileSync(new URL('../../backend/.env.sample', import.meta.url), 'utf8');
    const secret = /^BRAND_WALLET_SECRET=(\S+)$/m.exec(sample)?.[1];
    const token = /^# MANAGER_FUNDING_TOKEN=(\S+)$/m.exec(sample)?.[1];
    assert.ok(secret && token, 'the sample no longer carries both placeholders');

    const refused = deployWith([SET_UP, `BRAND_WALLET_SECRET=${secret}`, `MANAGER_FUNDING_TOKEN=${token}`]);

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /BRAND_WALLET_SECRET is the placeholder/);
    assert.match(refused.stderr, /MANAGER_FUNDING_TOKEN is the placeholder/);
  });

  it('names the funding keys under the option in --help', () => {
    const help = makeSandbox().runScript(DEPLOY, ['--help']);

    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--allow-sample-secrets[^]*BRAND_WALLET_SECRET[^]*MANAGER_FUNDING_TOKEN[^]*-h, --help/);
  });
});
