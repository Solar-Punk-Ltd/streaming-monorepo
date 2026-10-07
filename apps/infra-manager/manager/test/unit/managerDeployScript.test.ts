/**
 * That the manager's own deploy ships the manager and nothing of the streaming
 * stack but the commit it pins, and lets the host command decide the rest.
 *
 * Read from the file, the way the build script is read: the deploy needs a
 * host, a network and a signing key. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
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
import { basename, dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VERSION_COMMIT_RE, VERSION_LABEL_RE } from '@streaming-infra-manager/common';

import { MANAGER_POSTGRES_VOLUME } from '../../src/domain/versions/managerProject.js';
import { STACK_COMMIT_FILE } from '../../src/domain/versions/StackVersionService.js';
import { MONOREPO_STACK_SOURCE } from '../../src/domain/versions/stackSources.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(here, '..', '..', '..', 'deploy', 'deploy.sh');
/** The repository's own cut tool, which a checkout of the one workspace carries at tools/app-workspace. */
const CUT_TOOL = join(here, '..', '..', '..', '..', '..', 'tools', 'app-workspace');
/** The repository's release scripts, version.mjs among them, which every checkout carries at tools/release. */
const RELEASE_TOOLS = join(here, '..', '..', '..', '..', '..', 'tools', 'release');

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
  return script
    .split(/\n(?=rsync )/)
    .filter((block) => block.startsWith('rsync '))
    .map((block) => block.split('\n\n')[0] ?? block);
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
   * the screenshots under `.scratch` would still be handed to the daemon. Since
   * 2026-09-11 the directory stays as the local issue scratch
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
    assert.ok(
      script.indexOf('cd "$REPO_ROOT"') < script.indexOf('MANAGER_DIGEST='),
      'which is the manager folder by then',
    );
  });

  it('names the compose project manager in the file itself, the name the volume probe and the upgrade use', () => {
    const compose = readFileSync(join(here, '..', '..', 'docker-compose.yml'), 'utf8');
    assert.match(compose, /^name: manager$/m, 'the project name does not come from the folder the file sits in');
    assert.ok(
      script.includes(`POSTGRES_VOLUME="manager_${MANAGER_POSTGRES_VOLUME}"`),
      'the data volume the deploy looks for carries it',
    );
    assert.ok(script.includes('--project manager'), 'and so does the upgrade');
  });

  it('builds nothing of the streaming stack here, because the host fetches and builds it', () => {
    assert.equal(
      script.includes('pnpm -C manager/swarm-hls-stream'),
      false,
      'the stack is not installed or built on this machine',
    );
    assert.equal(script.includes('bundled:seal'), false, 'nothing is sealed into a package any more');
    assert.equal(script.includes('bundled.packages'), false, 'and no package root is written to');
    assert.equal(script.includes('uuidgen'), false, 'a shipment has no id because there is no shipment');
  });

  /**
   * Two since 2026-10-06, and still no package beside them. The repository's rsync leaves every
   * env file in manager/ but the sample out, so that no host is sent another host's settings, and
   * rsync never writes or deletes a path it excludes, --delete or not. So the host's manager/.env
   * is replaced by a transfer of its own, of the profile's env file alone, which runs second, into
   * the folder the first one makes on a new host.
   */
  it("ships two rsyncs, the repository and then the profile's env file alone, and no package beside them", () => {
    const [repository = '', envFile = '', ...more] = rsyncs();
    assert.deepEqual(more, [], 'nothing else is copied to the host');
    assert.ok(repository.includes('"${SSH_TARGET}:${REMOTE_PATH}/"'), 'the repository first');
    const samples = repository.indexOf("--include '.env.sample'");
    const envFiles = repository.indexOf("--exclude '.env*'");
    assert.notEqual(samples, -1, 'with every .env.sample in the tree');
    assert.ok(envFiles > samples, 'and without every other env file in it, the samples let through first');
    assert.ok(
      envFile.includes('"$ENV_FILE" "${SSH_TARGET}:${REMOTE_PATH}/manager/.env"'),
      "then the profile's env file, as the host's manager/.env",
    );
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
    assert.ok(
      before.includes('docker volume ls -q --filter name=^\\${POSTGRES_VOLUME}\\$'),
      'the data volume is looked for by name',
    );
    assert.ok(before.includes('service_containers api'), 'so are the api containers of the project');
    assert.ok(before.includes('service_containers postgres'), 'and the postgres ones');
    assert.match(before, /label=com\.docker\.compose\.oneoff=False/, 'neither count a one-off container');
  });

  it('reads each probe into a variable of its own, where a docker that could not be asked stops the deploy', () => {
    // A substitution inside a [ ... ] condition reports what it printed rather than that it
    // failed, so a daemon that is down would read as a host with nothing on it and take the
    // first use branch.
    const before = script.slice(0, script.indexOf('docker compose run --rm --no-deps -T api')).split('\n');
    for (const probe of [
      'docker volume ls -q --filter name=',
      'service_containers api',
      'service_containers postgres',
    ]) {
      const asked = before.filter((line) => line.includes(probe));
      assert.equal(asked.length, 1, `${probe} is asked in one place`);
      assert.match(asked[0]!.trim(), /^[A-Z_]+="\\\$\(/, `${probe} is read into a variable of its own`);
    }
  });

  it('stops before the upgrade when the data volume went missing under an installed manager', () => {
    const abort = script.indexOf('so its database was removed under a manager that is still installed');
    assert.notEqual(abort, -1, 'the deploy says what it found');
    assert.ok(
      abort < script.indexOf('docker compose run --rm --no-deps -T api'),
      'and says it before anything is published',
    );
    assert.match(script.slice(abort, abort + 300), /exit 1/, 'the deploy stops there');
  });

  it('hands the first use answer to the upgrade rather than letting it probe from inside', () => {
    assert.match(script, /FIRST_USE_FLAG="--first-use"/, 'the flag is set where the probes said so');
    const upgrade = script.slice(script.indexOf('cli.js manager:upgrade'));
    assert.ok(upgrade.includes('\\${FIRST_USE_FLAG}'), 'and reaches the command');
  });

  it('gives the upgrade the identity of the manager, of the image and how long to wait for the bundled build', () => {
    const upgrade = script.slice(script.indexOf('manager:upgrade'));
    for (const flag of [
      '--manager-commit',
      '--manager-digest',
      '--image-id',
      '--project manager',
      '--compose-file',
      '--mutable-root',
      '--bundled-timeout',
    ]) {
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
    const taken = script.indexOf('SSH_TARGET="$1"');
    const checked = script.indexOf('if [[ "$SSH_TARGET" == -* ]]');
    assert.notEqual(taken, -1, 'the target is taken from the arguments, alone or after --host');
    assert.notEqual(checked, -1, 'a leading dash makes the target an ssh flag');
    assert.ok(checked > taken, 'after the argument is taken');
    assert.ok(checked < script.indexOf('rsync -avz'), 'before rsync is given it');
    assert.ok(checked < script.indexOf('ssh "$SSH_TARGET"'), 'and before ssh is given it');
  });

  it('refuses a bundled timeout that is not whole seconds, before it reaches the remote quoting', () => {
    const assignment = script.indexOf('BUNDLED_TIMEOUT="${BUNDLED_TIMEOUT:-');
    const checked = script.indexOf('if ! [[ "$BUNDLED_TIMEOUT" =~ ^[0-9]+$ ]]');
    assert.notEqual(checked, -1, 'the value lands inside single quotes in the remote heredoc');
    assert.ok(checked > assignment, 'after the value is settled');
    assert.ok(checked < script.indexOf('ssh "$SSH_TARGET"'), 'and before anything runs on the host');
  });

  /**
   * What version.mjs prints is written into the script the host runs, so it is taken apart a line at a time into
   * variables of its own, never evaluated, and each value is held to its shape before anything leaves this machine.
   */
  it('names the build with tools/release/version.mjs, reading its lines into variables and evaluating none of them', () => {
    const asked = script.indexOf('node "$WORKSPACE_ROOT/tools/release/version.mjs" --app "$MANAGER_FOLDER"');
    assert.notEqual(asked, -1, 'the manager folder is the app whose changes make a build dirty');
    assert.doesNotMatch(script, /\beval\b/, 'nothing printed is evaluated');
    assert.doesNotMatch(script, /^\s*(?:source|\.)\s/m, 'or sourced');
    for (const name of ['VERSION_COMMIT', 'VERSION_TAG', 'VERSION_LABEL']) {
      assert.ok(script.includes(`${name}=*) ${name}="\${line#${name}=}" ;;`), `${name} is cut off its own line`);
    }
    const commitChecked = script.indexOf(`if ! [[ "$VERSION_COMMIT" =~ ${VERSION_COMMIT_RE.source} ]]`);
    const labelChecked = script.indexOf(`if ! [[ "$VERSION_LABEL" =~ ${VERSION_LABEL_RE.source} ]]`);
    assert.notEqual(commitChecked, -1, 'the commit is held to the shape the manager reads it in');
    assert.notEqual(labelChecked, -1, 'and the label to the one the manager shows, so none becomes no version');
    for (const checked of [commitChecked, labelChecked]) {
      assert.ok(checked > asked, 'after the values are read');
      assert.ok(checked < script.indexOf('rsync -avz'), 'before anything is sent');
      assert.ok(checked < script.indexOf('ssh "$SSH_TARGET"'), 'and before anything runs on the host');
    }
  });

  it('names the build before the pushed-commit check, so the check judges the commit that is deployed', () => {
    const named = script.indexOf('\nread_version\n');
    assert.notEqual(named, -1);
    assert.ok(named > script.indexOf('POSTGRES_PASSWORD is missing or empty'), 'after the env file is checked');
    assert.ok(named < script.indexOf('PUSHED_IN="$(git branch -r --contains "$MANAGER_COMMIT")"'));
    assert.equal(script.includes('MANAGER_COMMIT="$(git rev-parse HEAD)"'), false, 'the commit is the one it names');
  });

  /**
   * The offer runs the tag script, which asks for a name, so it is made only where a person can answer: both
   * standard input and standard output a terminal. Whatever the script ends with, the build is named again.
   */
  it('offers the tag script only in a terminal, and names the build again after it whatever it exited with', () => {
    const offer = script.indexOf('if [ -z "$VERSION_TAG" ] && [ -t 0 ] && [ -t 1 ]; then');
    assert.notEqual(offer, -1, 'on a commit without a tag, with a person at both ends');
    const block = script.slice(offer, script.indexOf('\nfi\n', offer));
    assert.ok(block.includes('echo "This commit has no tag."'));
    assert.ok(block.includes('"Run the tag script now? [y/N] "'));
    assert.match(block, /node "\$WORKSPACE_ROOT\/tools\/release\/tag\.mjs" \|\| [^\n]+\n\s+read_version\n/);
  });

  it('builds the api image on the host with the name and commit of the build, which it exports before the build', () => {
    const remote = script.slice(script.indexOf('<<REMOTE'), script.indexOf('\nREMOTE\n'));
    const exported = [
      remote.indexOf("export MANAGER_VERSION='${MANAGER_VERSION}'"),
      remote.indexOf("export MANAGER_COMMIT='${MANAGER_COMMIT}'"),
    ];
    for (const at of exported) {
      assert.notEqual(at, -1, 'each value goes into the host script in single quotes, after its shape is checked');
      assert.ok(at < remote.indexOf('docker compose build'), 'before compose hands it to the image');
    }
  });

  it("fails unless the api that came up reports the build it made, after the upgrade, and ends with the build's name", () => {
    const remote = script.slice(script.indexOf('<<REMOTE'), script.indexOf('\nREMOTE\n'));
    const asked = remote.indexOf(
      `RUNNING_BUILD="\\$(docker compose exec -T api sh -c 'printf "MANAGER_VERSION=%s MANAGER_COMMIT=%s" "\\\${MANAGER_VERSION:-}" "\\\${MANAGER_COMMIT:-}"' < /dev/null)"`,
    );
    assert.notEqual(asked, -1, 'the api container is asked, with nothing on its standard input');
    assert.ok(asked > remote.indexOf('exit "\\${UPGRADE_STATUS}"'), 'once the upgrade has the api running');
    assert.ok(
      remote.includes(
        `if [ "\\\${RUNNING_BUILD}" != 'MANAGER_VERSION=\${MANAGER_VERSION} MANAGER_COMMIT=\${MANAGER_COMMIT}' ]; then`,
      ),
    );
    assert.ok(script.trimEnd().endsWith('echo "==> Done: deployed ${BUILD_NAME}"'), 'the last thing it says');
  });

  it('feeds both remote docker commands from /dev/null, so neither reads the rest of the script', () => {
    // The remote block arrives on the stdin of one bash, and `run` and `exec` keep stdin open,
    // so without this the lines below them are swallowed instead of run.
    const run = script.slice(script.indexOf('docker compose run --rm --no-deps -T api'));
    const closed = run.indexOf(')"');
    assert.notEqual(closed, -1, 'the substitution that captures the receipt ends somewhere');
    assert.match(
      run.slice(0, closed + 2),
      /\$\{FIRST_USE_FLAG\} < \/dev\/null\)"$/,
      'the upgrade takes no standard input',
    );
    assert.match(
      script,
      /docker compose exec -T api [^\n]* < \/dev\/null/,
      'and neither does the check that follows it',
    );
  });

  it('prints the receipt the upgrade returned, after the command that returned it', () => {
    const captured = script.indexOf(
      'RECEIPT="\\$(docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade',
    );
    assert.notEqual(captured, -1, 'the receipt is the one line the upgrade printed');
    const printed = script.indexOf('echo "[deploy] upgrade receipt: \\${RECEIPT}"');
    assert.notEqual(printed, -1, 'and the deploy prints it as it stands');
    assert.ok(printed > captured, 'after the command that returned it, never before');
  });

  it('prints the receipt of an upgrade that failed, and only then fails the deploy', () => {
    const captured = script.indexOf(
      'RECEIPT="\\$(docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade',
    );
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
    assert.ok(
      script.indexOf('WARNING: PUBLIC_HOST is empty') > script.indexOf('PUBLIC_HOST="'),
      'and says so below it',
    );
  });

  it('looks for the same data volume the upgrade names, so a rename on one side fails here', () => {
    // The script cannot import TypeScript, so its one literal is read back against the
    // constant the command uses and the two are changed together.
    assert.ok(
      script.includes(`POSTGRES_VOLUME="manager_${MANAGER_POSTGRES_VOLUME}"`),
      `the deploy names the manager_${MANAGER_POSTGRES_VOLUME} volume of the manager project`,
    );
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
  /**
   * The environment every git here runs in, the deploy's own included: none of this machine's git configuration,
   * and nothing a hook or `git rebase --exec` exports to point git at another repository, so a scratch repository
   * is the only one any of them touches.
   */
  const gitEnvironment = (): NodeJS.ProcessEnv => {
    const environment: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
      delete environment[name];
    }
    return environment;
  };

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=deploy test', '-c', 'user.email=deploy@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', env: gitEnvironment() },
    ).trim();

  interface Deployed {
    status: number | null;
    stdout: string;
    stderr: string;
    /** Whether the rsync to the host was reached. */
    shipped: boolean;
    /** The arguments of each rsync call, in the order they were made. */
    rsync: string[][];
    /** The target each ssh call was given, in order. */
    ssh: string[];
    /** Each ls-remote git was asked, with how it was asked. */
    remote: string[];
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
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = ls-remote ]; then',
        `    printf '%s | GIT_CONFIG_GLOBAL=%s GIT_TERMINAL_PROMPT=%s\\n' "$*" "$GIT_CONFIG_GLOBAL" "$GIT_TERMINAL_PROMPT" >> '${calls}'`,
        `    exit ${lsRemote}`,
        '  fi',
        'done',
        `exec '${realGit}' "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  /**
   * What a checkout of the one workspace holds at its root: the lockfile, the workspace file, the
   * pnpm the apps name, and the cut tool, which the manager's own pair is cut out of the root's with.
   */
  function seedOneWorkspace(work: string): void {
    const manifest = (name: string): string => `${JSON.stringify({ name, private: true, packageManager: ONE_PNPM })}\n`;
    writeFileSync(join(work, 'package.json'), manifest('monorepo'));
    writeFileSync(join(work, 'pnpm-lock.yaml'), ONE_WORKSPACE_LOCKFILE);
    writeFileSync(
      join(work, 'pnpm-workspace.yaml'),
      'packages:\n  - apps/infra-manager\n  - apps/infra-manager/manager\n',
    );
    writeFileSync(join(work, 'apps', 'infra-manager', 'package.json'), manifest('streaming-infra-manager'));
    writeFileSync(
      join(work, 'apps', 'infra-manager', 'manager', 'package.json'),
      manifest('@streaming-infra-manager/api'),
    );
    cpSync(CUT_TOOL, join(work, 'tools', 'app-workspace'), { recursive: true });
  }

  /**
   * The lines every rsync stand-in starts with: the arguments of this call, NUL separated, in a
   * file of its own under rsync-calls, numbered in the order of the calls.
   */
  function recordsRsyncCall(root: string): string[] {
    const calls = join(root, 'rsync-calls');
    return [`mkdir -p '${calls}'`, `printf '%s\\0' "$@" > '${calls}/'"$(ls '${calls}' | wc -l | tr -d ' ')"`];
  }

  /** The arguments of each rsync call the stand-ins recorded, in the order they were made. */
  function rsyncCalls(root: string): string[][] {
    const calls = join(root, 'rsync-calls');
    if (!existsSync(calls)) return [];
    return readdirSync(calls)
      .sort((a, b) => Number(a) - Number(b))
      .map((call) => readFileSync(join(calls, call), 'utf8').split('\0').slice(0, -1));
  }

  /** An rsync that writes down its arguments and keeps a copy of every source folder but the manager's own. */
  function recordingRsync(root: string): void {
    writeFileSync(
      join(root, 'bin', 'rsync'),
      [
        '#!/bin/bash',
        ...recordsRsyncCall(root),
        'for arg in "$@"; do',
        `  case "$arg" in */) [ "$arg" != ./ ] && [ -d "$arg" ] && cp -R "$arg" '${join(root, 'rsync-extra-source')}' ;; esac`,
        'done',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  /** This machine's own rsync, found before a test puts a stand-in first on PATH. */
  const REAL_RSYNC = execFileSync('sh', ['-c', 'command -v rsync'], { encoding: 'utf8' }).trim();

  /** Where deploy.sh sends the manager's folder on the host, read from the script itself. */
  const HOST_PATH = /^readonly DEFAULT_REMOTE_PATH="(\/[^"]+)"$/m.exec(script)?.[1] ?? '';

  /**
   * An rsync that runs the real one, a host:/path destination landing at the same path under
   * `hostRoot`, which is '' for a host whose paths are this machine's own. It keeps the arguments of
   * each call as given, and refuses a destination outside the test's folder, so a host path that
   * went wrong is never written on this machine. openrsync, macOS's rsync, starts its receiving side
   * as `rsync --server` from PATH, which goes straight on to the real one.
   */
  function realRsync(root: string, hostRoot: string): void {
    writeFileSync(
      join(root, 'bin', 'rsync'),
      [
        '#!/bin/bash',
        `if [ "\${1:-}" = --server ]; then exec '${REAL_RSYNC}' "$@"; fi`,
        ...recordsRsyncCall(root),
        'args=()',
        'for arg in "$@"; do',
        `  if [[ "$arg" =~ ^[A-Za-z0-9._@-]+:(/.*)$ ]]; then args+=('${hostRoot}'"\${BASH_REMATCH[1]}"); else args+=("$arg"); fi`,
        'done',
        'destination="${args[${#args[@]}-1]}"',
        `case "$destination" in '${root}'/*) ;; *) echo "rsync stand-in: $destination is outside the test" >&2; exit 99 ;; esac`,
        `exec '${REAL_RSYNC}' "\${args[@]}"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  /**
   * An ssh that runs its command on this machine, joined the way ssh hands it to the login shell of
   * the host, for a test whose host paths are folders of its own.
   */
  function sshRunningHere(root: string): void {
    writeFileSync(
      join(root, 'bin', 'ssh'),
      ['#!/bin/sh', `printf '%s\\n' "$1" >> '${join(root, 'ssh-targets')}'`, 'shift', 'exec sh -c "$*"', ''].join('\n'),
      { mode: 0o755 },
    );
  }

  /** A docker that says how it was called and fails, so a host script run here stops at its first docker command. */
  function dockerStoppingHere(root: string): void {
    writeFileSync(
      join(root, 'bin', 'docker'),
      ['#!/bin/sh', 'echo "[docker stand-in] $*" >&2', 'exit 97', ''].join('\n'),
      { mode: 0o755 },
    );
  }

  function writeInto(dir: string, files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }

  /** Every file and link under `dir`, by its path from there: a file's text, or `-> ` and a link's target. */
  function treeOf(dir: string): Record<string, string> {
    const tree: Record<string, string> = {};
    const walk = (folder: string): void => {
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

  /** What one rsync call was given to send, in order: every word that is no option, no option's value and no destination. */
  function sourcesOf(args: string[] = []): string[] {
    const sources: string[] = [];
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === '--exclude' || args[index] === '--include') index += 1;
      else if (!args[index].startsWith('-')) sources.push(args[index]);
    }
    return sources;
  }

  /** That a refused deploy stopped before git asked the remote, before the pin was written, and before rsync and ssh. */
  function stoppedBeforeAnything(refused: Deployed): void {
    assert.equal(refused.status, 1, refused.stderr);
    assert.deepEqual(refused.remote, [], 'git asked no remote');
    assert.equal(refused.pin, null, 'no pin was written');
    assert.equal(refused.shipped, false, 'nothing was copied to the host');
    assert.deepEqual(refused.ssh, [], 'and nothing ran there');
  }

  function checkout(
    root: string,
    { lsRemote = 0, oneWorkspace = false }: { lsRemote?: number; oneWorkspace?: boolean } = {},
  ): Checkout {
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', origin);
    const work = join(root, 'work');
    const manager = join(work, 'apps', 'infra-manager');
    mkdirSync(join(manager, 'deploy'), { recursive: true });
    mkdirSync(join(manager, 'manager'));
    mkdirSync(join(work, 'apps', 'hls-stream'));
    if (oneWorkspace) seedOneWorkspace(work);
    cpSync(RELEASE_TOOLS, join(work, 'tools', 'release'), {
      recursive: true,
      filter: (source) => basename(source) !== 'node_modules',
    });
    copyFileSync(DEPLOY_SCRIPT, join(manager, 'deploy', 'deploy.sh'));
    writeFileSync(join(manager, 'manager', '.env'), 'POSTGRES_PASSWORD=synthetic-not-a-secret\n');
    writeFileSync(join(work, 'apps', 'hls-stream', 'README.md'), 'the stack\n');
    writeFileSync(
      join(work, '.gitignore'),
      `apps/infra-manager/manager/.env\napps/infra-manager/manager/${STACK_COMMIT_FILE}\n`,
    );
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'the manager and the stack');
    const stackCommit = git(work, 'rev-parse', 'HEAD');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', 'origin', 'main');

    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'rsync'), ['#!/bin/bash', ...recordsRsyncCall(root), ''].join('\n'), { mode: 0o755 });
    writeFileSync(
      join(bin, 'ssh'),
      `#!/bin/sh\nprintf '%s\\n' "$1" >> '${join(root, 'ssh-targets')}'\ncat > /dev/null\n`,
      { mode: 0o755 },
    );
    gitAnswering(root, bin, lsRemote);
    return {
      work,
      manager,
      stackCommit,
      environment: { ...gitEnvironment(), PATH: `${bin}:${process.env.PATH ?? ''}` },
    };
  }

  /** Commits one file and pushes, and answers the commit. */
  function change(work: string, path: string, text: string): string {
    writeFileSync(join(work, path), text);
    git(work, 'add', path);
    git(work, 'commit', '-qm', `change ${path}`);
    git(work, 'push', '-q', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  }

  /** Lines of a file the stand-ins append to, none when it was never written. */
  const linesOf = (path: string): string[] => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : []);

  /**
   * Runs the deploy with `args`, an ssh target unless a test says otherwise, and answers what this
   * one run did: what the stand-ins recorded and the pin are cleared before it starts.
   */
  function deploy(
    root: string,
    manager: string,
    environment: NodeJS.ProcessEnv,
    args: string[] = ['fixture-host'],
  ): Deployed {
    const pin = join(manager, 'manager', STACK_COMMIT_FILE);
    for (const record of [
      join(root, 'rsync-calls'),
      join(root, 'ssh-targets'),
      join(root, 'ls-remote-calls'),
      join(root, 'docker-calls'),
      join(root, 'built-with'),
      pin,
    ]) {
      rmSync(record, { recursive: true, force: true });
    }
    const run = spawnSync('bash', [join(manager, 'deploy', 'deploy.sh'), ...args], {
      env: environment,
      encoding: 'utf8',
    });
    const rsync = rsyncCalls(root);
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      shipped: rsync.length > 0,
      rsync,
      ssh: linesOf(join(root, 'ssh-targets')),
      remote: linesOf(join(root, 'ls-remote-calls')),
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
      const sources = sourcesOf(deployed.rsync[0]);
      assert.equal(sources.length, 2, `the manager's folder and the cut: ${sources.join(' ')}`);
      assert.equal(sources[0], './');
      const expected = join(root, 'expected');
      execFileSync(process.execPath, [
        join(CUT_TOOL, 'cut.mjs'),
        '--root',
        work,
        '--app',
        'apps/infra-manager',
        '--out',
        expected,
      ]);
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

  /**
   * The same deploy through the machine's own rsync, into a host seeded as an earlier deploy left it:
   * the manager's own lockfile, a file the checkout no longer has, and the bundled tree the engines
   * mount, which the rsync leaves alone. The repository's rsync run again without the cut folder,
   * into an identical host, is what --delete does from the manager's folder alone. The two hosts may
   * differ by the pair, and by the env file the second rsync sends, and nothing else.
   */
  it("leaves the host as rsync --delete leaves it from the manager's folder alone, and the manager's pair besides", () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-real-rsync-'));
    try {
      const { work, manager, environment } = checkout(root, { oneWorkspace: true });
      assert.match(HOST_PATH, /^\/.+/, 'deploy.sh names the path it sends the manager to');
      const earlier = {
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# the manager's own, from before the one workspace\n",
        'stale.txt': 'a file the checkout no longer has\n',
        'manager/swarm-hls-stream/README.md': 'the bundled tree the engines mount, which no deploy touches\n',
      };
      const hostRoot = join(root, 'host');
      writeInto(join(hostRoot, HOST_PATH), earlier);
      realRsync(root, hostRoot);
      const tmp = join(root, 'tmp');
      mkdirSync(tmp);

      const deployed = deploy(root, manager, { ...environment, TMPDIR: tmp });

      assert.equal(deployed.status, 0, deployed.stderr);
      const [argv = []] = deployed.rsync;
      const cutSources = argv.filter((arg) => arg.startsWith(tmp));
      assert.equal(cutSources.length, 1, `one source under TMPDIR, the cut: ${argv.join(' ')}`);
      const alone = join(root, 'alone');
      writeInto(alone, earlier);
      const aloneRun = spawnSync(
        REAL_RSYNC,
        [...argv.filter((arg) => arg !== cutSources[0]).slice(0, -1), `${alone}/`],
        {
          cwd: manager,
          encoding: 'utf8',
        },
      );
      assert.equal(aloneRun.status, 0, aloneRun.stderr);

      const expected = join(root, 'expected');
      execFileSync(process.execPath, [
        join(CUT_TOOL, 'cut.mjs'),
        '--root',
        work,
        '--app',
        'apps/infra-manager',
        '--out',
        expected,
      ]);
      const withoutPair = treeOf(alone);
      assert.deepEqual(treeOf(join(hostRoot, HOST_PATH)), {
        ...withoutPair,
        'pnpm-lock.yaml': readFileSync(join(expected, 'pnpm-lock.yaml'), 'utf8'),
        'pnpm-workspace.yaml': readFileSync(join(expected, 'pnpm-workspace.yaml'), 'utf8'),
        'manager/.env': readFileSync(join(manager, 'manager', '.env'), 'utf8'),
      });
      assert.equal(withoutPair['manager/.env'], undefined, 'the repository rsync carries no env file');
      assert.equal(withoutPair['stale.txt'], undefined, '--delete removed what the checkout no longer has');
      assert.equal(withoutPair['pnpm-lock.yaml'], undefined, "alone, --delete would have removed the host's lockfile");
      assert.equal(withoutPair['manager/swarm-hls-stream/README.md'], earlier['manager/swarm-hls-stream/README.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ships a manager that keeps its own pair as before, from its folder alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-own-pair-'));
    try {
      const { manager, environment } = checkout(root);
      recordingRsync(root);

      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.deepEqual(sourcesOf(deployed.rsync[0]), ['./']);
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

  it("asks the monorepo anonymously, with no credential helper, no prompt and none of this machine's git configuration", () => {
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

  it('asks the first repository STACK_SOURCES in manager/.env names, which is where the host fetches the stack from', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-fork-'));
    try {
      const { manager, environment } = checkout(root);
      writeFileSync(
        join(manager, 'manager', '.env'),
        'POSTGRES_PASSWORD=synthetic-not-a-secret\n' +
          'STACK_SOURCES="https://github.com/example/streaming-monorepo.git#apps/hls-stream, https://github.com/example/other.git#."\n',
      );

      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      const [asked] = readFileSync(join(root, 'ls-remote-calls'), 'utf8').trim().split('\n');
      assert.match(asked, /ls-remote https:\/\/github\.com\/example\/streaming-monorepo\.git HEAD/);
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

  /**
   * Without --profile the deploy is what it was: manager/.env, to the target given alone, or now
   * after --host. With one it is the profile's own file, to the host named with it, in either order.
   * Each flag takes its value after = or as the next word, as web2-admin's deploy.sh does.
   */
  it('deploys manager/.env to the target given alone or after --host, and a profile to the host named with it, with = or a space', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-targets-'));
    try {
      const { manager, environment } = checkout(root);
      writeFileSync(join(manager, 'manager', '.env.dev'), 'POSTGRES_PASSWORD=synthetic-dev-not-a-secret\n');

      for (const [args, profile, envFile] of [
        [['fixture-host'], 'default', 'manager/.env'],
        [['--host=fixture-host'], 'default', 'manager/.env'],
        [['--host', 'fixture-host'], 'default', 'manager/.env'],
        [['--profile=dev', 'fixture-host'], 'dev', 'manager/.env.dev'],
        [['--profile', 'dev', 'fixture-host'], 'dev', 'manager/.env.dev'],
        [['--host', 'fixture-host', '--profile', 'dev'], 'dev', 'manager/.env.dev'],
        [['--profile', 'dev', '--host=fixture-host'], 'dev', 'manager/.env.dev'],
      ] as const) {
        const deployed = deploy(root, manager, environment, [...args]);

        assert.equal(deployed.status, 0, deployed.stderr);
        assert.ok(
          deployed.stdout.includes(`==> Deploying profile ${profile} to fixture-host\n==> Checking ${envFile}\n`),
          `${args.join(' ')} says which profile and which file: ${deployed.stdout}`,
        );
        const [repository = [], sent = [], ...more] = deployed.rsync;
        assert.deepEqual(more, [], 'two rsyncs and no more');
        assert.equal(repository.at(-1), `fixture-host:${HOST_PATH}/`, 'the repository to the target');
        assert.deepEqual(sourcesOf(sent), [envFile], 'then the one env file');
        assert.equal(sent.at(-1), `fixture-host:${HOST_PATH}/manager/.env`, "as the host's manager/.env");
        assert.deepEqual(deployed.ssh, ['fixture-host']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * With no arguments at all the target is viewer and the file manager/.env, as before. The file
   * here holds no password, so the run stops at its check, before anything could reach viewer, an
   * alias a real ~/.ssh/config can hold.
   */
  it('checks manager/.env for viewer, the default target, when it is given no arguments', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-default-target-'));
    try {
      const { manager, environment } = checkout(root);
      writeFileSync(join(manager, 'manager', '.env'), 'LOG_LEVEL=info\n');

      const refused = deploy(root, manager, environment, []);

      stoppedBeforeAnything(refused);
      assert.ok(
        refused.stdout.includes('==> Deploying profile default to viewer\n==> Checking manager/.env\n'),
        refused.stdout,
      );
      assert.match(refused.stderr, /POSTGRES_PASSWORD is missing or empty in manager\/\.env\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The arguments are read as the usage line has them, each at most once, and anything else stops
   * the deploy where it starts. A target is handed to ssh, and written into the host's script, so
   * it is a plain ssh name or nothing.
   */
  it('refuses an unknown flag, a target given twice, or one that is no plain ssh name, before anything runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-arguments-'));
    try {
      const { manager, environment } = checkout(root);

      for (const [args, refusal] of [
        [['--force', 'fixture-host'], /unknown option --force\. Usage: deploy\.sh /],
        [['--hosts', 'fixture-host'], /unknown option --hosts\. /],
        [['-oProxyCommand=sh', 'fixture-host'], /unknown option -oProxyCommand=sh\. /],
        [['--host=-oProxyCommand=sh'], /the ssh target must not start with a dash \(got: -oProxyCommand=sh\)/],
        [['fixture-host', 'other-host'], /the ssh target is given twice \(the second: other-host\)/],
        [['--host=fixture-host', 'other-host'], /the ssh target is given twice \(the second: other-host\)/],
        [['--host', 'fixture-host', 'other-host'], /the ssh target is given twice \(the second: other-host\)/],
        [['other-host', '--host', 'fixture-host'], /the ssh target is given twice \(the second: fixture-host\)/],
        [['--host=fixture-host', '--profile=dev', '--profile=qa'], /--profile is given twice \(the second: qa\)/],
        [['--host=fixture-host', '--profile', 'dev', '--profile=qa'], /--profile is given twice \(the second: qa\)/],
        [['--host='], /the ssh target must be an ssh alias/],
        [['--host', ''], /the ssh target must be an ssh alias/],
        [['fixture host'], /the ssh target must be an ssh alias/],
        [['--host', 'fixture host'], /the ssh target must be an ssh alias/],
        [['fixture-host:/tmp'], /the ssh target must be an ssh alias/],
      ] as const) {
        const refused = deploy(root, manager, environment, [...args]);

        stoppedBeforeAnything(refused);
        assert.match(refused.stderr, refusal, args.join(' '));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A flag written with a space takes the next word as its value. When there is none, or the next
   * word is another flag, the flag has no value, and the refusal says so rather than reading the
   * next flag as a profile name or a target and refusing that instead.
   */
  it('refuses --host or --profile with no value after it, rather than take the next flag as one', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-missing-value-'));
    try {
      const { manager, environment } = checkout(root);
      writeFileSync(join(manager, 'manager', '.env.dev'), 'POSTGRES_PASSWORD=synthetic-dev-not-a-secret\n');

      for (const [args, flag] of [
        [['--profile'], '--profile'],
        [['fixture-host', '--profile'], '--profile'],
        [['--profile', '--host=fixture-host'], '--profile'],
        [['--profile', '-x', 'fixture-host'], '--profile'],
        [['--host'], '--host'],
        [['--profile=dev', '--host'], '--host'],
        [['--host', '--profile=dev'], '--host'],
        [['--host', '-oProxyCommand=sh'], '--host'],
      ] as const) {
        const refused = deploy(root, manager, environment, [...args]);

        stoppedBeforeAnything(refused);
        assert.ok(
          refused.stderr.includes(`ERROR: ${flag} requires a value, as ${flag}=<value> or ${flag} <value>\n`),
          `${args.join(' ')}: ${refused.stderr}`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The name becomes part of a file name, so it is held to the manager's own rule for a profile
   * name. Each file here exists, so only the name can be what refuses it. The sample is refused
   * too: its values are public, and its POSTGRES_PASSWORD would lock the api out of the database.
   */
  it('refuses a profile name the manager would not take, and the sample, before anything runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-profile-name-'));
    try {
      const { manager, environment } = checkout(root);
      writeInto(join(manager, 'manager'), {
        '.env.Dev': 'POSTGRES_PASSWORD=synthetic-not-a-secret\n',
        '.env.-dev': 'POSTGRES_PASSWORD=synthetic-not-a-secret\n',
        '.env.dev.qa': 'POSTGRES_PASSWORD=synthetic-not-a-secret\n',
        '.env.dev_qa': 'POSTGRES_PASSWORD=synthetic-not-a-secret\n',
        '.env.': 'POSTGRES_PASSWORD=synthetic-not-a-secret\n',
        [`.env.${'a'.repeat(32)}`]: 'POSTGRES_PASSWORD=synthetic-not-a-secret\n',
        '.env.sample': 'POSTGRES_PASSWORD=pwd\n',
      });

      for (const name of ['Dev', '-dev', 'dev.qa', 'dev_qa', '', 'a'.repeat(32), '../manager/.env']) {
        const refused = deploy(root, manager, environment, ['--host=fixture-host', `--profile=${name}`]);

        stoppedBeforeAnything(refused);
        assert.match(refused.stderr, /invalid profile name/, `--profile=${name}`);
      }
      const spaced = deploy(root, manager, environment, ['--host', 'fixture-host', '--profile', 'dev.qa']);

      stoppedBeforeAnything(spaced);
      assert.match(spaced.stderr, /invalid profile name: dev\.qa/, 'the same rule for --profile <name>');
      for (const args of [
        ['--host=fixture-host', '--profile=sample'],
        ['--host', 'fixture-host', '--profile', 'sample'],
      ]) {
        const sample = deploy(root, manager, environment, args);

        stoppedBeforeAnything(sample);
        assert.match(sample.stderr, /sample is not a profile/, args.join(' '));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A profile always means its own file. Falling back to manager/.env would give the profile's host
   * the default host's settings, its database password among them.
   */
  it('refuses a profile whose env file is missing, though manager/.env is there, and names the file and the sample', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-profile-missing-'));
    try {
      const { manager, environment } = checkout(root);
      assert.ok(existsSync(join(manager, 'manager', '.env')), 'the default profile has its file');

      const refused = deploy(root, manager, environment, ['--host=fixture-host', '--profile=dev']);

      stoppedBeforeAnything(refused);
      assert.match(
        refused.stderr,
        /manager\/\.env\.dev not found\. Copy manager\/\.env\.sample to manager\/\.env\.dev /,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * With no host named the deploy goes to viewer, and a profile is one host's settings, so it is
   * refused rather than sent there, even the default one named as such. Neither file holds a
   * password, so a deploy that went past the refusal would stop at its check, before anything
   * could reach viewer.
   */
  it('refuses a profile without the host named, because the default target would get its settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-profile-no-host-'));
    try {
      const { manager, environment } = checkout(root);
      writeInto(join(manager, 'manager'), { '.env': 'LOG_LEVEL=info\n', '.env.dev': 'LOG_LEVEL=info\n' });

      for (const profile of ['dev', 'default']) {
        for (const args of [[`--profile=${profile}`], ['--profile', profile]]) {
          const refused = deploy(root, manager, environment, args);

          stoppedBeforeAnything(refused);
          assert.match(refused.stderr, new RegExp(`--profile=${profile} needs the host named`), args.join(' '));
          assert.match(refused.stderr, /would give that profile's settings to viewer, the default target/);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Every setting the deploy reads before anything leaves comes from the profile's file: the
   * password the host needs, the host's folder, and the repository the host fetches the stack from.
   */
  it("reads every check from the profile's env file, and none from manager/.env", () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-profile-checks-'));
    try {
      const { manager, environment } = checkout(root);
      const devSettings =
        'MANAGER_ROOT=/srv/dev-manager\nSTACK_SOURCES=https://github.com/example/dev-fork.git#apps/hls-stream\n';
      writeInto(join(manager, 'manager'), {
        '.env': 'POSTGRES_PASSWORD=synthetic-not-a-secret\nMANAGER_ROOT=/srv/default-manager\n',
        '.env.dev': devSettings,
      });

      const refused = deploy(root, manager, environment, ['--host=fixture-host', '--profile=dev']);

      stoppedBeforeAnything(refused);
      assert.match(refused.stderr, /POSTGRES_PASSWORD is missing or empty in manager\/\.env\.dev\./);

      writeInto(join(manager, 'manager'), {
        '.env': 'MANAGER_ROOT=/srv/default-manager\n',
        '.env.dev': `POSTGRES_PASSWORD=synthetic-dev-not-a-secret\n${devSettings}`,
      });
      const deployed = deploy(root, manager, environment, ['--host=fixture-host', '--profile=dev']);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.match(deployed.remote[0] ?? '', /ls-remote https:\/\/github\.com\/example\/dev-fork\.git HEAD/);
      const [repository = [], sent = []] = deployed.rsync;
      assert.equal(repository.at(-1), 'fixture-host:/srv/dev-manager/');
      assert.equal(sent.at(-1), 'fixture-host:/srv/dev-manager/manager/.env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Writes the dev profile's env file with `managerRoot` as its MANAGER_ROOT, and deploys it. */
  function deployWithManagerRoot(
    root: string,
    manager: string,
    environment: NodeJS.ProcessEnv,
    managerRoot: string,
  ): Deployed {
    writeFileSync(
      join(manager, 'manager', '.env.dev'),
      `POSTGRES_PASSWORD=synthetic-dev-not-a-secret\nMANAGER_ROOT=${managerRoot}\n`,
    );
    return deploy(root, manager, environment, ['--host=fixture-host', '--profile=dev']);
  }

  /** That the deploy refused `managerRoot` as MANAGER_ROOT, in the words web2-admin uses for its remote path, before anything ran. */
  function refusedManagerRoot(refused: Deployed, managerRoot: string): void {
    stoppedBeforeAnything(refused);
    assert.match(refused.stderr, /MANAGER_ROOT must be an absolute path .*, without empty, \. or \.\. segments /);
    assert.ok(refused.stderr.includes(`(got: ${managerRoot})`), refused.stderr);
  }

  /**
   * MANAGER_ROOT names the folder the host's cd, the upgrade's --compose-file and --mutable-root and
   * the printed rm all work in, and it now comes from a profile's file. A . or .. segment would send
   * every one of them somewhere the value does not plainly name, so it is refused before anything
   * runs, as web2-admin refuses such a remote path. A dot inside a name is a name like any other.
   */
  it('refuses a MANAGER_ROOT with a . or .. segment, and takes dots inside a name', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-root-dots-'));
    try {
      const { manager, environment } = checkout(root);

      for (const managerRoot of ['/opt/streaming/../etc', '/opt/streaming/..', '/..', '/opt/./streaming']) {
        refusedManagerRoot(deployWithManagerRoot(root, manager, environment, managerRoot), managerRoot);
      }
      const deployed = deployWithManagerRoot(root, manager, environment, '/srv/my.manager/x..y');

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.equal(deployed.rsync[0]?.at(-1), 'fixture-host:/srv/my.manager/x..y/');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** An empty segment, //, is refused the same way, wherever it is in the path. */
  it('refuses a MANAGER_ROOT with an empty segment', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-root-empty-'));
    try {
      const { manager, environment } = checkout(root);

      for (const managerRoot of ['/opt//streaming', '//opt/streaming', '/opt/streaming//streaming-infra-manager']) {
        refusedManagerRoot(deployWithManagerRoot(root, manager, environment, managerRoot), managerRoot);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Until 2026-10-06 the repository's rsync carried every env file in the manager's folder, so
   * each host was sent the settings of every other. Through the machine's own rsync, into a host an
   * earlier deploy left a qa file, an .envrc, a root .env and a frontend .env.local on: the
   * profile's file arrives as the host's manager/.env, and no other env file arrives from anywhere
   * in the tree. Not manager/'s other files, nor the copies an editor or a hand leaves beside them,
   * which can hold the same secrets, nor the .env at the folder's own root, the credentials a
   * session is handed for the running instance, nor the frontend's, common/'s or deploy/'s. What
   * the host already had is neither replaced nor deleted. Every .env.sample still arrives,
   * manager/'s and the test fixtures'.
   */
  it("sends the profile's env file alone, which the host keeps as manager/.env, and no other env file", () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-profile-sends-'));
    try {
      const { manager, environment } = checkout(root);
      const hostRoot = join(root, 'host');
      writeInto(join(hostRoot, HOST_PATH), {
        'manager/.env': 'POSTGRES_PASSWORD=synthetic-an-earlier-deploy\n',
        'manager/.env.qa': 'POSTGRES_PASSWORD=synthetic-qa-as-an-earlier-deploy-left-it\n',
        'manager/.envrc': 'export POSTGRES_PASSWORD=synthetic-envrc-as-an-earlier-deploy-left-it\n',
        '.env': 'MANAGER_TOKEN=synthetic-session-as-an-earlier-deploy-left-it\n',
        'frontend/.env.local': 'VITE_SETTING=synthetic-as-an-earlier-deploy-left-it\n',
      });
      writeInto(manager, {
        '.env': 'MANAGER_TOKEN=synthetic-session-not-a-secret\n',
        'frontend/.env.local': 'VITE_SETTING=synthetic-not-a-secret\n',
        'frontend/.env': 'VITE_OTHER_SETTING=synthetic-not-a-secret\n',
        'common/.env': 'COMMON_SETTING=synthetic-not-a-secret\n',
        'deploy/.env.local': 'DEPLOY_SETTING=synthetic-not-a-secret\n',
      });
      writeInto(join(manager, 'manager'), {
        '.env.dev': 'POSTGRES_PASSWORD=synthetic-dev-not-a-secret\n',
        '.env.qa': 'POSTGRES_PASSWORD=synthetic-qa-not-a-secret\n',
        '.env.sample': 'POSTGRES_PASSWORD=\n',
        '.env~': 'POSTGRES_PASSWORD=synthetic-editor-backup-not-a-secret\n',
        '.envrc': 'export POSTGRES_PASSWORD=synthetic-envrc-not-a-secret\n',
        '.env-old': 'POSTGRES_PASSWORD=synthetic-old-not-a-secret\n',
        '.env_backup': 'POSTGRES_PASSWORD=synthetic-backup-not-a-secret\n',
        'test/fixtures/stack/v3/.env.sample': 'A_STACK_SETTING=\n',
        'test/fixtures/stack/v3/engines/srs/.env.sample': 'AN_ENGINE_SETTING=\n',
      });
      realRsync(root, hostRoot);

      const deployed = deploy(root, manager, environment, ['--host=fixture-host', '--profile=dev']);

      assert.equal(deployed.status, 0, deployed.stderr);
      const host = treeOf(join(hostRoot, HOST_PATH));
      assert.equal(host['manager/.env'], 'POSTGRES_PASSWORD=synthetic-dev-not-a-secret\n', "the profile's file");
      assert.equal(
        host['manager/.env.qa'],
        'POSTGRES_PASSWORD=synthetic-qa-as-an-earlier-deploy-left-it\n',
        "the checkout's qa file was not sent, and the host's was not deleted",
      );
      assert.equal(
        host['manager/.envrc'],
        'export POSTGRES_PASSWORD=synthetic-envrc-as-an-earlier-deploy-left-it\n',
        "nor was the checkout's .envrc, and the host's stays",
      );
      assert.equal(host['manager/.env.sample'], 'POSTGRES_PASSWORD=\n', 'the sample was sent');
      assert.deepEqual(
        Object.keys(host)
          .filter((path) => path.startsWith('manager/.env'))
          .sort(),
        ['manager/.env', 'manager/.env.qa', 'manager/.env.sample', 'manager/.envrc'],
        'and no other env file arrived, .env~, .env-old and .env_backup among them',
      );
      assert.equal(
        host['.env'],
        'MANAGER_TOKEN=synthetic-session-as-an-earlier-deploy-left-it\n',
        "the folder's own .env was not sent, and the host's stays",
      );
      assert.equal(
        host['frontend/.env.local'],
        'VITE_SETTING=synthetic-as-an-earlier-deploy-left-it\n',
        "nor the frontend's .env.local",
      );
      assert.equal(host['frontend/.env'], undefined, "nor the frontend's .env");
      assert.equal(host['common/.env'], undefined, "nor common/'s .env");
      assert.equal(host['deploy/.env.local'], undefined, "nor deploy/'s .env.local");
      assert.equal(
        host['manager/test/fixtures/stack/v3/.env.sample'],
        'A_STACK_SETTING=\n',
        'a fixture sample arrived',
      );
      assert.equal(host['manager/test/fixtures/stack/v3/engines/srs/.env.sample'], 'AN_ENGINE_SETTING=\n');
      assert.deepEqual(
        Object.keys(host)
          .filter((path) => basename(path).startsWith('.env'))
          .sort(),
        [
          '.env',
          'frontend/.env.local',
          'manager/.env',
          'manager/.env.qa',
          'manager/.env.sample',
          'manager/.envrc',
          'manager/test/fixtures/stack/v3/.env.sample',
          'manager/test/fixtures/stack/v3/engines/srs/.env.sample',
        ],
        "anywhere in the tree, the host holds the profile's file, the samples and what it had, and no other env file",
      );
      const [repository = [], sent = [], ...more] = deployed.rsync;
      assert.deepEqual(more, []);
      assert.deepEqual(sourcesOf(repository), ['./']);
      assert.deepEqual(sourcesOf(sent), ['manager/.env.dev']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A host deployed before 2026-10-06 can still hold the env files of other profiles, and the
   * copies left beside them such as .env~ or .envrc, which rsync never deletes, being excluded. The
   * deploy names every one of them on the host before the build, with the command that removes
   * them, and removes none itself. The host is folders of this test's own: an ssh that runs its
   * command here, the machine's own rsync, and a docker that stops the host's script at its first
   * docker command, the build.
   */
  it('names on the host, before the build, the env files earlier deploys left there, with the command that removes them', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-leftovers-'));
    try {
      const { manager, environment } = checkout(root);
      const managerRoot = join(root, 'host', 'streaming-infra-manager');
      writeInto(join(manager, 'manager'), {
        '.env.dev': `POSTGRES_PASSWORD=synthetic-dev-not-a-secret\nMANAGER_ROOT=${managerRoot}\n`,
        '.env.sample': 'POSTGRES_PASSWORD=\n',
      });
      writeInto(join(managerRoot, 'manager'), {
        '.env': 'POSTGRES_PASSWORD=synthetic-as-an-earlier-deploy-left-it\n',
        '.env.dev': 'POSTGRES_PASSWORD=synthetic-dev-as-an-earlier-deploy-left-it\n',
        '.env.old backup': 'POSTGRES_PASSWORD=synthetic-old-not-a-secret\n',
        '.env.viewer': 'POSTGRES_PASSWORD=synthetic-viewer-not-a-secret\n',
        '.env~': 'POSTGRES_PASSWORD=synthetic-editor-backup-not-a-secret\n',
        '.envrc': 'export POSTGRES_PASSWORD=synthetic-envrc-not-a-secret\n',
        '.env.sample': 'POSTGRES_PASSWORD=\n',
      });
      realRsync(root, '');
      sshRunningHere(root);
      dockerStoppingHere(root);
      const envFiles = (): string[] =>
        readdirSync(join(managerRoot, 'manager'))
          .filter((name) => name.startsWith('.env'))
          .sort();

      const deployed = deploy(root, manager, environment, ['--host=fixture-host', '--profile=dev']);

      assert.equal(deployed.status, 97, `the docker stand-in stopped it at the build: ${deployed.stderr}`);
      const lines = deployed.stderr.split('\n');
      const warned = lines.findIndex((line) => line.includes('env files that earlier deploys copied there'));
      assert.notEqual(warned, -1, deployed.stderr);
      const warning = lines[warned] ?? '';
      const named =
        /^\[deploy\] WARNING: (.+)\/manager on this host still has env files that earlier deploys copied there, and nothing reads them: (.+)\. The manager runs on \.env alone, /.exec(
          warning,
        );
      assert.ok(named, warning);
      assert.equal(named[1], managerRoot);
      // The words of a shell line, a backslash keeping the character after it in its word. The
      // host's glob lists the files in the order of its locale, so they are compared as a set.
      const shellWords = (line: string): string[] => (line.match(/(?:\\.|[^\s\\])+/g) ?? []).sort();
      const leftovers = ['.env.dev', '.env.old\\ backup', '.env.viewer', '.env~', '.envrc'].sort();
      assert.deepEqual(
        shellWords(named[2]),
        leftovers,
        `each one named, the sample and the .env it runs on not among them: ${warning}`,
      );
      assert.ok(lines.indexOf('[docker stand-in] compose build') > warned, 'before the build');
      const command = (lines[warned + 1] ?? '').replace(/^\[deploy\] {3}/, '');
      const prefix = `ssh fixture-host 'cd ${managerRoot}/manager && rm `;
      assert.ok(command.startsWith(prefix) && command.endsWith("'"), command);
      assert.deepEqual(shellWords(command.slice(prefix.length, -1)), leftovers, 'the command names the same files');
      assert.deepEqual(
        envFiles(),
        ['.env', '.env.dev', '.env.old backup', '.env.sample', '.env.viewer', '.env~', '.envrc'].sort(),
        'the deploy removed none of them',
      );

      const removed = spawnSync('bash', ['-c', command], { env: environment, encoding: 'utf8' });

      assert.equal(removed.status, 0, removed.stderr);
      assert.deepEqual(envFiles(), ['.env', '.env.sample'], 'the command removes them and nothing else');
      const again = deploy(root, manager, environment, ['--host=fixture-host', '--profile=dev']);
      assert.equal(again.status, 97, again.stderr);
      assert.equal(again.stderr.includes('earlier deploys copied there'), false, 'a host without them is not warned');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** The image id the docker of an installed host names, in the shape the upgrade checks. */
  const BUILT_IMAGE_ID = `sha256:${'a'.repeat(64)}`;

  /**
   * A docker of a host that has run the manager before. It builds, writing down the build arguments the compose
   * file would hand the api image from the host's environment, names the image, finds the data volume and the
   * containers, prints the upgrade's receipt, and runs a command in the api container with the environment the
   * image was built with. A file `api-reports` in the test's folder stands in for an api whose environment carries
   * another build, and `api-unreachable` for one that cannot be asked.
   */
  function dockerOfAnInstalledHost(root: string): void {
    const file = (name: string): string => join(root, name);
    writeFileSync(
      join(root, 'bin', 'docker'),
      [
        '#!/bin/bash',
        `printf '%s\\n' "$*" >> '${file('docker-calls')}'`,
        'case "$1 $2" in',
        `  'compose build') printf 'MANAGER_VERSION=%s\\nMANAGER_COMMIT=%s\\n' "\${MANAGER_VERSION-(unset)}" "\${MANAGER_COMMIT-(unset)}" > '${file('built-with')}'; exit 0 ;;`,
        `  'image inspect') echo '${BUILT_IMAGE_ID}'; exit 0 ;;`,
        "  'volume ls') echo manager_manager-pg; exit 0 ;;",
        `  'compose run') echo '{"state":"upgraded","bundled":{"state":"ready"}}'; exit 0 ;;`,
        "  'compose exec')",
        '    shift 4',
        `    if [ -e '${file('api-unreachable')}' ]; then echo 'service "api" is not running' >&2; exit 1; fi`,
        `    image='${file('built-with')}'`,
        `    if [ -e '${file('api-reports')}' ]; then image='${file('api-reports')}'; fi`,
        `    exec env MANAGER_VERSION="$(sed -n 's/^MANAGER_VERSION=//p' "$image")" MANAGER_COMMIT="$(sed -n 's/^MANAGER_COMMIT=//p' "$image")" "$@" ;;`,
        'esac',
        'if [ "$1" = ps ]; then echo 0123456789ab; exit 0; fi',
        'echo "docker stand-in: nothing answers $*" >&2',
        'exit 98',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  /**
   * A checkout whose manager/.env puts the host's folder under the test's own, reached through an ssh that runs its
   * command here, the machine's own rsync and the docker of an installed host.
   */
  function checkoutWithHost(root: string): Checkout {
    const checked = checkout(root);
    writeFileSync(
      join(checked.manager, 'manager', '.env'),
      `POSTGRES_PASSWORD=synthetic-not-a-secret\nMANAGER_ROOT=${join(root, 'host', 'streaming-infra-manager')}\n`,
    );
    realRsync(root, '');
    sshRunningHere(root);
    dockerOfAnInstalledHost(root);
    return checked;
  }

  /** The lines version.mjs prints, for a commit and a label of a test's choosing. */
  const versionLines = (commit: string, label: string): string =>
    `VERSION_COMMIT=${commit}\nVERSION_SHORT=${commit.slice(0, 9)}\nVERSION_TAG=\nVERSION_LABEL=${label}\nVERSION_DIRTY=false\n`;

  /** A version.mjs that prints `out` and exits with `status`, for what the real one never prints. */
  function versionPrinting(work: string, out: string, status = 0): void {
    writeFileSync(
      join(work, 'tools', 'release', 'version.mjs'),
      `process.stdout.write(${JSON.stringify(out)});\nprocess.stderr.write('version: a stand-in\\n');\nprocess.exitCode = ${status};\n`,
    );
  }

  /** A tag script that only leaves a mark that it ran, and the mark. */
  function tagScriptMarking(work: string, root: string): string {
    const mark = join(root, 'tag-script-ran');
    writeFileSync(
      join(work, 'tools', 'release', 'tag.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(mark)}, 'ran\\n');\n`,
    );
    return mark;
  }

  /** The last line a run printed. */
  const lastLine = (deployed: Deployed): string | undefined => deployed.stdout.trimEnd().split('\n').at(-1);

  /**
   * The tag on the commit names the build. The host's script exports it before the images are built, where the
   * compose file hands it to the api image, the api that came up reports it back, and the deploy ends with it.
   */
  it('builds the tag and the commit into the api image on the host, finds the api reports them, and ends with both', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-version-'));
    try {
      const { work, manager, environment } = checkoutWithHost(root);
      git(work, 'tag', '-a', '-m', 'a release', 'QA-build-2026-10-07');
      const commit = git(work, 'rev-parse', 'HEAD');
      const short = commit.slice(0, 9);

      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.ok(deployed.stdout.includes(`==> Build: QA-build-2026-10-07 (${short})\n`), deployed.stdout);
      assert.equal(
        readFileSync(join(root, 'built-with'), 'utf8'),
        `MANAGER_VERSION=QA-build-2026-10-07\nMANAGER_COMMIT=${commit}\n`,
        "the host's environment as the images were built, which the compose file hands the api image",
      );
      const upgrade = linesOf(join(root, 'docker-calls')).find((call) => call.includes('manager:upgrade')) ?? '';
      assert.ok(upgrade.includes(`--manager-commit ${commit} `), `the upgrade records the same commit: ${upgrade}`);
      assert.ok(
        deployed.stdout.includes(
          `[deploy] the api container runs MANAGER_VERSION=QA-build-2026-10-07 MANAGER_COMMIT=${commit}\n`,
        ),
        deployed.stdout,
      );
      assert.equal(lastLine(deployed), `==> Done: deployed QA-build-2026-10-07 (${short})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The upgrade has checked the api runs the image just built, so another build here is an environment over the
   * image's. Whatever the api reports, an old build, none at all or the right name on another commit, the deploy
   * fails after the upgrade with both builds named, and so it does when the api cannot be asked.
   */
  it('fails when the api that came up reports another build than the one it built, or cannot be asked', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-version-mismatch-'));
    try {
      const { work, manager, environment } = checkoutWithHost(root);
      git(work, 'tag', '-a', '-m', 'a release', 'QA-build-2026-10-07');
      const commit = git(work, 'rev-parse', 'HEAD');
      const old = 'b'.repeat(40);

      for (const [reports, said] of [
        [
          `MANAGER_VERSION=QA-build-2026-09-29\nMANAGER_COMMIT=${old}\n`,
          `MANAGER_VERSION=QA-build-2026-09-29 MANAGER_COMMIT=${old}`,
        ],
        ['MANAGER_VERSION=\nMANAGER_COMMIT=\n', 'MANAGER_VERSION= MANAGER_COMMIT='],
        [
          `MANAGER_VERSION=QA-build-2026-10-07\nMANAGER_COMMIT=${old}\n`,
          `MANAGER_VERSION=QA-build-2026-10-07 MANAGER_COMMIT=${old}`,
        ],
      ] as const) {
        writeFileSync(join(root, 'api-reports'), reports);

        const failed = deploy(root, manager, environment);

        assert.equal(failed.status, 1, failed.stderr);
        assert.ok(
          failed.stderr.includes(
            `[deploy] ERROR: the api container reports ${said}, and this deploy built MANAGER_VERSION=QA-build-2026-10-07 MANAGER_COMMIT=${commit} into its image.`,
          ),
          failed.stderr,
        );
        assert.ok(failed.stdout.includes('[deploy] upgrade receipt: '), 'it is found once the upgrade has run');
        assert.equal(failed.stdout.includes('==> Done'), false, 'and the deploy never says it is done');
      }

      rmSync(join(root, 'api-reports'));
      writeFileSync(join(root, 'api-unreachable'), '');
      const unasked = deploy(root, manager, environment);

      assert.equal(unasked.status, 1, unasked.stderr);
      assert.match(unasked.stderr, /the api container could not be asked which build it runs/);
      assert.equal(unasked.stdout.includes('==> Done'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * version.mjs prints nothing a shell would have to quote, and this is what the deploy does if it ever did: the
   * label and the commit go into the host's script in single quotes, so a value of any other shape is refused
   * before anything is asked, sent or run, and so is a run of version.mjs that failed.
   */
  it('refuses a build name or a commit of another shape, or none, before anything reaches the host', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-version-shape-'));
    try {
      const { work, manager, environment } = checkout(root);
      const commit = git(work, 'rev-parse', 'HEAD');
      const ran = join(root, 'ran');
      const badLabel = /the build name tools\/release\/version\.mjs printed is not 1 to 96 letters, digits, dots, /;
      const badCommit = /the commit tools\/release\/version\.mjs named is not 40 lowercase hex digits/;

      for (const [out, refusal] of [
        [versionLines(commit, `QA';touch '${ran}';'`), badLabel],
        [versionLines(commit, `QA$(touch ${ran})`), badLabel],
        [versionLines(commit, 'QA`id`'), badLabel],
        [versionLines(commit, 'QA build'), badLabel],
        [versionLines(commit, ''), badLabel],
        [versionLines(commit, 'a'.repeat(97)), badLabel],
        [`VERSION_COMMIT=${commit}\n`, badLabel],
        [versionLines(commit.toUpperCase(), 'QA-build'), badCommit],
        [versionLines(commit.slice(0, 9), 'QA-build'), badCommit],
        [versionLines(`${commit}';touch '${ran}`, 'QA-build'), badCommit],
        ['VERSION_LABEL=QA-build\n', badCommit],
      ] as const) {
        versionPrinting(work, out);

        const refused = deploy(root, manager, environment);

        stoppedBeforeAnything(refused);
        assert.match(refused.stderr, refusal, out);
        assert.equal(existsSync(ran), false, 'and nothing it carried ran');
      }

      versionPrinting(work, versionLines(commit, 'QA-build'), 1);
      const failed = deploy(root, manager, environment);

      stoppedBeforeAnything(failed);
      assert.match(failed.stderr, /tools\/release\/version\.mjs could not name the build of this checkout/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The deploy builds the name and the commit into the api image, and compose reads the env file into the api
   * container over the image's environment. A line for either key, even an empty one, would have the api report a
   * build nobody made, which the check after the upgrade finds only once the host runs the new manager. So it is
   * refused with the env file's other checks, in every form compose reads as an assignment, KEY=, KEY = , KEY: and
   * export KEY=, by the rule web2-admin's deploy refuses its own two keys by, in a profile's file as in manager/.env.
   * A comment that names a key, or another name that holds one, is no such line.
   */
  it('refuses an env file that sets MANAGER_VERSION or MANAGER_COMMIT, even to nothing, before anything reaches the host', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-version-in-env-'));
    try {
      const { manager, environment } = checkout(root);
      const password = 'POSTGRES_PASSWORD=synthetic-not-a-secret\n';

      for (const [line, key] of [
        ['MANAGER_VERSION=QA-build-2026-10-07', 'MANAGER_VERSION'],
        ['MANAGER_VERSION=', 'MANAGER_VERSION'],
        [`MANAGER_COMMIT=${'a'.repeat(40)}`, 'MANAGER_COMMIT'],
        ['MANAGER_COMMIT=', 'MANAGER_COMMIT'],
        ['  MANAGER_VERSION=""', 'MANAGER_VERSION'],
        ['\tMANAGER_COMMIT=', 'MANAGER_COMMIT'],
        ['export MANAGER_VERSION=x', 'MANAGER_VERSION'],
        ['MANAGER_COMMIT = y', 'MANAGER_COMMIT'],
        ['MANAGER_VERSION: z', 'MANAGER_VERSION'],
      ] as const) {
        writeFileSync(join(manager, 'manager', '.env'), `${password}${line}\n`);

        const refused = deploy(root, manager, environment);

        stoppedBeforeAnything(refused);
        assert.ok(
          refused.stderr.includes(
            `ERROR: ${key} is set in manager/.env, and deploy.sh sets it: it builds the value into the api image, and the file's value, even an empty one, would replace the image's in the api container. Remove the line.\n`,
          ),
          `${JSON.stringify(line)}: ${refused.stderr}`,
        );
      }

      writeFileSync(join(manager, 'manager', '.env.dev'), `${password}MANAGER_VERSION=\n`);
      const profile = deploy(root, manager, environment, ['--host=fixture-host', '--profile=dev']);

      stoppedBeforeAnything(profile);
      assert.match(profile.stderr, /ERROR: MANAGER_VERSION is set in manager\/\.env\.dev, /, "a profile's file alike");

      writeFileSync(
        join(manager, 'manager', '.env'),
        [
          password.trimEnd(),
          '# MANAGER_VERSION=QA-build-2026-10-07',
          '# export MANAGER_VERSION=QA-build-2026-10-07',
          `OLD_MANAGER_COMMIT=${'a'.repeat(40)}`,
          'MANAGER_VERSIONS=QA-build-2026-10-07',
          'MANAGER_COMMIT_NOTE=the commit a release came from',
          '',
        ].join('\n'),
      );
      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.equal(deployed.stderr.includes('and deploy.sh sets it'), false, 'none of them is taken for such a line');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Run from a script or a pipe, with no terminal at either end, a deploy of a commit without a tag asks nothing and
   * runs no tag script: it says so, with the name the build deploys as, and goes on. Past a tag, that is the tag and
   * the distance, with the short commit beside it, and with no tag behind it at all, the short commit alone.
   */
  it('never offers the tag script without a terminal, and says which name a commit without a tag deploys as', () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-deploy-version-untagged-'));
    try {
      const { work, manager, environment } = checkout(root);
      const mark = tagScriptMarking(work, root);
      const first = git(work, 'rev-parse', 'HEAD').slice(0, 9);

      const deployed = deploy(root, manager, environment);

      assert.equal(deployed.status, 0, deployed.stderr);
      assert.ok(
        deployed.stdout.includes(`==> This commit has no tag, so the build deploys as ${first}\n`),
        deployed.stdout,
      );
      for (const asked of ['This commit has no tag.', 'Run the tag script now?']) {
        assert.equal(`${deployed.stdout}${deployed.stderr}`.includes(asked), false, `it does not say "${asked}"`);
      }
      assert.equal(existsSync(mark), false, 'the tag script never ran');
      assert.equal(lastLine(deployed), `==> Done: deployed ${first}`);

      git(work, 'tag', '-a', '-m', 'a release', 'QA-build-2026-10-07');
      const past = change(work, 'apps/infra-manager/NOTES.md', 'a manager change\n').slice(0, 9);
      const later = deploy(root, manager, environment);

      assert.equal(later.status, 0, later.stderr);
      assert.ok(
        later.stdout.includes(`==> This commit has no tag, so the build deploys as QA-build-2026-10-07+1 (${past})\n`),
        later.stdout,
      );
      assert.equal(existsSync(mark), false, 'nor does it now');
      assert.equal(lastLine(later), `==> Done: deployed QA-build-2026-10-07+1 (${past})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
