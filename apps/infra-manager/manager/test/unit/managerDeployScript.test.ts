/**
 * That the manager's own deploy ships the manager and nothing of the streaming
 * stack but the commit it pins, and lets the host command decide the rest.
 *
 * Read from the file, the way the build script is read: the deploy needs a
 * host, a network and a signing key. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MANAGER_POSTGRES_VOLUME } from '../../src/domain/versions/managerProject.js';
import { STACK_COMMIT_FILE } from '../../src/domain/versions/StackVersionService.js';
import { MONOREPO_STACK_SOURCE } from '../../src/domain/versions/stackSources.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(here, '..', '..', '..', 'deploy', 'deploy.sh');
/** The repository's own cut tool, which a checkout of the one workspace carries at tools/app-workspace. */
const CUT_TOOL = join(here, '..', '..', '..', '..', '..', 'tools', 'app-workspace');

/** The pnpm a checkout of the one workspace names at its root and in each app alike. */
const ONE_PNPM = 'pnpm@11.11.0+sha512.0123abcd';

/** The root lockfile of a one-workspace checkout whose manager has one project and one package. */
const ONE_WORKSPACE_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  apps/infra-manager: {}

  apps/infra-manager/manager:
    dependencies:
      qs:
        specifier: 6.16.0
        version: 6.16.0

packages:

  qs@6.16.0:
    resolution: {integrity: sha512-qs}

snapshots:

  qs@6.16.0: {}
`;

const script = readFileSync(DEPLOY_SCRIPT, 'utf8');

/** Every `rsync ...` invocation, each up to its destination line. */
function rsyncs(): string[] {
  return script.split(/\n(?=rsync )/).filter((block) => block.startsWith('rsync ')).map((block) => block.split('\n\n')[0] ?? block);
}

describe('deploy/deploy.sh', () => {
  it('is a script bash accepts', () => {
    execFileSync('bash', ['-n', DEPLOY_SCRIPT]);
  });

  it('leaves the bundled tree the engines mount out of the rsync that deletes into the repo', () => {
    const repo = rsyncs().find((block) => block.includes('"${SSH_TARGET}:${REMOTE_PATH}/"'));
    assert.ok(repo, 'the rsync into the repository');
    assert.match(repo, /--delete/);
    assert.match(repo, /--exclude 'manager\/swarm-hls-stream\/'/);
  });

  /**
   * Measured on 2026-09-11: one deploy carried 1504 files of session scratch to
   * the public host, nearly half of everything it sent. The directory is
   * ignored by git, so it is by definition not part of what a host runs.
   */
  it('leaves the working notes of whoever deployed on the machine they wrote them on', () => {
    const repo = rsyncs().find((block) => block.includes('"${SSH_TARGET}:${REMOTE_PATH}/"'));
    assert.ok(repo, 'the rsync into the repository');
    assert.match(repo, /--exclude '\.scratch\/'/);
  });

  /**
   * The rsync is one of the two ways those notes could travel. The other is the
   * image build, whose context is the repository root for both images, and
   * where `.dockerignore` excluded only `*.log`, so the markdown, the JSON and
   * the screenshots under `.scratch` would still be handed to the daemon. the owner
   * ruled on 2026-09-11 that the directory stays as the local issue scratch
   * `AGENTS.md` defines and never travels anywhere.
   */
  it('keeps the working notes out of the image build context as well', () => {
    const ignore = readFileSync(join(here, '..', '..', '..', '.dockerignore'), 'utf8');
    const excluded = ignore.split('\n').map((line) => line.trim());
    assert.ok(
      excluded.includes('.scratch') || excluded.includes('.scratch/'),
      'the build context carries the scratch to the daemon',
    );
  });

  it('has nothing left of the staging tree the api used to publish at boot', () => {
    assert.equal(script.includes('bundled.incoming'), false);
  });

  it('reads no submodule pin, because the stack it bundles is in the same commit', () => {
    assert.equal(script.includes('HEAD:./manager/swarm-hls-stream'), false);
  });

  it('records a digest of the manager tree alone, even from a repository that holds more than the manager', () => {
    assert.match(script, /MANAGER_DIGEST="\$\(git ls-tree -r HEAD \| shasum -a 256 \| cut -c1-64\)"/);
    assert.equal(script.includes('--full-tree'), false, 'the listing stays inside the folder the script runs in');
    assert.ok(script.indexOf('cd "$REPO_ROOT"') < script.indexOf('MANAGER_DIGEST='), 'which is the manager folder by then');
  });

  it('names the compose project manager in the file itself, the name the volume probe and the upgrade use', () => {
    const compose = readFileSync(join(here, '..', '..', 'docker-compose.yml'), 'utf8');
    assert.match(compose, /^name: manager$/m, 'the project name does not come from the folder the file sits in');
    assert.ok(script.includes(`POSTGRES_VOLUME="manager_${MANAGER_POSTGRES_VOLUME}"`), 'the data volume the deploy looks for carries it');
    assert.ok(script.includes('--project manager'), 'and so does the upgrade');
  });

  it('builds nothing of the streaming stack here, because the host fetches and builds it', () => {
    assert.equal(script.includes('pnpm -C manager/swarm-hls-stream'), false, 'the stack is not installed or built on this machine');
    assert.equal(script.includes('bundled:seal'), false, 'nothing is sealed into a package any more');
    assert.equal(script.includes('bundled.packages'), false, 'and no package root is written to');
    assert.equal(script.includes('uuidgen'), false, 'a shipment has no id because there is no shipment');
  });

  it('ships one rsync, the repository, and no package beside it', () => {
    assert.equal(rsyncs().length, 1, 'the repository is the only thing copied to the host');
  });

  it('interpolates no identity it had to check first, because the seal that produced them is gone', () => {
    assert.equal(script.includes('check_identity'), false);
    assert.equal(script.includes('SHIPMENT_ID'), false);
    assert.equal(script.includes('SHIPMENT_DIGEST'), false);
    assert.equal(script.includes('TOOLCHAIN'), false);
  });

  it('builds the image on the host and then runs the upgrade from it, not from the running api', () => {
    const build = script.indexOf('docker compose build');
    const upgrade = script.indexOf('docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade');
    assert.notEqual(build, -1, 'the image is built on the host');
    assert.notEqual(upgrade, -1, 'the upgrade runs in a container of the image just built');
    assert.ok(build < upgrade, 'the image exists before the upgrade runs from it');
  });

  it('decides on the host whether this manager has ever run here, before the one-off container exists', () => {
    const run = script.indexOf('docker compose run --rm --no-deps -T api');
    assert.notEqual(run, -1, 'the upgrade runs in a one-off container');
    const before = script.slice(0, run);
    assert.ok(before.includes('docker volume ls -q --filter name=^\\${POSTGRES_VOLUME}\\$'), 'the data volume is looked for by name');
    assert.ok(before.includes('service_containers api'), 'so are the api containers of the project');
    assert.ok(before.includes('service_containers postgres'), 'and the postgres ones');
    assert.match(before, /label=com\.docker\.compose\.oneoff=False/, 'neither count a one-off container');
  });

  it('reads each probe into a variable of its own, where a docker that could not be asked stops the deploy', () => {
    // A substitution inside a [ ... ] condition reports what it printed rather than that it
    // failed, so a daemon that is down would read as a host with nothing on it and take the
    // first use branch.
    const before = script.slice(0, script.indexOf('docker compose run --rm --no-deps -T api')).split('\n');
    for (const probe of ['docker volume ls -q --filter name=', 'service_containers api', 'service_containers postgres']) {
      const asked = before.filter((line) => line.includes(probe));
      assert.equal(asked.length, 1, `${probe} is asked in one place`);
      assert.match(asked[0]!.trim(), /^[A-Z_]+="\\\$\(/, `${probe} is read into a variable of its own`);
    }
  });

  it('stops before the upgrade when the data volume went missing under an installed manager', () => {
    const abort = script.indexOf('so its database was removed under a manager that is still installed');
    assert.notEqual(abort, -1, 'the deploy says what it found');
    assert.ok(abort < script.indexOf('docker compose run --rm --no-deps -T api'), 'and says it before anything is published');
    assert.match(script.slice(abort, abort + 300), /exit 1/, 'the deploy stops there');
  });

  it('hands the first use answer to the upgrade rather than letting it probe from inside', () => {
    assert.match(script, /FIRST_USE_FLAG="--first-use"/, 'the flag is set where the probes said so');
    const upgrade = script.slice(script.indexOf('cli.js manager:upgrade'));
    assert.ok(upgrade.includes('\\${FIRST_USE_FLAG}'), 'and reaches the command');
  });

  it('gives the upgrade the identity of the manager, of the image and how long to wait for the bundled build', () => {
    const upgrade = script.slice(script.indexOf('manager:upgrade'));
    for (const flag of ['--manager-commit', '--manager-digest', '--image-id', '--project manager',
      '--compose-file', '--mutable-root', '--bundled-timeout']) {
      assert.ok(upgrade.includes(flag), `the upgrade is given ${flag}`);
    }
    assert.match(script, /IMAGE_ID="\\\$\(docker image inspect --format '\{\{\.Id\}\}' manager-api\)"/);
  });

  it('gives the upgrade no shipment, because the host builds the stack itself', () => {
    const upgrade = script.slice(script.indexOf('manager:upgrade'));
    for (const flag of ['--shipment-id', '--commit ', '--digest ', '--toolchain']) {
      assert.equal(upgrade.includes(flag), false, `the upgrade is not given ${flag}`);
    }
  });

  it('lets the deployer say how long the bundled build may take, with a default of its own', () => {
    assert.match(script, /BUNDLED_TIMEOUT="\$\{BUNDLED_TIMEOUT:-\d+\}"/);
  });

  /**
   * A bind mount whose source does not exist is created by Docker as a
   * root-owned directory, which the deploying user then cannot write a key or
   * a config into, and which on 2026-09-16 turned a missing ssh_config into a
   * directory the upgrade container could not start over. So the script makes
   * the directory itself, empty, as the user it runs as, before compose sees it.
   */
  it('creates the ssh identity directory as the deploying user before any container is made', () => {
    const remote = script.slice(script.indexOf('<<REMOTE'), script.indexOf('\nREMOTE\n'));
    const made = remote.indexOf('mkdir -p -m 700 "\\${MANAGER_SSH_DIR}"');
    assert.notEqual(made, -1, 'the ssh identity directory is created with mode 700');
    assert.ok(made < remote.indexOf('docker compose build'), 'before the images are built');
    assert.match(remote, /export MANAGER_SSH_DIR=/);
  });

  it('refuses an ssh target that would read as an option to ssh', () => {
    const taken = script.indexOf('SSH_TARGET="${1:-');
    const checked = script.indexOf('if [[ "$SSH_TARGET" == -* ]]');
    assert.notEqual(checked, -1, 'a leading dash makes the target an ssh flag');
    assert.ok(checked > taken, 'after the argument is taken');
    assert.ok(checked < script.indexOf('ssh "$SSH_TARGET"'), 'and before ssh is given it');
  });

  it('refuses a bundled timeout that is not whole seconds, before it reaches the remote quoting', () => {
    const assignment = script.indexOf('BUNDLED_TIMEOUT="${BUNDLED_TIMEOUT:-');
    const checked = script.indexOf('if ! [[ "$BUNDLED_TIMEOUT" =~ ^[0-9]+$ ]]');
    assert.notEqual(checked, -1, 'the value lands inside single quotes in the remote heredoc');
    assert.ok(checked > assignment, 'after the value is settled');
    assert.ok(checked < script.indexOf('ssh "$SSH_TARGET"'), 'and before anything runs on the host');
  });

  it('feeds both remote docker commands from /dev/null, so neither reads the rest of the script', () => {
    // The remote block arrives on the stdin of one bash, and `run` and `exec` keep stdin open,
    // so without this the lines below them are swallowed instead of run.
    const run = script.slice(script.indexOf('docker compose run --rm --no-deps -T api'));
    const closed = run.indexOf(')"');
    assert.notEqual(closed, -1, 'the substitution that captures the receipt ends somewhere');
    assert.match(run.slice(0, closed + 2), /\$\{PUBLIC_EDGE_FLAG\} < \/dev\/null\)"$/,
      'the upgrade takes the edge decision and no standard input');
    assert.match(script, /docker compose exec -T api [^\n]* < \/dev\/null/, 'and neither does the check that follows it');
  });

  it('asks for the public edge only where the domain says so', () => {
    const branch = script.indexOf('COMPOSE_PROFILE_FLAG=""');
    assert.equal(script.split('--public-edge').length - 1, 1, 'the flag is decided in one place');
    const decision = script.indexOf('PUBLIC_EDGE_FLAG="--public-edge"');
    assert.notEqual(decision, -1, 'the public branch sets it');
    assert.ok(decision > script.indexOf('elif [[ "$MANAGER_DOMAIN" =~ $HOSTNAME_PATTERN ]]'), 'inside the branch that saw a host name');
    assert.ok(decision < script.indexOf('\nelse\n', script.indexOf('elif [[ "$MANAGER_DOMAIN"')), 'and not below it');
    assert.equal(branch, -1, 'the old compose profile flag is gone');
  });

  it('prints the receipt the upgrade returned, after the command that returned it', () => {
    const captured = script.indexOf('RECEIPT="\\$(docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade');
    assert.notEqual(captured, -1, 'the receipt is the one line the upgrade printed');
    const printed = script.indexOf('echo "[deploy] upgrade receipt: \\${RECEIPT}"');
    assert.notEqual(printed, -1, 'and the deploy prints it as it stands');
    assert.ok(printed > captured, 'after the command that returned it, never before');
  });

  it('prints the receipt of an upgrade that failed, and only then fails the deploy', () => {
    const captured = script.indexOf('RECEIPT="\\$(docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade');
    const kept = script.indexOf('|| UPGRADE_STATUS=\\$?');
    assert.notEqual(kept, -1, 'the capture runs under set -e, where a failing substitution would end the block');
    const printed = script.indexOf('echo "[deploy] upgrade receipt: \\${RECEIPT}"');
    const failed = script.indexOf('exit "\\${UPGRADE_STATUS}"');
    assert.ok(kept > captured, 'the status of the command is taken');
    assert.ok(printed > kept, 'the receipt is printed with it in hand');
    assert.ok(failed > printed, 'and the deploy fails after the deployer has read it');
  });

  it('lets an address probe that answered nothing through, so the warning below it is reached', () => {
    // The remote block runs under set -e with pipefail, so a failing pipe inside this
    // substitution would end it here and the warning, the upgrade and the receipt would never run.
    const line = script.split('\n').find((one) => one.startsWith('PUBLIC_HOST="'));
    assert.ok(line, 'the remote block reads the address of the host');
    assert.match(line, /\|\| true\)"$/);
    assert.ok(script.indexOf('WARNING: PUBLIC_HOST is empty') > script.indexOf('PUBLIC_HOST="'), 'and says so below it');
  });

  it('looks for the same data volume the upgrade names, so a rename on one side fails here', () => {
    // The script cannot import TypeScript, so its one literal is read back against the
    // constant the command uses and the two are changed together.
    assert.ok(script.includes(`POSTGRES_VOLUME="manager_${MANAGER_POSTGRES_VOLUME}"`),
      `the deploy names the manager_${MANAGER_POSTGRES_VOLUME} volume of the manager project`);
  });

  it('never asks compose to print a rendered configuration', () => {
    for (const match of script.matchAll(/docker compose[^\n]*\bconfig\b[^\n]*/g)) {
      assert.match(match[0], /--quiet/, 'a rendered compose file would carry the values of every secret');
    }
  });

  it('names the versions root on the host, which is where the bundled build lands', () => {
    assert.ok(script.includes('streaming-infra-manager-versions'), 'the remote block exports it');
  });
});

/**
 * The part of the deploy that runs on this machine, run for real against a
 * repository on this disk, with an rsync and an ssh that only record that they
 * were called. What the script leaves in manager/.stack-commit is what a host
 * builds as the bundled version, so it is read back rather than matched in the
 * script's text.
 */
describe('deploy/deploy.sh, run against a repository on this disk', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=deploy test', '-c', 'user.email=deploy@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8' },
    ).trim();

  interface Deployed {
    status: number | null;
    stderr: string;
    /** Whether the rsync to the host was reached. */
    shipped: boolean;
    pin: string | null;
  }

  interface Checkout {
    /** The repository root, as the monorepo's is. */
    work: string;
    /** apps/infra-manager, where the deploy runs from. */
    manager: string;
    /** The last commit that changed apps/hls-stream. */
    stackCommit: string;
    environment: NodeJS.ProcessEnv;
  }

  /**
   * The monorepo in miniature, the manager and the stack side by side, pushed to
   * an origin on this disk, with stand-ins for the two commands that reach a host.
   */
  /**
   * A git that answers `ls-remote` with `lsRemote` as its exit status and records how it was asked,
   * and hands every other command to the real git.
   */
  function gitAnswering(root: string, bin: string, lsRemote: number): void {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const calls = join(root, 'ls-remote-calls');
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = ls-remote ]; then',
      `    printf '%s | GIT_CONFIG_GLOBAL=%s GIT_TERMINAL_PROMPT=%s\\n' "$*" "$GIT_CONFIG_GLOBAL" "$GIT_TERMINAL_PROMPT" >> '${calls}'`,
      `    exit ${lsRemote}`,
      '  fi',
      'done',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
  }

  /**
   * What a checkout of the one workspace holds at its root: the lockfile, the workspace file, the
   * pnpm the apps name, and the cut tool, which the manager's own pair is cut out of the root's with.
   */
  function seedOneWorkspace(work: string): void {
    const manifest = (name: string): string => `${JSON.stringify({ name, private: true, packageManager: ONE_PNPM })}\n`;
    writeFileSync(join(work, 'package.json'), manifest('monorepo'));
    writeFileSync(join(work, 'pnpm-lock.yaml'), ONE_WORKSPACE_LOCKFILE);
    writeFileSync(join(work, 'pnpm-workspace.yaml'), 'packages:\n  - apps/infra-manager\n  - apps/infra-manager/manager\n');
    writeFileSync(join(work, 'apps', 'infra-manager', 'package.json'), manifest('streaming-infra-manager'));
    writeFileSync(join(work, 'apps', 'infra-manager', 'manager', 'package.json'), manifest('@streaming-infra-manager/api'));
    cpSync(CUT_TOOL, join(work, 'tools', 'app-workspace'), { recursive: true });
  }

  /** An rsync that writes down its arguments and keeps a copy of every source folder but the manager's own. */
  function recordingRsync(root: string): void {
    writeFileSync(join(root, 'bin', 'rsync'), [
      '#!/bin/sh',
      `touch '${join(root, 'rsync-ran')}'`,
      `printf '%s\\n' "$@" > '${join(root, 'rsync-args')}'`,
      'for arg in "$@"; do',
      `  case "$arg" in */) [ "$arg" != ./ ] && [ -d "$arg" ] && cp -R "$arg" '${join(root, 'rsync-extra-source')}' ;; esac`,
      'done',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
  }

  /** The folders the rsync was given to send, in order: every word that is no option, no option's value and no destination. */
  function rsyncSources(root: string): string[] {
    const args = readFileSync(join(root, 'rsync-args'), 'utf8').trim().split('\n');
    const sources: string[] = [];
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === '--exclude') index += 1;
      else if (!args[index].startsWith('-')) sources.push(args[index]);
    }
    return sources;
  }

  function checkout(root: string, { lsRemote = 0, oneWorkspace = false }: { lsRemote?: number; oneWorkspace?: boolean } = {}): Checkout {
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', origin);
    const work = join(root, 'work');
    const manager = join(work, 'apps', 'infra-manager');
    mkdirSync(join(manager, 'deploy'), { recursive: true });
    mkdirSync(join(manager, 'manager'));
    mkdirSync(join(work, 'apps', 'hls-stream'));
    if (oneWorkspace) seedOneWorkspace(work);
    copyFileSync(DEPLOY_SCRIPT, join(manager, 'deploy', 'deploy.sh'));
    writeFileSync(join(manager, 'manager', '.env'), 'POSTGRES_PASSWORD=synthetic-not-a-secret\n');
    writeFileSync(join(work, 'apps', 'hls-stream', 'README.md'), 'the stack\n');
    writeFileSync(join(work, '.gitignore'), `apps/infra-manager/manager/.env\napps/infra-manager/manager/${STACK_COMMIT_FILE}\n`);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'the manager and the stack');
    const stackCommit = git(work, 'rev-parse', 'HEAD');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', 'origin', 'main');

    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'rsync'), `#!/bin/sh\ntouch '${join(root, 'rsync-ran')}'\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\ncat > /dev/null\n', { mode: 0o755 });
    gitAnswering(root, bin, lsRemote);
    return { work, manager, stackCommit, environment: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } };
  }

  /** Commits one file and pushes, and answers the commit. */
  function change(work: string, path: string, text: string): string {
    writeFileSync(join(work, path), text);
    git(work, 'add', path);
    git(work, 'commit', '-qm', `change ${path}`);
    git(work, 'push', '-q', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  }

  function deploy(root: string, manager: string, environment: NodeJS.ProcessEnv): Deployed {
    const run = spawnSync('bash', [join(manager, 'deploy', 'deploy.sh'), 'fixture-host'], { env: environment, encoding: 'utf8' });
    const pin = join(manager, 'manager', STACK_COMMIT_FILE);
    return {
      status: run.status,
      stderr: run.stderr,
      shipped: existsSync(join(root, 'rsync-ran')),
      pin: existsSync(pin) ? readFileSync(pin, 'utf8').trim() : null,
    };
  }

  /**
   * The manager's images build on the host from the folder this ships, and read the manager's
   * lockfile and workspace file at its root. A checkout of the one workspace holds them only at
   * the repository root, so the deploy cuts the manager's own pair out of the root's into a folder
   * outside the checkout, gives it to the one rsync as a second source, and removes it afterwards.
   */
  it("ships the manager's pair cut out of the root's from a checkout of the one workspace, and leaves nothing behind", () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-cut-'));
    try {
      const { work, manager, environment } = checkout(root, { oneWorkspace: true });
      recordingRsync(root);
      const tmp = join(root, 'tmp');
      mkdirSync(tmp);

      const deployed = deploy(root, manager, { ...environment, TMPDIR: tmp });

      assert.equal(deployed.status, 0, deployed.stderr);
      const sources = rsyncSources(root);
      assert.equal(sources.length, 2, `the manager's folder and the cut: ${sources.join(' ')}`);
      assert.equal(sources[0], './');
      const expected = join(root, 'expected');
      execFileSync(process.execPath, [join(CUT_TOOL, 'cut.mjs'), '--root', work, '--app', 'apps/infra-manager', '--out', expected]);
      for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
        assert.equal(
          readFileSync(join(root, 'rsync-extra-source', file), 'utf8'),
          readFileSync(join(expected, file), 'utf8'),
          `the rsync carried the cut ${file}`,
        );
      }
      assert.deepEqual(readdirSync(tmp), [], 'the cut folder is gone');
      assert.equal(existsSync(join(manager, 'pnpm-lock.yaml')), false, 'nothing was written into the checkout');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ships a manager that keeps its own pair as before, from its folder alone", () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-own-pair-'));
    try {
      const { manager, environment } = checkout(root);
      recordingRsync(root);

      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.deepEqual(rsyncSources(root), ['./']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The bundled stack is apps/hls-stream of the deployed commit, and the last
   * commit that changed that folder holds the same tree. Pinned to that one, a
   * deploy that changes only the manager finds the build the host already has,
   * so it neither rebuilds the stack nor clears its Tested mark.
   */
  it('pins the last commit that changed apps/hls-stream, not a later one that changed only the manager', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-pin-'));
    try {
      const { work, manager, stackCommit, environment } = checkout(root);
      const managerOnly = change(work, 'apps/infra-manager/NOTES.md', 'a manager change\n');

      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.notEqual(stackCommit, managerOnly);
      assert.equal(deployed.pin, stackCommit, 'the stack did not change, so neither does its pin');
      assert.equal(deployed.shipped, true);

      const stackChange = change(work, 'apps/hls-stream/README.md', 'the stack, changed\n');
      assert.equal(deploy(root, manager, environment).pin, stackChange, 'a change to the stack moves the pin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The host fetches the pin from the monorepo without a login. While the
   * repository cannot be read that way, an upgrade would stop the old api and
   * migrate the database before the bundled build failed, so the deploy asks
   * the same way first, with nothing of this machine's git setup behind it.
   */
  it('refuses before anything reaches the host when the monorepo does not answer an anonymous ls-remote', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-private-'));
    try {
      const { manager, environment } = checkout(root, { lsRemote: 128 });

      const refused = deploy(root, manager, environment);

      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /does not answer without a login/);
      assert.equal(refused.shipped, false, 'nothing was copied to the host');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('asks the monorepo anonymously, with no credential helper, no prompt and none of this machine\'s git configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-anonymous-'));
    try {
      const { manager, environment } = checkout(root);

      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      const [asked] = readFileSync(join(root, 'ls-remote-calls'), 'utf8').trim().split('\n');
      assert.match(asked, new RegExp(`ls-remote ${MONOREPO_STACK_SOURCE.url.replaceAll('.', '\\.')} HEAD`));
      assert.match(asked, /-c credential\.helper= /);
      assert.match(asked, /GIT_CONFIG_GLOBAL=\/dev\/null GIT_TERMINAL_PROMPT=0$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The host fetches the pinned commit from GitHub by its name. A commit only
   * this machine has would get as far as replacing the manager, and only then
   * fail the bundled build, so it is refused before anything leaves.
   */
  it('refuses a commit no remote branch holds, before anything reaches the host, and deploys it once pushed', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-unpushed-'));
    try {
      const { work, manager, stackCommit, environment } = checkout(root);
      writeFileSync(join(work, 'CHANGES.md'), 'a change only this machine has\n');
      git(work, 'add', 'CHANGES.md');
      git(work, 'commit', '-qm', 'not pushed yet');
      const commit = git(work, 'rev-parse', 'HEAD');

      const refused = deploy(root, manager, environment);

      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, new RegExp(`no remote branch holds ${commit}`));
      assert.match(refused.stderr, /push it first, or git fetch if it is pushed already/);
      assert.equal(refused.shipped, false, 'nothing was copied to the host');

      git(work, 'push', '-q', 'origin', 'main');
      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.equal(deployed.pin, stackCommit, 'the change was outside the stack, so the pin stays');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
