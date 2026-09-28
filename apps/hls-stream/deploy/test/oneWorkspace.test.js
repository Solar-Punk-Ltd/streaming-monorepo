import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
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
import { dirname, join, relative, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, BENCH_TARGET, GIT_STUB, makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';
import { classifySpawn, SPAWN_ABSENT, SPAWN_OK, SPAWN_TIMED_OUT } from './helpers/spawnOutcome.js';

/** `docker compose config` parses files without the daemon, so this bound only guards a wedged CLI. */
const COMPOSE_CONFIG_TIMEOUT_MS = 30_000;

after(removeSandboxes);

const STACK = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The repository's own cut tool, which a checkout of the one workspace carries at its root. */
const TOOL = resolve(STACK, '../../tools/app-workspace');
const DEPLOY_DIR_IN = (sandbox) => join(sandbox.root, 'deploy');

/** Where `deploy.sh` puts a deployment on a remote host, as `_lib.sh` hardcodes it. */
const REMOTE_BASE = 'swarm-hls-stream';
const PACKAGE_MANAGER = 'pnpm@11.11.0+sha512.0123abcd';

/** The root lockfile of a one-workspace checkout whose stack has one package of its own. */
const ROOT_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  apps/hls-stream:
    devDependencies:
      typescript:
        specifier: 5.6.3
        version: 5.6.3

  apps/hls-stream/packages/shared:
    dependencies:
      zod:
        specifier: 4.4.3
        version: 4.4.3

  apps/web2-admin:
    dependencies:
      react:
        specifier: 18.3.1
        version: 18.3.1

packages:

  react@18.3.1:
    resolution: {integrity: sha512-react}

  typescript@5.6.3:
    resolution: {integrity: sha512-typescript}

  zod@4.4.3:
    resolution: {integrity: sha512-zod}

snapshots:

  react@18.3.1: {}

  typescript@5.6.3: {}

  zod@4.4.3: {}
`;

const ROOT_WORKSPACE = 'packages:\n  - apps/hls-stream\n  - apps/hls-stream/packages/*\n  - apps/web2-admin\n';

/**
 * The same root with a package every app shares, `packages/contracts`, which the stack's shared
 * package links. A cut carries it into `workspace-packages/contracts`.
 */
const SHARED_ROOT_LOCKFILE = ROOT_LOCKFILE.replace(
  `  apps/hls-stream/packages/shared:
    dependencies:
`,
  `  apps/hls-stream/packages/shared:
    dependencies:
      '@example/contracts':
        specifier: workspace:*
        version: link:../../../../packages/contracts
`,
).replace(
  `packages:

  react@18.3.1:`,
  `  packages/contracts:
    dependencies:
      zod:
        specifier: 4.4.3
        version: 4.4.3

packages:

  react@18.3.1:`,
);

const SHARED_ROOT_WORKSPACE = `${ROOT_WORKSPACE}  - packages/*\n`;

const manifest = (name) => `${JSON.stringify({ name, private: true, packageManager: PACKAGE_MANAGER })}\n`;

/** The shared package's files, as a checkout of that root holds them. */
const SHARED_PACKAGE_FILES = {
  'packages/contracts/package.json': manifest('@example/contracts'),
  'packages/contracts/src/index.ts': 'export {};\n',
};

/** The stack's files an image build reads, seeded as a checkout would hold them, the uploader's dist built. */
const STACK_FILES = {
  'package.json': manifest('swarm-hls-stream'),
  'packages/shared/package.json': manifest('@swarm-hls-stream/shared'),
  'packages/stream-uploader/package.json': manifest('@swarm-hls-stream/stream-uploader'),
  'packages/stream-uploader/dist/index.js': 'built\n',
  'packages/client/package.json': manifest('@swarm-hls-stream/client'),
  'deploy/Dockerfile.uploader': 'FROM scratch\n',
  'deploy/Dockerfile.client': 'FROM scratch\n',
};

const workspaces = [];
after(() => {
  for (const dir of workspaces) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/**
 * A checkout of the one workspace with the stack in a sandbox at apps/hls-stream. The stack's folder
 * holds no lockfile of its own unless `ownPair` gives it one, the way a checkout from before the root
 * lockfile does. A git repository, because in-copy.mjs copies the files git sees.
 */
function oneWorkspace({ config, ownPair = false, realRsync = false, sharedPackage = false } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'one-workspace-'));
  workspaces.push(workspace);
  write(workspace, {
    'package.json': manifest('monorepo'),
    'pnpm-lock.yaml': sharedPackage ? SHARED_ROOT_LOCKFILE : ROOT_LOCKFILE,
    'pnpm-workspace.yaml': sharedPackage ? SHARED_ROOT_WORKSPACE : ROOT_WORKSPACE,
    '.gitignore': 'node_modules/\ndist/\n.env\n.env.*\n',
    ...(sharedPackage ? SHARED_PACKAGE_FILES : {}),
  });
  cpSync(TOOL, join(workspace, 'tools', 'app-workspace'), { recursive: true });
  const sandbox = makeSandbox({ config, root: join(workspace, 'apps', 'hls-stream'), realRsync });
  write(sandbox.root, STACK_FILES);
  if (ownPair) {
    write(sandbox.root, {
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# the stack's own\n",
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });
  }
  execFileSync('git', ['init', '-q', workspace]);
  return { workspace, sandbox };
}

/** Every file and link under `dir`, by its path from there: a file's text, or `-> ` and a link's target. */
function treeOf(dir) {
  const tree = {};
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) {
        tree[relative(dir, path)] = `-> ${readlinkSync(path)}`;
      } else if (entry.isDirectory()) {
        walk(path);
      } else {
        tree[relative(dir, path)] = readFileSync(path, 'utf8');
      }
    }
  };
  walk(dir);
  return tree;
}

/** What tools/app-workspace writes for the stack of `workspace`, run here into a folder of the test's own. */
function expectedCut(workspace) {
  const out = mkdtempSync(join(tmpdir(), 'expected-cut-'));
  workspaces.push(out);
  execFileSync(process.execPath, [
    join(TOOL, 'cut.mjs'),
    '--root',
    workspace,
    '--app',
    'apps/hls-stream',
    '--out',
    join(out, 'cut'),
  ]);
  return {
    lockfile: readFileSync(join(out, 'cut', 'pnpm-lock.yaml'), 'utf8'),
    workspace: readFileSync(join(out, 'cut', 'pnpm-workspace.yaml'), 'utf8'),
  };
}

/** A TMPDIR of the test's own, empty, so what a deploy leaves in it can be seen. */
function ownTmpdir() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-tmp-'));
  workspaces.push(dir);
  return dir;
}

/** Every argv of a local `docker compose ... up` call. */
function composeUps(sandbox) {
  return sandbox.calls().filter((call) => call.startsWith('compose ') && call.includes(' up '));
}

describe('a remote deploy from a checkout of the one workspace', () => {
  it("sends the stack's lockfile and workspace file cut out of the root's, where the stack's own went", async () => {
    const { workspace, sandbox } = oneWorkspace({ config: ALL_REMOTE });

    await runScriptOk(sandbox, 'deploy.sh', ['stream-uploader'], { TMPDIR: ownTmpdir() });

    const cut = expectedCut(workspace);
    assert.equal(readFileSync(join(sandbox.remoteHome, REMOTE_BASE, 'pnpm-lock.yaml'), 'utf8'), cut.lockfile);
    assert.equal(readFileSync(join(sandbox.remoteHome, REMOTE_BASE, 'pnpm-workspace.yaml'), 'utf8'), cut.workspace);
    assert.ok(sandbox.remoteHas(join(REMOTE_BASE, 'package.json')), "the stack's own package.json still goes");
  });

  /**
   * The cut carries each package the stack links from the root's `packages/` into its own
   * `workspace-packages/`, and its lockfile points there, so an image built on the far side reads the
   * package's manifest, and the client its sources, from that folder.
   */
  it('sends the shared packages the cut carries, for either image', async () => {
    for (const services of [['stream-uploader'], ['client']]) {
      const { sandbox } = oneWorkspace({ config: ALL_REMOTE, sharedPackage: true });

      await runScriptOk(sandbox, 'deploy.sh', services, { TMPDIR: ownTmpdir() });

      const carried = join(sandbox.remoteHome, REMOTE_BASE, 'workspace-packages', 'contracts');
      assert.equal(
        readFileSync(join(carried, 'package.json'), 'utf8'),
        SHARED_PACKAGE_FILES['packages/contracts/package.json'],
        `a deploy of ${services.join(' and ')} left the shared package's manifest behind`,
      );
      assert.equal(readFileSync(join(carried, 'src', 'index.ts'), 'utf8'), 'export {};\n');
      assert.match(
        readFileSync(join(sandbox.remoteHome, REMOTE_BASE, 'pnpm-lock.yaml'), 'utf8'),
        /link:\.\.\/\.\.\/workspace-packages\/contracts/,
        'the lockfile sent points at the folder sent',
      );
    }
  });

  /**
   * The contracts package sits at the root, outside the stack's folder, so its tree is asked of the
   * workspace root. `clientBuildStamp.test.js` holds what a real git answers there.
   */
  it('stamps the client with the contracts tree read from the workspace root', async () => {
    const { workspace, sandbox } = oneWorkspace({ config: ALL_REMOTE, sharedPackage: true });

    await runScriptOk(sandbox, 'deploy.sh', ['client'], { TMPDIR: ownTmpdir() });

    const asked = sandbox.gitCalls();
    assert.ok(
      asked.includes(`-C ${workspace} rev-parse HEAD:./packages/contracts`),
      `the contracts tree was not asked of the workspace root: ${asked.join(' | ')}`,
    );
    assert.ok(
      asked.some(
        (call) => call.startsWith(`-C ${workspace} status --porcelain`) && call.includes('packages/contracts'),
      ),
      `the contracts package is not in a dirty check at the workspace root: ${asked.join(' | ')}`,
    );
    assert.match(sandbox.remoteEnvFiles(), new RegExp(`^CLIENT_BUILD_CONTRACTS_TREE=${GIT_STUB.contractsTree}$`, 'm'));
  });

  it('writes the cut outside the checkout and leaves nothing behind in the temporary folder', async () => {
    const { workspace, sandbox } = oneWorkspace({ config: ALL_REMOTE });
    const tmp = ownTmpdir();

    await runScriptOk(sandbox, 'deploy.sh', ['client'], { TMPDIR: tmp });

    assert.deepEqual(readdirSync(tmp), [], 'the cut folder is gone');
    assert.equal(existsSync(join(sandbox.root, 'pnpm-lock.yaml')), false, 'nothing was written into the checkout');
    assert.equal(existsSync(join(workspace, 'apps', 'hls-stream', 'pnpm-workspace.yaml')), false);
  });

  it('removes the cut folder when the deploy fails after it was made', async () => {
    const { sandbox } = oneWorkspace({ config: ALL_REMOTE });
    const tmp = ownTmpdir();

    const run = await runScript(sandbox, 'deploy.sh', ['client'], { TMPDIR: tmp, DOCKER_STUB_UP_EXIT: '1' });

    assert.notEqual(run.exitCode, 0, 'the far side refused the deploy');
    assert.deepEqual(readdirSync(tmp), [], 'the cut folder is gone all the same');
  });
});

describe('a local deploy from a checkout of the one workspace', () => {
  it('builds the images from a copy with the cut in it, while compose runs from the checkout', async () => {
    const { workspace, sandbox } = oneWorkspace();
    const tmp = ownTmpdir();

    await runScriptOk(sandbox, 'deploy.sh', ['--host=localhost', 'stream-uploader', 'client'], { TMPDIR: tmp });

    const [up] = composeUps(sandbox);
    assert.ok(up, 'compose was asked to bring the stack up');
    assert.ok(up.includes(`--project-directory ${DEPLOY_DIR_IN(sandbox)}`), `compose runs from the checkout: ${up}`);
    assert.ok(
      up.includes(`-f ${join(DEPLOY_DIR_IN(sandbox), 'docker-compose.copy.yml')}`),
      `the copy is the build context: ${up}`,
    );

    const [copy] = sandbox.copies();
    assert.ok(copy, 'compose was pointed at a copy');
    const cut = expectedCut(workspace);
    for (const file of [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'packages/stream-uploader/dist/index.js',
      'deploy/Dockerfile.uploader',
    ]) {
      assert.ok(copy.files.includes(file), `the copy holds ${file}: ${copy.files.join(', ')}`);
    }
    assert.equal(copy.files.includes('.env'), false, 'an env file stays in the checkout');
    assert.equal(existsSync(copy.copy), false, 'the copy is gone after the deploy');
    assert.deepEqual(readdirSync(tmp), [], 'and nothing else is left in the temporary folder');
    assert.ok(cut.lockfile.includes('zod@4.4.3'), 'the expected cut holds what the stack reaches');
  });

  it('leaves the copy behind neither when compose fails', async () => {
    const { sandbox } = oneWorkspace();
    const tmp = ownTmpdir();

    const run = await runScript(sandbox, 'deploy.sh', ['--host=localhost', 'client'], {
      TMPDIR: tmp,
      DOCKER_STUB_UP_EXIT: '1',
    });

    assert.notEqual(run.exitCode, 0);
    assert.deepEqual(readdirSync(tmp), []);
  });
});

/** Where bench-on-host.sh mirrors the stack on its target, and the ledger it will not sync without. */
const REMOTE_BENCH_DIR = 'swarm-hls-bench';
const SPEND_LEDGER = '.spend-ledger.env';
const OWNER_LEDGER = 'authorised_at=2026-09-03T09:32:45Z\n';

describe('bench-on-host.sh from a checkout of the one workspace', () => {
  it("mirrors the stack with its lockfile cut out of the root's, and leaves nothing behind", async () => {
    const { workspace, sandbox } = oneWorkspace();
    writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);
    const tmp = ownTmpdir();

    await runScriptOk(sandbox, 'bench-on-host.sh', ['--target', BENCH_TARGET, '--setup-only'], { TMPDIR: tmp });

    const cut = expectedCut(workspace);
    const mirror = join(sandbox.remoteHome, REMOTE_BENCH_DIR);
    assert.equal(readFileSync(join(mirror, 'pnpm-lock.yaml'), 'utf8'), cut.lockfile);
    assert.equal(readFileSync(join(mirror, 'pnpm-workspace.yaml'), 'utf8'), cut.workspace);
    assert.ok(existsSync(join(mirror, 'package.json')), "the stack's own files are mirrored as before");
    assert.deepEqual(readdirSync(tmp), [], 'the cut folder is gone');
    assert.equal(existsSync(join(sandbox.root, 'pnpm-lock.yaml')), false, 'nothing was written into the checkout');
  });

  /**
   * Through this machine's own rsync, into a mirror seeded as an earlier run left it: the stack's own
   * lockfile, a file the checkout no longer has, and what the harness wrote on the host, which the
   * sync excludes. The same rsync run without the cut folder, into an identical mirror, is what
   * --delete does from the stack alone. The two may differ by the pair and nothing else.
   */
  it("leaves the mirror as rsync --delete leaves it from the stack alone, and the stack's pair besides", async () => {
    const { workspace, sandbox } = oneWorkspace({ realRsync: true });
    writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);
    const earlier = {
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# the stack's own, from before the one workspace\n",
      'stale.txt': 'a file the checkout no longer has\n',
      'reports/kept.txt': 'a report the harness wrote on the host\n',
      'docs/bench/kept.md': 'a result the harness wrote on the host\n',
    };
    write(join(sandbox.remoteHome, REMOTE_BENCH_DIR), earlier);
    const alone = join(ownTmpdir(), 'mirror');
    write(alone, earlier);
    const tmp = ownTmpdir();

    await runScriptOk(sandbox, 'bench-on-host.sh', ['--target', BENCH_TARGET, '--setup-only'], {
      TMPDIR: tmp,
      RSYNC_ALONE_DEST: alone,
      RSYNC_ALONE_SKIP: tmp,
    });

    const cutSources = sandbox.rsyncArgv().filter((arg) => arg.startsWith(tmp));
    assert.equal(cutSources.length, 1, `one source under TMPDIR, the cut: ${sandbox.rsyncArgv().join(' ')}`);
    const cut = expectedCut(workspace);
    const withoutPair = treeOf(alone);
    assert.deepEqual(treeOf(sandbox.rsyncAfter), {
      ...withoutPair,
      'pnpm-lock.yaml': cut.lockfile,
      'pnpm-workspace.yaml': cut.workspace,
    });
    assert.equal(withoutPair['stale.txt'], undefined, '--delete removed what the checkout no longer has');
    assert.equal(withoutPair['pnpm-lock.yaml'], undefined, "alone, --delete would have removed the mirror's lockfile");
    assert.equal(withoutPair['reports/kept.txt'], earlier['reports/kept.txt']);
    assert.equal(withoutPair['docs/bench/kept.md'], earlier['docs/bench/kept.md']);
  });

  it('mirrors a stack that keeps its own lockfile as before', async () => {
    const { sandbox } = oneWorkspace({ ownPair: true });
    writeFileSync(join(sandbox.root, SPEND_LEDGER), OWNER_LEDGER);

    await runScriptOk(sandbox, 'bench-on-host.sh', ['--target', BENCH_TARGET, '--setup-only'], { TMPDIR: ownTmpdir() });

    assert.equal(
      readFileSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR, 'pnpm-lock.yaml'), 'utf8'),
      "lockfileVersion: '9.0'\n# the stack's own\n",
    );
  });
});

/** The two files rendered as compose loads them, with the stack's two images in play. */
function renderWithCopy(env) {
  return spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.copy.yml',
      '--profile',
      'stream-uploader',
      '--profile',
      'client',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: join(STACK, 'deploy'),
      encoding: 'utf-8',
      env: { ...process.env, STAMP: 'x', STREAM_KEY: 'x', API_AUTH_TOKEN: 'x', ...env },
      timeout: COMPOSE_CONFIG_TIMEOUT_MS,
    },
  );
}

describe('docker-compose.copy.yml', () => {
  it("moves the two images' build context to the copy, each keeping its own Dockerfile", (t) => {
    const copy = '/copy/of/the/stack';
    const render = renderWithCopy({ APP_WORKSPACE_COPY: copy });

    const outcome = classifySpawn(render);
    if (outcome.kind === SPAWN_ABSENT) {
      t.skip('docker is not available on this host');
      return;
    }
    assert.notEqual(outcome.kind, SPAWN_TIMED_OUT, `docker compose config did not answer: ${outcome.detail}`);
    assert.equal(outcome.kind, SPAWN_OK, `docker compose refused the files: ${outcome.detail}`);
    const { services } = JSON.parse(render.stdout);
    for (const [service, dockerfile] of [
      ['stream-uploader', 'deploy/Dockerfile.uploader'],
      ['client', 'deploy/Dockerfile.client'],
    ]) {
      assert.equal(services[service].build.context, copy, service);
      assert.equal(services[service].build.dockerfile, dockerfile, service);
    }
  });

  it('refuses to render without a copy named, rather than build from somewhere else', (t) => {
    const render = renderWithCopy({ APP_WORKSPACE_COPY: undefined });

    const outcome = classifySpawn(render);
    if (outcome.kind === SPAWN_ABSENT) {
      t.skip('docker is not available on this host');
      return;
    }
    assert.notEqual(outcome.kind, SPAWN_OK, 'compose rendered a build context from an unset copy');
    assert.match(render.stderr, /in-copy\.mjs/);
  });
});

describe('a stack that keeps its own lockfile', () => {
  it('sends its own pair, as every build tree the manager makes does', async () => {
    const { sandbox } = oneWorkspace({ config: ALL_REMOTE, ownPair: true });

    await runScriptOk(sandbox, 'deploy.sh', ['client'], { TMPDIR: ownTmpdir() });

    assert.equal(
      readFileSync(join(sandbox.remoteHome, REMOTE_BASE, 'pnpm-lock.yaml'), 'utf8'),
      "lockfileVersion: '9.0'\n# the stack's own\n",
    );
  });

  it('sends the shared packages it keeps in its workspace-packages', async () => {
    const { sandbox } = oneWorkspace({ config: ALL_REMOTE, ownPair: true });
    write(sandbox.root, { 'workspace-packages/contracts/package.json': manifest('@example/contracts') });

    await runScriptOk(sandbox, 'deploy.sh', ['stream-uploader'], { TMPDIR: ownTmpdir() });

    assert.equal(
      readFileSync(join(sandbox.remoteHome, REMOTE_BASE, 'workspace-packages', 'contracts', 'package.json'), 'utf8'),
      manifest('@example/contracts'),
    );
  });

  it('builds locally from its own folder, as before', async () => {
    const { sandbox } = oneWorkspace({ ownPair: true });

    await runScriptOk(sandbox, 'deploy.sh', ['--host=localhost', 'client'], { TMPDIR: ownTmpdir() });

    const [up] = composeUps(sandbox);
    assert.ok(up, 'compose was asked to bring the stack up');
    assert.equal(up.includes('docker-compose.copy.yml'), false, up);
    assert.equal(up.includes('--project-directory'), false, up);
    assert.deepEqual(sandbox.copies(), []);
  });
});
