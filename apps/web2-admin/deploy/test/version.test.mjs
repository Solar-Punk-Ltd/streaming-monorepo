import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURE_VERSION, fakeAdminEnv, isolatedGitEnv, makeSandbox, removeSandboxes } from './helpers/sandbox.mjs';

after(removeSandboxes);

/**
 * What deploy.sh does with the build tools/release/version.mjs names: it carries the label and the commit to the
 * compose run on the host, which builds them into the images, refuses either one before anything runs on the host
 * when it is not what version.mjs can name, never asks anything without a terminal, and fails when the api container
 * it started reports another build.
 */

const DEPLOY = 'apps/web2-admin/deploy/deploy.sh';
const QA_ENV = 'apps/web2-admin/backend/.env.qa';
const LOCAL_QA = ['--host=localhost', '--profile=qa'];
const { commit: COMMIT, short: SHORT, tag: TAG } = FIXTURE_VERSION;
const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

/**
 * The fake host as an earlier admin deploy left it. deploy.sh refuses to rsync --delete into a folder that is neither
 * empty nor such a deploy, the rsync stub copies nothing to the host, and the host's script reaches for the profile's
 * env file first.
 */
const HOST_WITH_PROFILE = {
  'deploy/deploy.sh': '# an earlier deploy\n',
  'backend/Dockerfile': 'FROM scratch\n',
  'backend/.env.qa': fakeAdminEnv('host'),
};

const withProfile = (extra = {}) => ({ checkout: { [QA_ENV]: fakeAdminEnv('version'), ...extra } });
const remoteQa = (sandbox) => ['--host=admin-host', '--profile=qa', `--remote-path=${sandbox.hostDir}`];

/** The stub calls that reach a host or build anything: every call but the question to version.mjs. */
const hostCalls = (run) => run.calls.filter((call) => !call.startsWith('version '));

/** The last line a run printed on standard output. */
const lastLine = (output) => output.trimEnd().split('\n').at(-1);

/** Every file under the fake host, by its path from there. */
function hostFiles(sandbox) {
  if (!existsSync(sandbox.hostDir)) return [];
  return readdirSync(sandbox.hostDir, { recursive: true }).sort();
}

describe('deploy.sh names the build with tools/release/version.mjs', () => {
  it("asks it about the admin's folder, before anything is sent or built", () => {
    const sandbox = makeSandbox({ ...withProfile(), host: HOST_WITH_PROFILE });

    const deployed = sandbox.runScript(DEPLOY, remoteQa(sandbox));

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.equal(deployed.calls[0], 'version --app apps/web2-admin');
    assert.equal(deployed.calls.filter((call) => call.startsWith('version ')).length, 1);
  });

  it('writes the commit alone into deploy/.deployed-commit, the -dirty being part of the label', () => {
    const sandbox = makeSandbox(withProfile());

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA, {
      env: { FAKE_VERSION_TAG: '', FAKE_VERSION_LABEL: `${TAG}+2-dirty` },
    });

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.equal(readFileSync(sandbox.inCheckout('apps/web2-admin/deploy/.deployed-commit'), 'utf8'), `${COMMIT}\n`);
  });

  it('says which build a tagged commit deploys as, and offers no tag script', () => {
    const sandbox = makeSandbox(withProfile());

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(
      deployed.stdout,
      new RegExp(`^\\[deploy\\] version ${TAG} \\(${SHORT}\\), from the tag on this commit$`, 'm'),
    );
    assert.doesNotMatch(deployed.stdout + deployed.stderr, /no tag|tag script/i);
  });
});

describe("the version reaches the host's compose environment", () => {
  const BUILT = { version: TAG, commit: COMMIT };

  it('over ssh, where compose builds from the folder rsync sent', () => {
    const sandbox = makeSandbox({ ...withProfile(), host: HOST_WITH_PROFILE });

    const deployed = sandbox.runScript(DEPLOY, remoteQa(sandbox));

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.deepEqual(sandbox.composeEnv(), [{ ...BUILT, inCopy: false }]);
  });

  it('on this machine, where compose builds from the checkout', () => {
    const sandbox = makeSandbox(withProfile());

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.deepEqual(sandbox.composeEnv(), [{ ...BUILT, inCopy: false }]);
  });

  it('on this machine, where compose builds from the copy tools/app-workspace/in-copy.mjs makes', () => {
    const sandbox = makeSandbox({ checkout: oneWorkspaceCheckout(), cutTool: true });
    execFileSync('git', ['init', '-q', sandbox.root], { env: isolatedGitEnv(), stdio: 'ignore' });

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.ok(
      deployed.calls.some((call) => call.startsWith('docker compose ') && call.includes('docker-compose.copy.yml')),
      deployed.calls.join('\n'),
    );
    assert.deepEqual(sandbox.composeEnv(), [{ ...BUILT, inCopy: true }]);
  });

  it('carries a label past a tag, with -dirty, as version.mjs named it', () => {
    const sandbox = makeSandbox(withProfile());
    const label = `${TAG}+3-dirty`;

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA, { env: { FAKE_VERSION_TAG: '', FAKE_VERSION_LABEL: label } });

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.deepEqual(sandbox.composeEnv(), [{ version: label, commit: COMMIT, inCopy: false }]);
  });
});

describe('a version deploy.sh cannot carry safely is refused before anything runs on the host', () => {
  /** Labels that would end the quotes they sit in on the host, run a command there, or say nothing. */
  const UNSAFE_LABELS = [
    "QA'; touch pwned; echo '",
    'QA$(touch pwned)',
    'QA`touch pwned`',
    'QA build',
    'QA;build',
    'QA-büild',
    '',
    'a'.repeat(97),
  ];

  for (const label of UNSAFE_LABELS) {
    it(`refuses the label ${JSON.stringify(label.length > 20 ? `${label.slice(0, 20)}…` : label)}`, () => {
      const sandbox = makeSandbox({ ...withProfile(), host: HOST_WITH_PROFILE });
      const before = hostFiles(sandbox);

      const refused = sandbox.runScript(DEPLOY, remoteQa(sandbox), { env: { FAKE_VERSION_LABEL: label } });

      assert.equal(refused.status, 1, refused.stderr);
      assert.match(
        refused.stderr,
        /named the build .*A label holds 1 to 96 letters, digits and \. _ \+ \/ -.*Nothing was deployed\./,
      );
      assert.deepEqual(hostCalls(refused), [], 'something ran after the refusal');
      assert.deepEqual(hostFiles(sandbox), before, 'the host changed');
      assert.equal(existsSync(sandbox.inCheckout('apps/web2-admin/deploy/.deployed-commit')), false);
    });
  }

  it('refuses a commit that is not 40 lowercase hex characters', () => {
    for (const commit of ['', SHORT, COMMIT.toUpperCase(), `${COMMIT}-dirty`, `${COMMIT.slice(1)}'`]) {
      const sandbox = makeSandbox({ ...withProfile(), host: HOST_WITH_PROFILE });

      const refused = sandbox.runScript(DEPLOY, remoteQa(sandbox), {
        env: { FAKE_VERSION_COMMIT: commit, FAKE_VERSION_LABEL: TAG },
      });

      assert.equal(refused.status, 1, `${commit}: ${refused.stderr}`);
      assert.match(refused.stderr, /named the commit .*which is not 40 lowercase hex characters/);
      assert.deepEqual(hostCalls(refused), [], commit);
    }
  });

  it('refuses a tag that holds anything but letters, digits and . _ + / -', () => {
    const sandbox = makeSandbox({ ...withProfile(), host: HOST_WITH_PROFILE });

    const refused = sandbox.runScript(DEPLOY, remoteQa(sandbox), {
      env: { FAKE_VERSION_TAG: 'QA build', FAKE_VERSION_LABEL: TAG },
    });

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /named the tag /);
    assert.deepEqual(hostCalls(refused), []);
  });

  it('stops with the reason version.mjs gives when it cannot name the build', () => {
    const sandbox = makeSandbox({ ...withProfile(), host: HOST_WITH_PROFILE });

    const refused = sandbox.runScript(DEPLOY, remoteQa(sandbox), {
      env: { FAKE_VERSION_FAILS: '/somewhere is not inside a git checkout' },
    });

    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /version: \/somewhere is not inside a git checkout/);
    assert.match(refused.stderr, /could not name the build, for the reason above\. Nothing was deployed\./);
    assert.deepEqual(hostCalls(refused), []);
  });
});

describe('a run without a terminal never prompts', () => {
  it('says in one line that the commit has no tag and what it deploys as, runs no tag script, and deploys', () => {
    const sandbox = makeSandbox({ ...withProfile(), host: HOST_WITH_PROFILE });
    const label = `${TAG}+2`;

    const deployed = sandbox.runScript(DEPLOY, remoteQa(sandbox), {
      env: { FAKE_VERSION_TAG: '', FAKE_VERSION_LABEL: label },
    });

    assert.equal(deployed.status, 0, deployed.stderr);
    const said = deployed.stdout.split('\n').filter((line) => /no tag/i.test(line));
    assert.deepEqual(said, [`[deploy] this commit has no tag: it deploys as ${label}`]);
    assert.doesNotMatch(deployed.stdout + deployed.stderr, /Run the tag script now|\[y\/N\]/);
    assert.equal(deployed.calls.filter((call) => call.startsWith('tag')).length, 0, 'the tag script ran');
    assert.equal(deployed.calls.filter((call) => call.startsWith('version ')).length, 1, 'the version was asked twice');
    assert.deepEqual(sandbox.composeEnv(), [{ version: label, commit: COMMIT, inCopy: false }]);
  });

  it('does the same for a commit with no tag behind it, named by its short commit', () => {
    const sandbox = makeSandbox(withProfile());

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA, { env: { FAKE_VERSION_TAG: '' } });

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stdout, new RegExp(`^\\[deploy\\] this commit has no tag: it deploys as ${SHORT}$`, 'm'));
    assert.doesNotMatch(deployed.stdout + deployed.stderr, /Run the tag script now/);
  });
});

describe('the check that the api container runs the build just made', () => {
  it('passes when it reports the version just built, and the last line names the build', () => {
    const sandbox = makeSandbox(withProfile());

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stdout, new RegExp(`the api container runs ${TAG} at ${COMMIT}, the build just made`));
    assert.equal(lastLine(deployed.stdout), `[deploy] deployed ${TAG} (${SHORT})`);
  });

  it('names a build with no tag behind it once in the last line, not twice', () => {
    const sandbox = makeSandbox(withProfile());

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA, {
      env: { FAKE_VERSION_TAG: '', FAKE_VERSION_LABEL: `${SHORT}-dirty` },
    });

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.equal(lastLine(deployed.stdout), `[deploy] deployed ${SHORT}-dirty`);
  });

  /** What the api container may report instead, and what the deploy then says it found. */
  const MISMATCHES = [
    {
      name: 'an older version',
      env: { FAKE_API_VERSION: 'QA-build-older' },
      found: `version QA-build-older at commit ${COMMIT}`,
    },
    {
      name: 'another commit',
      env: { FAKE_API_COMMIT: OTHER_COMMIT },
      found: `version ${TAG} at commit ${OTHER_COMMIT}`,
    },
    {
      name: 'no version at all',
      env: { FAKE_API_VERSION: '', FAKE_API_COMMIT: '' },
      found: 'version (none) at commit (none)',
    },
  ];

  for (const { name, env, found } of MISMATCHES) {
    it(`fails when it reports ${name}, and does not say it deployed`, () => {
      const sandbox = makeSandbox(withProfile());

      const failed = sandbox.runScript(DEPLOY, LOCAL_QA, { env });

      assert.equal(failed.status, 1, failed.stderr);
      assert.ok(
        failed.stderr.includes(
          `ERROR: the api container reports ${found}, but this deploy built ${TAG} at ${COMMIT}. The build just made is not what runs.`,
        ),
        failed.stderr,
      );
      assert.doesNotMatch(failed.stdout, /deployed /);
    });
  }

  it('fails the same way over ssh', () => {
    const sandbox = makeSandbox({ ...withProfile(), host: HOST_WITH_PROFILE });

    const failed = sandbox.runScript(DEPLOY, remoteQa(sandbox), { env: { FAKE_API_VERSION: 'QA-build-older' } });

    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /the api container reports version QA-build-older/);
    assert.doesNotMatch(failed.stdout, /deployed /);
  });

  it('leaves the api unchecked when the deploy names other services, and says so', () => {
    const sandbox = makeSandbox(withProfile());

    const deployed = sandbox.runScript(DEPLOY, [...LOCAL_QA, 'web'], { env: { FAKE_API_VERSION: 'QA-build-older' } });

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stdout, /the api was not part of this deploy, so the build it runs was not checked/);
  });
});

describe('the env file and the version', () => {
  /** Every form compose's env file parser takes as an assignment, even an empty one, with the key it assigns. */
  const ASSIGNMENTS = [
    ['WEB2_ADMIN_VERSION=QA-build-1', 'WEB2_ADMIN_VERSION'],
    ['WEB2_ADMIN_COMMIT=', 'WEB2_ADMIN_COMMIT'],
    ['  WEB2_ADMIN_VERSION=""', 'WEB2_ADMIN_VERSION'],
    ['export WEB2_ADMIN_VERSION=x', 'WEB2_ADMIN_VERSION'],
    ['WEB2_ADMIN_COMMIT = y', 'WEB2_ADMIN_COMMIT'],
    ['WEB2_ADMIN_VERSION: z', 'WEB2_ADMIN_VERSION'],
  ];

  for (const [line, key] of ASSIGNMENTS) {
    it(`refuses an env file with ${JSON.stringify(line)} before anything runs on the host`, () => {
      const sandbox = makeSandbox({
        checkout: { [QA_ENV]: `${fakeAdminEnv('version-in-env')}${line}\n` },
        host: HOST_WITH_PROFILE,
      });
      const before = hostFiles(sandbox);

      const refused = sandbox.runScript(DEPLOY, remoteQa(sandbox));

      assert.equal(refused.status, 1, refused.stderr);
      assert.match(
        refused.stderr,
        new RegExp(`ERROR: \\S+: ${key} is set by deploy\\.sh, which builds it into the api image`),
      );
      assert.deepEqual(refused.calls, [], 'a tool ran before the refusal');
      assert.deepEqual(hostFiles(sandbox), before, 'the host changed');
    });
  }

  /** Lines compose reads as another key, or not at all, which deploy like any other line. */
  const LOOKALIKES = [
    `OLD_WEB2_ADMIN_COMMIT=${OTHER_COMMIT}`,
    'WEB2_ADMIN_VERSIONS=QA-build-1',
    'WEB2_ADMIN_COMMIT_NOTE=kept for the record',
    '# export WEB2_ADMIN_VERSION=QA-build-1',
  ];

  for (const line of LOOKALIKES) {
    it(`deploys an env file with ${JSON.stringify(line)}, which sets neither key`, () => {
      const sandbox = makeSandbox({ checkout: { [QA_ENV]: `${fakeAdminEnv('lookalike')}${line}\n` } });

      const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.doesNotMatch(deployed.stderr, /is set by deploy\.sh/);
      assert.equal(lastLine(deployed.stdout), `[deploy] deployed ${TAG} (${SHORT})`);
    });
  }
});

describe('deploy.sh with the real tools/release/version.mjs', () => {
  /** A checkout whose env files and deploy marker git ignores, as the repository's .gitignore does. */
  const IGNORES = '.env\n.env.*\n!.env.sample\napps/web2-admin/deploy/.deployed-commit\n';

  /** Runs the machine's git in the sandbox's checkout, reading none of this machine's settings. */
  function git(sandbox, ...args) {
    return execFileSync('git', args, {
      cwd: sandbox.root,
      encoding: 'utf8',
      env: {
        ...isolatedGitEnv(),
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** A sandbox whose checkout is a repository with everything committed and tagged QA-fixture-1. */
  function taggedSandbox() {
    const sandbox = makeSandbox({ ...withProfile({ '.gitignore': IGNORES }), realVersion: true });
    git(sandbox, 'init', '-q');
    git(sandbox, 'add', '-A');
    git(sandbox, 'commit', '-q', '-m', 'the fixture');
    git(sandbox, 'tag', '-a', 'QA-fixture-1', '-m', 'the fixture tag');
    return sandbox;
  }

  it('deploys a tagged commit as its tag, and its commit', () => {
    const sandbox = taggedSandbox();
    const head = git(sandbox, 'rev-parse', 'HEAD');

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.deepEqual(sandbox.composeEnv(), [{ version: 'QA-fixture-1', commit: head, inCopy: false }]);
    assert.equal(lastLine(deployed.stdout), `[deploy] deployed QA-fixture-1 (${head.slice(0, 9)})`);
  });

  it('deploys a commit past the tag, with changes not committed, as the tag, how far past it, and -dirty', () => {
    const sandbox = taggedSandbox();
    const notes = sandbox.inCheckout('apps/web2-admin/NOTES.md');
    writeFileSync(notes, 'one commit past the tag\n');
    git(sandbox, 'add', '-A');
    git(sandbox, 'commit', '-q', '-m', 'past the tag');
    writeFileSync(notes, 'and a change not committed\n');
    const head = git(sandbox, 'rev-parse', 'HEAD');

    const deployed = sandbox.runScript(DEPLOY, LOCAL_QA);

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.match(deployed.stdout, /^\[deploy\] this commit has no tag: it deploys as QA-fixture-1\+1-dirty$/m);
    assert.deepEqual(sandbox.composeEnv(), [{ version: 'QA-fixture-1+1-dirty', commit: head, inCopy: false }]);
  });
});

describe('the images the version is built into', () => {
  const DEPLOY_DIR = fileURLToPath(new URL('..', import.meta.url));
  const APP_DIR = dirname(DEPLOY_DIR);

  /** The compose files rendered as compose loads them, with a version exported, without a daemon. */
  function render(files, copy) {
    const env = {
      ...process.env,
      WEB2_ADMIN_ENV_FILE: '../backend/.env.sample',
      POSTGRES_PASSWORD: 'placeholder',
      WEB2_ADMIN_VERSION: `${TAG}+3-dirty`,
      WEB2_ADMIN_COMMIT: COMMIT,
    };
    if (copy === undefined) delete env.APP_WORKSPACE_COPY;
    else env.APP_WORKSPACE_COPY = copy;
    return spawnSync('docker', ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'], {
      cwd: DEPLOY_DIR,
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });
  }

  for (const [name, files, copy] of [
    ['from the checkout', ['docker-compose.yml'], undefined],
    ['from the copy in-copy.mjs makes', ['docker-compose.yml', 'docker-compose.copy.yml'], '/copy/of/the/admin'],
  ]) {
    it(`gives both images the version as build arguments when compose builds ${name}`, (t) => {
      const rendered = render(files, copy);
      if (rendered.error?.code === 'ENOENT') {
        t.skip('docker is not available on this host');
        return;
      }

      assert.equal(rendered.status, 0, rendered.stderr);
      const { services } = JSON.parse(rendered.stdout);
      for (const service of ['api', 'web']) {
        assert.deepEqual(
          services[service].build.args,
          { WEB2_ADMIN_VERSION: `${TAG}+3-dirty`, WEB2_ADMIN_COMMIT: COMMIT },
          service,
        );
      }
    });
  }

  /** The lines of a Dockerfile's last stage, the one the image runs, without comments. */
  const runtimeStage = (project) => {
    const dockerfile = readFileSync(join(APP_DIR, project, 'Dockerfile'), 'utf8');
    return dockerfile
      .slice(dockerfile.lastIndexOf('\nFROM '))
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  };

  /** The two OCI labels, each set from its build argument. */
  const OCI_LABELS = new RegExp(
    [
      String.raw`^LABEL org\.opencontainers\.image\.version=\$WEB2_ADMIN_VERSION \\`,
      String.raw`\s+org\.opencontainers\.image\.revision=\$WEB2_ADMIN_COMMIT$`,
    ].join('\n'),
    'm',
  );

  /** Where the first line that declares the version's build arguments is, after every line that adds a layer. */
  function assertVersionLast(lines) {
    const firstArg = lines.findIndex((line) => /^ARG WEB2_ADMIN_(VERSION|COMMIT)\b/.test(line));
    const lastLayer = lines.findLastIndex((line) => /^(RUN|COPY|ADD)\b/.test(line));
    assert.notEqual(firstArg, -1, 'the stage declares no version');
    assert.ok(
      firstArg > lastLayer,
      `the version is declared before a layer, which a new version would rebuild:\n${lines.join('\n')}`,
    );
  }

  it('builds the version into the api image last, in its environment and its labels', () => {
    const lines = runtimeStage('backend');
    assertVersionLast(lines);
    const text = lines.join('\n');
    assert.match(text, /^ENV WEB2_ADMIN_VERSION=\$WEB2_ADMIN_VERSION \\\n\s+WEB2_ADMIN_COMMIT=\$WEB2_ADMIN_COMMIT$/m);
    assert.match(text, OCI_LABELS);
  });

  it('gives the console image the labels alone, last', () => {
    const lines = runtimeStage('frontend');
    assertVersionLast(lines);
    const text = lines.join('\n');
    assert.match(text, OCI_LABELS);
    assert.doesNotMatch(text, /^ENV WEB2_ADMIN_/m);
  });
});

/** The root lockfile of a one-workspace checkout whose admin has one project of its own and one package. */
const ROOT_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  apps/web2-admin: {}

  apps/web2-admin/backend:
    dependencies:
      express:
        specifier: 5.2.1
        version: 5.2.1

packages:

  express@5.2.1:
    resolution: {integrity: sha512-express}

snapshots:

  express@5.2.1: {}
`;

/** A checkout of the one workspace holding the admin with no lockfile of its own, and a qa profile. */
function oneWorkspaceCheckout() {
  const manifest = (name) =>
    `${JSON.stringify({ name, private: true, packageManager: 'pnpm@11.11.0+sha512.0123abcd' })}\n`;
  return {
    'package.json': manifest('monorepo'),
    'pnpm-lock.yaml': ROOT_LOCKFILE,
    'pnpm-workspace.yaml': 'packages:\n  - apps/web2-admin\n  - apps/web2-admin/backend\n',
    'apps/web2-admin/package.json': manifest('@streaming-monorepo/web2-admin'),
    'apps/web2-admin/backend/package.json': manifest('@streaming-monorepo/web2-admin-backend'),
    [QA_ENV]: fakeAdminEnv('one-workspace'),
    '.gitignore': '.env\n.env.*\n!.env.sample\n',
  };
}
