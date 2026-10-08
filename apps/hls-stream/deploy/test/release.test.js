import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript, runScriptOk, sourceLib } from './helpers/sandbox.js';

const execFileAsync = promisify(execFile);

after(removeSandboxes);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A release as the deployment manager names one: a tag, and the whole commit it is on. */
const LABEL = 'QA-build-2026-10-07';
const COMMIT = `1702aff1b${'e'.repeat(31)}`;

/** The two keys the client is built with, as `deploy.sh` writes them. */
const KEYS = ['VITE_APP_RELEASE_LABEL', 'VITE_APP_RELEASE_COMMIT'];

/** The startup watch driven fast, as `profile.test.js` drives it. Nothing here is about the watch. */
const FAST_WATCH = {
  DEPLOY_SETTLE_SECONDS: '0',
  DEPLOY_WATCH_INTERVAL_SECONDS: '0.05',
  DEPLOY_READY_TIMEOUT_SECONDS: '0.5',
};

/**
 * The value compose interpolates for `name`: the env files it was handed, in order, sourced the way
 * `deploy_target` sources the one it writes, so a later line wins as it does for compose.
 */
async function sourcedValue(sandbox, text, name) {
  const file = join(sandbox.root, 'sourced.env');
  writeFileSync(file, text);
  const read = await execFileAsync('bash', ['-c', `. ${JSON.stringify(file)}\nprintf '%s' "\${${name}:-}"`]);
  return read.stdout;
}

/** The lines of `text` that set one of the release keys. */
function releaseLines(text) {
  return text.split('\n').filter((line) => KEYS.some((key) => line.startsWith(`${key}=`)));
}

/**
 * The player names the release it was built as in its QoE overlay. The deployment manager passes the
 * label and the commit of the stack build a deployment runs as `--release-label` and
 * `--release-commit`, and only to a version whose contract says its `parse_profile_args` takes them.
 * An older parser reads an unknown flag as a service name and refuses the whole deploy.
 */
describe('deploy.sh building the release into the client', () => {
  it('writes the label and the commit for compose, quoted, and sourcing them gives back exactly the values', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(
      sandbox,
      'deploy.sh',
      [`--release-label=${LABEL}`, `--release-commit=${COMMIT}`, 'client'],
      FAST_WATCH,
    );

    assert.deepEqual(releaseLines(sandbox.envFiles()), [
      `VITE_APP_RELEASE_LABEL='${LABEL}'`,
      `VITE_APP_RELEASE_COMMIT='${COMMIT}'`,
    ]);
    assert.equal(await sourcedValue(sandbox, sandbox.envFiles(), 'VITE_APP_RELEASE_LABEL'), LABEL);
    assert.equal(await sourcedValue(sandbox, sandbox.envFiles(), 'VITE_APP_RELEASE_COMMIT'), COMMIT);
  });

  it('takes the two-word spellings too, as every flag parse_profile_args reads does', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(
      sandbox,
      'deploy.sh',
      ['--release-label', LABEL, '--release-commit', COMMIT, 'client'],
      FAST_WATCH,
    );

    assert.equal(await sourcedValue(sandbox, sandbox.envFiles(), 'VITE_APP_RELEASE_LABEL'), LABEL);
    assert.equal(await sourcedValue(sandbox, sandbox.envFiles(), 'VITE_APP_RELEASE_COMMIT'), COMMIT);
  });

  /**
   * The harder half: the text is expanded into a heredoc on this machine and written out again on
   * the far side, which is where a manager's deployment usually builds its client.
   */
  it('carries both to the far side for a client built on a remote host', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE });

    await runScriptOk(
      sandbox,
      'deploy.sh',
      [`--release-label=${LABEL}`, `--release-commit=${COMMIT}`, 'client'],
      FAST_WATCH,
    );

    const sent = sandbox.remoteEnvFiles();
    assert.equal(await sourcedValue(sandbox, sent, 'VITE_APP_RELEASE_LABEL'), LABEL);
    assert.equal(await sourcedValue(sandbox, sent, 'VITE_APP_RELEASE_COMMIT'), COMMIT);
  });

  it('builds a label alone, which the overlay shows without a commit', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(sandbox, 'deploy.sh', [`--release-label=${LABEL}`, 'client'], FAST_WATCH);

    assert.equal(await sourcedValue(sandbox, sandbox.envFiles(), 'VITE_APP_RELEASE_LABEL'), LABEL);
    assert.equal(await sourcedValue(sandbox, sandbox.envFiles(), 'VITE_APP_RELEASE_COMMIT'), '');
  });

  /**
   * A release names the build being deployed, so it comes from the flags or from nowhere. An env file
   * or the caller's own environment naming one would reach the bundle past the shape check, so both
   * lines are written empty, and the overlay then shows no release at all.
   *
   * Compose lets its own environment win over every env file, so the files alone would not settle it
   * for a value the shell exports: deploy_target sources the file it writes with `set -a` before
   * compose runs, and the stub records what compose's environment then held.
   */
  it('writes both lines empty without the flags, over whatever an env file or the environment says', async () => {
    const sandbox = makeSandbox({
      envFiles: {
        '.env': `STAMP=stamp\nSTREAM_KEY=key\nVITE_APP_RELEASE_LABEL=from-the-env-file\nVITE_APP_RELEASE_COMMIT=${COMMIT}\n`,
      },
    });

    await runScriptOk(sandbox, 'deploy.sh', ['client'], {
      ...FAST_WATCH,
      VITE_APP_RELEASE_LABEL: 'from-the-shell',
      VITE_APP_RELEASE_COMMIT: COMMIT,
      DOCKER_STUB_ENV_KEYS: KEYS.join(','),
    });

    const written = sandbox.envFiles();
    assert.deepEqual(releaseLines(written).slice(-2), ["VITE_APP_RELEASE_LABEL=''", "VITE_APP_RELEASE_COMMIT=''"]);
    assert.equal(await sourcedValue(sandbox, written, 'VITE_APP_RELEASE_LABEL'), '');
    assert.equal(await sourcedValue(sandbox, written, 'VITE_APP_RELEASE_COMMIT'), '');
    assert.deepEqual(sandbox.upEnv(), [{ VITE_APP_RELEASE_LABEL: '', VITE_APP_RELEASE_COMMIT: '' }]);
  });

  /**
   * Why the manager asks the contract first. A version whose parser has no arm for a flag hands it on
   * as a service name, and the deploy stops there, so a release passed to an older version would fail
   * every deploy of it rather than go unshown.
   */
  it('refuses a flag its parser has no arm for, as an older version refuses these two', async () => {
    const sandbox = makeSandbox();

    const run = await runScript(sandbox, 'deploy.sh', [`--release-name=${LABEL}`, 'client'], FAST_WATCH);

    assert.notEqual(run.exitCode, 0, 'an unknown flag was deployed past');
    assert.match(`${run.stdout}${run.stderr}`, /Unknown service: --release-name=/);
    assert.deepEqual(
      sandbox.calls().filter((call) => call.startsWith('compose')),
      [],
    );
  });

  it('writes nothing for a target that builds no client, which is the file it wrote before', async () => {
    const sandbox = makeSandbox();

    await runScriptOk(
      sandbox,
      'deploy.sh',
      [`--release-label=${LABEL}`, `--release-commit=${COMMIT}`, 'stream-uploader'],
      FAST_WATCH,
    );

    assert.deepEqual(releaseLines(sandbox.envFiles()), []);
    assert.ok(
      sandbox.calls().some((call) => call.startsWith('compose')),
      'the uploader was not deployed at all, so the empty answer above proves nothing',
    );
  });
});

/**
 * ⛔ Both values reach a file the deploy `source`s, here and again on the deployment host, so their
 * shape is refused up front, the way the four overrides beside them are, and `shell_quote` quotes
 * them as well. The label then reaches the bundle and the overlay, which prints it as text.
 */
describe('deploy.sh refusing a release in another shape', () => {
  const UNSAFE_LABELS = [
    ['a command substitution', 'a$(exit 7)b'],
    ['a space', 'QA build'],
    ['a quote', "QA'build"],
    ['a backslash escape the writer used to turn into a second line', 'aa\\nEXTRA_KEY=smuggled'],
    ['markup', '<b>x</b>'],
    ['97 characters', 'a'.repeat(97)],
  ];

  for (const [what, label] of UNSAFE_LABELS) {
    it(`refuses a label carrying ${what}, naming the flag, before compose`, async () => {
      const sandbox = makeSandbox();

      const run = await runScript(sandbox, 'deploy.sh', [`--release-label=${label}`, 'client'], FAST_WATCH);
      const said = `${run.stdout}${run.stderr}`;

      assert.notEqual(run.exitCode, 0, `a label carrying ${what} was accepted: ${said}`);
      assert.match(said, /--release-label must be letters, digits/);
      assert.deepEqual(
        sandbox.calls().filter((call) => call.startsWith('compose')),
        [],
        'a refused label still reached compose',
      );
      assert.doesNotMatch(sandbox.envFiles(), /EXTRA_KEY/, 'the smuggled key reached the env file compose reads');
    });
  }

  const UNSAFE_COMMITS = [
    ['a short commit', '1702aff1b'],
    ['upper-case hex', COMMIT.toUpperCase()],
    ['a dirty suffix', `${COMMIT}-dirty`],
    ['41 characters', `${COMMIT}0`],
    ['a command substitution', `$(exit 7)${COMMIT.slice(9)}`],
  ];

  for (const [what, commit] of UNSAFE_COMMITS) {
    it(`refuses a commit that is ${what}, naming the flag, before compose`, async () => {
      const sandbox = makeSandbox();

      const run = await runScript(
        sandbox,
        'deploy.sh',
        [`--release-label=${LABEL}`, `--release-commit=${commit}`, 'client'],
        FAST_WATCH,
      );
      const said = `${run.stdout}${run.stderr}`;

      assert.notEqual(run.exitCode, 0, `a commit that is ${what} was accepted: ${said}`);
      assert.match(said, /--release-commit must be a whole commit, 40 lower-case hex characters/);
      assert.deepEqual(
        sandbox.calls().filter((call) => call.startsWith('compose')),
        [],
        'a refused commit still reached compose',
      );
    });
  }

  /** The refusal says the flag and the shape. The value is not repeated, as for the overrides. */
  it('does not repeat the value it refused', async () => {
    const sandbox = makeSandbox();

    const run = await runScript(sandbox, 'deploy.sh', ['--release-label=not allowed here', 'client'], FAST_WATCH);

    assert.notEqual(run.exitCode, 0);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /not allowed here/);
  });

  it('accepts every character a label may hold, the longest included', async () => {
    const sandbox = makeSandbox();
    const every = 'v2.4.0_rc+3/release-';
    const label = `${every}${'a'.repeat(96 - every.length)}`;

    const run = await sourceLib(sandbox, `parse_profile_args --release-label=${label}\nrelease_overrides_text`);

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`^VITE_APP_RELEASE_LABEL='${label.replace(/[.+/]/g, '\\$&')}'$`, 'm'));
    assert.match(run.stdout, /^VITE_APP_RELEASE_COMMIT=''$/m);
  });
});

/**
 * The three places that have to agree for a release to reach the bundle: compose passing each key as
 * a build arg, the Dockerfile declaring it, and Vite reading it while it builds. Written out rather
 * than read from one of them, as `clientImage.test.js` does for the build stamp.
 */
describe('the client image building the release in', () => {
  const dockerfile = readFileSync(join(ROOT, 'deploy', 'Dockerfile.client'), 'utf8');
  const compose = readFileSync(join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8');

  it('passes both keys from the compose service into the build, empty when unset', () => {
    for (const key of KEYS) {
      assert.match(compose, new RegExp(`^\\s+${key}: \\$\\{${key}:-\\}$`, 'm'), `docker-compose.yml passes no ${key}`);
    }
  });

  /**
   * An image built by a deploy script that knows nothing about the release still builds, and its
   * overlay shows none.
   */
  it('declares both with an empty default and hands them to the build as environment', () => {
    for (const key of KEYS) {
      assert.match(dockerfile, new RegExp(`^ARG ${key}=$`, 'm'), `Dockerfile.client declares no ${key} with a default`);
      assert.match(
        dockerfile,
        new RegExp(`${key}=\\$${key}\\b`),
        `Dockerfile.client puts no ${key} into the environment`,
      );
    }
  });

  /**
   * ⛔ Order is the property. Vite reads the environment while it builds, so a key declared after the
   * build is never in the bundle, and a release moves with every tag, so one declared before the
   * install would install the dependencies again for every release.
   */
  it('declares them after the install and before the build that reads them', () => {
    const installed = dockerfile.indexOf('pnpm install --frozen-lockfile');
    const built = dockerfile.indexOf('pnpm --filter @swarm-hls-stream/client build');
    for (const key of KEYS) {
      const declared = dockerfile.indexOf(`ARG ${key}=`);
      assert.ok(declared > installed, `${key} is declared before the install, so a new release reinstalls`);
      assert.ok(declared < built, `${key} is declared after the build, so the bundle never sees it`);
    }
  });
});
