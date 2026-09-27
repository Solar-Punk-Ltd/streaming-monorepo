import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository this file sits in, whose committed scripts every sandbox runs. */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * The committed files a sandbox copies in, at the same paths. Both scripts find everything from
 * their own location, so a copy works on the sandbox's files and never on the repository's.
 */
const COPIED_FROM_REPOSITORY = [
  'apps/web2-admin/deploy/deploy.sh',
  'apps/web2-admin/deploy/docker-compose.yml',
  'infra/edge/edge.sh',
  'infra/edge/docker-compose.yml',
];

/** A real checkout always has the committed templates, so a sandbox has stand-ins for them. */
const SAMPLES = {
  'apps/web2-admin/backend/.env.sample': '# A test fixture standing in for the committed template.\n',
  'infra/edge/.env.sample': '# A test fixture standing in for the committed template.\n',
};

/**
 * Each stub writes its name and arguments to the journal, one line per call, and nothing leaves
 * this machine. ssh treats the fake host, a folder in the sandbox, as the host: it runs a command
 * there only when the command names that folder, and a script on standard input only when the
 * script changes into it, so nothing outside the sandbox is touched. docker answers just enough for
 * a deploy's steps on the host to find a healthy stack. git answers "not a repository" whatever
 * folder the sandbox sits in.
 */
const STUBS = {
  ssh: `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$STUB_JOURNAL"
if [ -z "$FAKE_HOST_DIR" ]; then
  echo "ssh stub: FAKE_HOST_DIR is not set, so there is no host to run anything on" >&2
  exit 97
fi
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -t | -T) shift ;;
    -G) exit 0 ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] && shift
command_line="$*"
if [ "$command_line" = "bash -s" ]; then
  script="$(cat)"
  case "$script" in
    *"cd '$FAKE_HOST_DIR'"*) printf '%s\\n' "$script" | bash -s; exit $? ;;
  esac
  echo "ssh stub: the script sent to the host does not change into $FAKE_HOST_DIR" >&2
  exit 97
fi
case "$command_line" in
  *"$FAKE_HOST_DIR"*) exec sh -c "$command_line" ;;
esac
echo "ssh stub: refusing a command that does not name $FAKE_HOST_DIR: $command_line" >&2
exit 97
`,
  rsync: journalOnly('rsync'),
  docker: `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$STUB_JOURNAL"
case " $* " in
  *" ps -q "*) echo stub-container ;;
  " inspect "*) echo healthy ;;
  *" exec "*) echo '{"status":"ok"}' ;;
esac
exit 0
`,
  curl: journalOnly('curl'),
  dig: journalOnly('dig'),
  git: `#!/bin/sh
printf 'git %s\\n' "$*" >> "$STUB_JOURNAL"
echo "fatal: not a git repository" >&2
exit 128
`,
};

const RUN_TIMEOUT_MS = 30_000;

/** Every sandbox made so far, for removeSandboxes. */
const sandboxes = [];

function journalOnly(name) {
  return `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "$STUB_JOURNAL"\nexit 0\n`;
}

function writeTree(base, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
}

export function removeSandboxes() {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * The command a script printed on a line of its own for the operator to run, as the one capture
 * group of `pattern`. Fails the test, showing the output, when there is none.
 */
export function printedCommand(output, pattern) {
  const match = pattern.exec(output);
  assert.ok(match, `no command matching ${pattern} in:\n${output}`);
  return match[1];
}

/**
 * A profile env file that passes deploy.sh's checks and holds nothing real. The marker goes into
 * the password, so a test can show that what a file holds never reaches the output.
 */
export function fakeAdminEnv(marker) {
  return [
    '# A test fixture, not a deployment.',
    `POSTGRES_PASSWORD=${marker}-fixture-password`,
    `FEED_PRIVATE_KEY=0x${'1'.repeat(64)}`,
    'INTERNAL_API_TOKEN=fixture-token-of-more-than-thirty-two-characters',
    'BEE_URL=http://bee.fixture.invalid:1633',
    `POSTAGE_BATCH_ID=${'2'.repeat(64)}`,
    'INGEST_HOST=ingest.fixture.invalid',
    '',
  ].join('\n');
}

/** The edge's env file with one made-up name to serve. The marker is part of the name. */
export function fakeEdgeEnv(marker) {
  return ['# A test fixture, not a deployment.', `ADMIN_DOMAIN=${marker}.fixture.invalid`, 'ADMIN_PORT=9090', ''].join('\n');
}

/**
 * A throwaway checkout of this repository holding the two deploy scripts, laid out as the
 * repository is, beside a fake host and a folder of stubs that go first on PATH.
 *
 * `checkout` and `host` map a path to the content written there. Without `host` the fake host does
 * not exist yet, which is a host nothing was deployed to.
 */
export function makeSandbox({ checkout = {}, host } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'web2-admin-deploy-'));
  sandboxes.push(dir);
  const root = join(dir, 'checkout');
  const hostDir = join(dir, 'host');
  const bin = join(dir, 'bin');
  const journal = join(dir, 'journal');

  for (const path of COPIED_FROM_REPOSITORY) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPOSITORY_ROOT, path), join(root, path));
  }
  writeTree(root, { ...SAMPLES, ...checkout });
  if (host) writeTree(hostDir, host);
  writeTree(bin, STUBS);
  for (const name of Object.keys(STUBS)) chmodSync(join(bin, name), 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    STUB_JOURNAL: journal,
    FAKE_HOST_DIR: hostDir,
    HEALTH_TIMEOUT: '10',
    PROBE_TIMEOUT: '0',
  };
  // A file bash would source before every script it starts.
  delete env.BASH_ENV;
  delete env.ENV;

  const journalLines = () => (existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(Boolean) : []);

  /** Runs one command in the sandbox and returns its streams, its status and the stub calls it made. */
  const spawn = (command, args, cwd) => {
    const before = journalLines().length;
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', input: '', timeout: RUN_TIMEOUT_MS });
    if (result.error) throw result.error;
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: journalLines().slice(before),
    };
  };

  return {
    root,
    hostDir,
    inCheckout: (path) => join(root, path),
    onHost: (path) => join(hostDir, path),
    /** Runs one of the copied scripts, by its path from the repository root. */
    runScript: (script, args = [], { cwd = root } = {}) => spawn('bash', [join(root, script), ...args], cwd),
    /** Runs a command line a script printed for the operator, with the same stubs. */
    runPrinted: (commandLine, { cwd = root } = {}) => spawn('sh', ['-c', commandLine], cwd),
  };
}
