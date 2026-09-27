import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, it } from 'node:test';

import { REAL_RSYNC, fakeAdminEnv, makeSandbox, removeSandboxes } from './helpers/sandbox.mjs';

after(removeSandboxes);

const DEPLOY = 'apps/web2-admin/deploy/deploy.sh';
const PACKAGE_MANAGER = 'pnpm@11.11.0+sha512.0123abcd';
const manifest = (name) => `${JSON.stringify({ name, private: true, packageManager: PACKAGE_MANAGER })}\n`;

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
function oneWorkspaceCheckout(extra = {}) {
  return {
    'package.json': manifest('monorepo'),
    'pnpm-lock.yaml': ROOT_LOCKFILE,
    'pnpm-workspace.yaml': 'packages:\n  - apps/web2-admin\n  - apps/web2-admin/backend\n',
    'apps/web2-admin/package.json': manifest('@streaming-monorepo/web2-admin'),
    'apps/web2-admin/backend/package.json': manifest('@streaming-monorepo/web2-admin-backend'),
    'apps/web2-admin/backend/.env.qa': fakeAdminEnv('one-workspace'),
    '.gitignore': '.env\n.env.*\n!.env.sample\n',
    ...extra,
  };
}

/**
 * The fake host as an earlier admin deploy left it. deploy.sh refuses to rsync --delete into a
 * folder that is neither empty nor such a deploy, the rsync stub copies nothing to the host, and the
 * host's script reaches for the profile's env file first.
 */
const HOST_WITH_PROFILE = {
  'deploy/deploy.sh': '# an earlier deploy\n',
  'backend/Dockerfile': 'FROM scratch\n',
  'backend/.env.qa': fakeAdminEnv('host'),
};

const folders = [];
after(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

function ownFolder(label) {
  const dir = mkdtempSync(join(tmpdir(), label));
  folders.push(dir);
  return dir;
}

/** What tools/app-workspace writes for the admin of the sandbox's checkout. */
function expectedCut(sandbox) {
  const out = join(ownFolder('expected-cut-'), 'cut');
  execFileSync(process.execPath, [
    sandbox.inCheckout('tools/app-workspace/cut.mjs'),
    '--root',
    sandbox.root,
    '--app',
    'apps/web2-admin',
    '--out',
    out,
  ]);
  return (file) => readFileSync(join(out, file), 'utf8');
}

/** Every file and link under `dir`, by its path from there: a file's text, or `-> ` and a link's target. */
function treeOf(dir) {
  const tree = {};
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) tree[relative(dir, path)] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path);
      else tree[relative(dir, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return tree;
}

function writeInto(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** The rsync line in a run's stub calls, as its words. */
const rsyncWords = (deployed) => (deployed.calls.find((call) => call.startsWith('rsync ')) ?? '').split(' ');

describe('deploy.sh from a checkout of the one workspace', () => {
  it("sends the admin's pair cut out of the root's as a second rsync source, and leaves nothing behind", () => {
    const sandbox = makeSandbox({ checkout: oneWorkspaceCheckout(), cutTool: true, host: HOST_WITH_PROFILE });
    const tmp = ownFolder('admin-tmp-');
    const snapshot = join(ownFolder('admin-snapshot-'), 'sent');

    const deployed = sandbox.runScript(
      DEPLOY,
      ['--host=fixture-host', '--profile=qa', `--remote-path=${sandbox.hostDir}`],
      {
        env: { TMPDIR: tmp, RSYNC_SNAPSHOT_DIR: snapshot },
      },
    );

    assert.equal(deployed.status, 0, deployed.stderr);
    const expected = expectedCut(sandbox);
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      assert.equal(readFileSync(join(snapshot, file), 'utf8'), expected(file), `the rsync carried the cut ${file}`);
    }
    assert.ok(rsyncWords(deployed).includes('./'), "the admin's own folder is sent as before");
    assert.deepEqual(readdirSync(tmp), [], 'the cut folder is gone');
    assert.equal(
      existsSync(sandbox.inCheckout('apps/web2-admin/pnpm-lock.yaml')),
      false,
      'nothing was written into the checkout',
    );
  });

  it('builds locally from a copy with the cut in it, while compose runs from the checkout', () => {
    const sandbox = makeSandbox({ checkout: oneWorkspaceCheckout(), cutTool: true });
    execFileSync('git', ['init', '-q', sandbox.root]);
    const tmp = ownFolder('admin-tmp-');

    const deployed = sandbox.runScript(DEPLOY, ['--host=localhost', '--profile=qa'], { env: { TMPDIR: tmp } });

    assert.equal(deployed.status, 0, deployed.stderr);
    const app = sandbox.inCheckout('apps/web2-admin');
    const up = deployed.calls.find((call) => call.startsWith('docker compose ') && call.includes(' up '));
    assert.ok(up, 'compose was asked to bring the admin up');
    assert.ok(up.includes(`--project-directory ${join(app, 'deploy')}`), up);
    assert.ok(up.includes(`-f ${join(app, 'deploy', 'docker-compose.copy.yml')}`), up);
    const copied = sandbox.copies();
    for (const file of ['./pnpm-lock.yaml', './pnpm-workspace.yaml', './backend/package.json']) {
      assert.ok(copied.includes(file), `the copy held ${file}: ${copied.join(' ')}`);
    }
    assert.equal(copied.includes('./backend/.env.qa'), false, 'an env file stays in the checkout');
    assert.deepEqual(readdirSync(tmp), [], 'the copy is gone');
  });
});

describe('deploy.sh with the real rsync', () => {
  /** A host an admin deploy reached before the one workspace: its own lockfile, a file since deleted, and the edge's. */
  const EARLIER_HOST = {
    ...HOST_WITH_PROFILE,
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# the admin's own, from before the one workspace\n",
    'stale.txt': 'a file the checkout no longer has\n',
    'deploy/edge/docker-compose.yml': "# the host's edge, which an admin deploy never touches\n",
  };

  it("leaves the host as rsync --delete leaves it from the admin's folder alone, and the admin's pair besides", () => {
    const sandbox = makeSandbox({
      checkout: oneWorkspaceCheckout(),
      cutTool: true,
      host: EARLIER_HOST,
      realRsync: true,
    });
    const tmp = ownFolder('admin-tmp-');

    const deployed = sandbox.runScript(
      DEPLOY,
      ['--host=fixture-host', '--profile=qa', `--remote-path=${sandbox.hostDir}`],
      {
        env: { TMPDIR: tmp },
      },
    );

    assert.equal(deployed.status, 0, deployed.stderr);
    const argv = sandbox.rsyncArgv();
    const cutSources = argv.filter((arg) => arg.startsWith(tmp));
    assert.equal(cutSources.length, 1, `one source under TMPDIR, the cut: ${argv.join(' ')}`);
    const alone = join(ownFolder('admin-alone-'), 'host');
    writeInto(alone, EARLIER_HOST);
    const aloneArgv = [...argv.filter((arg) => arg !== cutSources[0]).slice(0, -1), `${alone}/`];
    const aloneRun = spawnSync(REAL_RSYNC, aloneArgv, { cwd: sandbox.inCheckout('apps/web2-admin'), encoding: 'utf8' });
    assert.equal(aloneRun.status, 0, aloneRun.stderr);

    const cut = expectedCut(sandbox);
    const withoutPair = treeOf(alone);
    assert.deepEqual(treeOf(sandbox.rsyncAfter), {
      ...withoutPair,
      'pnpm-lock.yaml': cut('pnpm-lock.yaml'),
      'pnpm-workspace.yaml': cut('pnpm-workspace.yaml'),
    });
    assert.equal(withoutPair['stale.txt'], undefined, '--delete removed what the checkout no longer has');
    assert.equal(withoutPair['pnpm-lock.yaml'], undefined, "alone, --delete would have removed the host's lockfile");
    assert.equal(withoutPair['deploy/edge/docker-compose.yml'], EARLIER_HOST['deploy/edge/docker-compose.yml']);
  });
});

describe('docker-compose.copy.yml', () => {
  const DEPLOY_DIR = new URL('..', import.meta.url).pathname;

  /** The two compose files rendered as compose loads them, without a daemon, bounded against a wedged CLI. */
  function render(copy) {
    const env = { ...process.env, WEB2_ADMIN_ENV_FILE: '../backend/.env.sample', POSTGRES_PASSWORD: 'placeholder' };
    if (copy === undefined) delete env.APP_WORKSPACE_COPY;
    else env.APP_WORKSPACE_COPY = copy;
    return spawnSync(
      'docker',
      ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.copy.yml', 'config', '--format', 'json'],
      {
        cwd: DEPLOY_DIR,
        encoding: 'utf8',
        env,
        timeout: 30_000,
      },
    );
  }

  it("moves the two images' build context to the copy, each keeping its own Dockerfile", (t) => {
    const rendered = render('/copy/of/the/admin');
    if (rendered.error?.code === 'ENOENT') {
      t.skip('docker is not available on this host');
      return;
    }

    assert.equal(rendered.status, 0, rendered.stderr);
    const { services } = JSON.parse(rendered.stdout);
    assert.equal(services.api.build.context, '/copy/of/the/admin');
    assert.equal(services.api.build.dockerfile, 'backend/Dockerfile');
    assert.equal(services.web.build.context, '/copy/of/the/admin');
    assert.equal(services.web.build.dockerfile, 'frontend/Dockerfile');
  });

  it('refuses to render without a copy named, rather than build from somewhere else', (t) => {
    const rendered = render(undefined);
    if (rendered.error?.code === 'ENOENT') {
      t.skip('docker is not available on this host');
      return;
    }

    assert.notEqual(rendered.status, 0, 'compose rendered a build context from an unset copy');
    assert.match(rendered.stderr, /in-copy\.mjs/);
  });
});

describe('deploy.sh for an admin that keeps its own pair', () => {
  const ownPair = {
    'apps/web2-admin/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'apps/web2-admin/pnpm-workspace.yaml': 'packages:\n  - backend\n',
  };

  it('sends its folder alone, as before', () => {
    const sandbox = makeSandbox({ checkout: oneWorkspaceCheckout(ownPair), cutTool: true, host: HOST_WITH_PROFILE });
    const snapshot = join(ownFolder('admin-snapshot-'), 'sent');
    mkdirSync(snapshot, { recursive: true });

    const deployed = sandbox.runScript(
      DEPLOY,
      ['--host=fixture-host', '--profile=qa', `--remote-path=${sandbox.hostDir}`],
      {
        env: { TMPDIR: ownFolder('admin-tmp-'), RSYNC_SNAPSHOT_DIR: snapshot },
      },
    );

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.deepEqual(readdirSync(snapshot), [], 'no second source was sent');
  });

  it('builds locally from its own folder, as before', () => {
    const sandbox = makeSandbox({ checkout: oneWorkspaceCheckout(ownPair), cutTool: true });

    const deployed = sandbox.runScript(DEPLOY, ['--host=localhost', '--profile=qa'], {
      env: { TMPDIR: ownFolder('admin-tmp-') },
    });

    assert.equal(deployed.status, 0, deployed.stderr);
    const up = deployed.calls.find((call) => call.startsWith('docker compose ') && call.includes(' up '));
    assert.ok(up, 'compose was asked to bring the admin up');
    assert.equal(up.includes('docker-compose.copy.yml'), false, up);
    assert.deepEqual(sandbox.copies(), []);
  });
});
