import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';

const HEALTHCHECK = join(ROOT_DIR, 'engines', 'srs', 'healthcheck.sh');

/** The ingest ports of a stage at slot 7, and how the kernel spells each in an address field. */
const SRT_PORT = '10071';
const SRT_HEX_PORT = '2757';
const RTMP_PORT = '10072';
const RTMP_HEX_PORT = '2758';

/** The inode the kernel reports for a socket, which is the only thing tying it to an owner. */
const SRS_SRT_INODE = '3744450441';
const SRS_RTMP_INODE = '3744450442';
const STRANGER_SOCKET_INODE = '9999999999';

/**
 * One `/proc/net/udp` line, in the kernel's column order.
 *
 * Copied from the real file on the deployment host rather than invented, because the whole check is
 * an offset into these columns and a fixture with the wrong shape would pass against a script that
 * reads the wrong one.
 */
function udpLine(hexPort: string, inode: string): string {
  return (
    `41469: 00000000:${hexPort} 00000000:0000 07 00000000:00000000 00:00000000 00000000` +
    `     0        0 ${inode} 2 0000000000000000 0`
  );
}

function udp6Line(hexPort: string, inode: string): string {
  return (
    `  1: 00000000000000000000000000000000:${hexPort} 00000000000000000000000000000000:0000 07 ` +
    `00000000:00000000 00:00000000 00000000     0        0 ${inode} 2 0000000000000000 0`
  );
}

const UDP_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops';

/**
 * `/proc/net/tcp` and `tcp6` lines, in the kernel's column order.
 *
 * Copied from the real files of a Linux container listening on TCP, with only the port, the inode and the kernel's
 * socket pointer replaced, for the same reason the UDP lines are. TCP adds one trap UDP does not have: a connection
 * SRS accepted shares the listener's local port, so the state column (`0A` is listening) is part of what is read.
 */
function tcpListenerLine(hexPort: string, inode: string): string {
  return (
    `   0: 00000000:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000` +
    `     0        0 ${inode} 1 0000000000000000 100 0 0 10 0`
  );
}

function tcp6ListenerLine(hexPort: string, inode: string): string {
  return (
    `   0: 00000000000000000000000000000000:${hexPort} 00000000000000000000000000000000:0000 0A ` +
    `00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0`
  );
}

/** A connection the listener on `hexPort` accepted, captured closing (`05`), so a socket on the port but no listener. */
function tcpAcceptedLine(hexPort: string, inode: string): string {
  return (
    `   1: 0100007F:${hexPort} 0100007F:A15B 05 00000000:00000000 00:00000000 00000000` +
    `     0        0 ${inode} 1 0000000000000000 20 0 0 10 -1`
  );
}

const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const TCP6_HEADER =
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when ' +
  'retrnsmt   uid  timeout inode';

interface FakeProc {
  /** What the script is given as its `/proc`. */
  root: string;
}

interface ProcContents {
  udp?: string[];
  udp6?: string[];
  tcp?: string[];
  tcp6?: string[];
  ownedInodes?: string[];
}

/**
 * A `/proc` the script can be pointed at, holding the two facts it reads: what the kernel says is
 * bound, and which sockets the container's own processes hold.
 *
 * Built as real files and real symlinks rather than stubbed at a seam inside the script, so what the
 * test drives is the same `readlink` and the same `awk` a container runs.
 */
function fakeProc(options: ProcContents): FakeProc {
  const root = mkdtempSync(join(tmpdir(), 'srs-healthcheck-'));
  mkdirSync(join(root, 'net'), { recursive: true });
  const write = (file: string, header: string, lines: string[] | undefined): void =>
    writeFileSync(join(root, 'net', file), [header, ...(lines ?? [])].join('\n') + '\n');
  write('udp', UDP_HEADER, options.udp);
  write('udp6', UDP_HEADER, options.udp6);
  write('tcp', TCP_HEADER, options.tcp);
  write('tcp6', TCP6_HEADER, options.tcp6);

  const fdDir = join(root, '1', 'fd');
  mkdirSync(fdDir, { recursive: true });
  (options.ownedInodes ?? []).forEach((inode, index) => {
    symlinkSync(`socket:[${inode}]`, join(fdDir, String(index + 8)));
  });
  return { root };
}

/** Both listeners, each held by SRS: a container that can take a broadcast over either protocol. */
const BOTH_HELD: ProcContents = {
  udp: [udpLine(SRT_HEX_PORT, SRS_SRT_INODE)],
  tcp: [tcpListenerLine(RTMP_HEX_PORT, SRS_RTMP_INODE)],
  ownedInodes: [SRS_SRT_INODE, SRS_RTMP_INODE],
};

interface Outcome {
  status: number;
  output: string;
}

/**
 * Runs the script with nothing of this machine's environment but `PATH`, so an `SRS_*_PORT` set in the shell
 * that runs the tests cannot decide a case.
 */
function runScript(args: string[], env: Record<string, string> = {}): Outcome {
  try {
    const output = execFileSync('bash', [HEALTHCHECK, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/** The ports given as arguments, the way a person runs it by hand. */
function runHealthcheck(proc: FakeProc, ports: { srt?: string; rtmp?: string } = {}): Outcome {
  return runScript([ports.srt ?? SRT_PORT, proc.root, ports.rtmp ?? RTMP_PORT]);
}

const created: FakeProc[] = [];

function procFor(options: ProcContents): FakeProc {
  const proc = fakeProc(options);
  created.push(proc);
  return proc;
}

/**
 * OBS-20: a stack can be Up, healthy and unable to receive a broadcast.
 *
 * On 2026-08-03 `latbench-srs-1` ran 44 minutes with its SRT listener dead. It had failed to bind
 * with `errno=98` because another container still held the port under host networking, and every
 * signal the deployment had reported on a process that was running rather than on a socket that was
 * listening. The bind error itself was not written to the log until the container was stopped.
 *
 * **The port being bound is not the question**, and a check that asked only that would have passed
 * throughout the outage: the port was bound, by the wrong process. What separates the two states is
 * ownership, so the check has to tie the listening socket back to a process in this container, which
 * is what the inode in `/proc/net/udp` and `/proc/net/tcp` is for.
 *
 * Both ingest listeners are checked and both must pass: SRT on UDP, and RTMP on TCP, which is a public
 * ingest too and also carries the ladder's rung republishes.
 */
describe('the SRS ingest healthcheck', () => {
  after(() => {
    for (const proc of created) {
      rmSync(proc.root, { recursive: true, force: true });
    }
  });

  it('passes when SRS itself holds both the SRT and the RTMP port', () => {
    assert.equal(runHealthcheck(procFor(BOTH_HELD)).status, 0);
  });

  /**
   * The outage, reproduced. The port is bound and no process in this container holds it, which is
   * exactly what `docker ps`, the uploader's `/health` and the old process-liveness healthcheck all
   * reported as fine.
   */
  it('fails when the SRT port is bound by a process outside this container', () => {
    const proc = procFor({ ...BOTH_HELD, udp: [udpLine(SRT_HEX_PORT, STRANGER_SOCKET_INODE)] });

    const outcome = runHealthcheck(proc);

    assert.notEqual(outcome.status, 0);
    assert.match(outcome.output, /UDP 10071 \(SRT\) is bound by a process outside this container/);
  });

  it('fails, differently, when nothing is bound to the SRT port at all', () => {
    const proc = procFor({ ...BOTH_HELD, udp: [] });

    const outcome = runHealthcheck(proc);

    assert.notEqual(outcome.status, 0);
    assert.match(outcome.output, /nothing is listening on UDP 10071 \(SRT\)/);
  });

  it('accepts an SRT listener bound on IPv6 rather than IPv4', () => {
    const proc = procFor({ ...BOTH_HELD, udp: [], udp6: [udp6Line(SRT_HEX_PORT, SRS_SRT_INODE)] });

    assert.equal(runHealthcheck(proc).status, 0);
  });

  /**
   * A port whose hex spelling is a suffix of another's. 10071 is `2757` and 4439 is `1157`, so a
   * match anchored anywhere but the end of the address field would confuse `:1157` for `:2757`
   * whenever one contains the other. Guarded because the failure would be a healthcheck that passes
   * off an unrelated listener, which is the same shape of blindness OBS-20 already is.
   */
  it('does not accept a listener on a different port whose hex looks similar', () => {
    const proc = procFor({
      ...BOTH_HELD,
      udp: [udpLine(`1${SRT_HEX_PORT}`, SRS_SRT_INODE), udpLine(SRT_HEX_PORT.slice(0, 3), SRS_SRT_INODE)],
    });

    assert.notEqual(runHealthcheck(proc).status, 0);
  });

  it('fails when nothing listens on the RTMP port, naming the protocol and the port', () => {
    const proc = procFor({ ...BOTH_HELD, tcp: [] });

    const outcome = runHealthcheck(proc);

    assert.notEqual(outcome.status, 0, 'an engine with a live SRT listener is still unhealthy without its RTMP one');
    assert.match(outcome.output, /nothing is listening on TCP 10072 \(RTMP\)/);
  });

  it('fails when the RTMP port is bound by a process outside this container', () => {
    const proc = procFor({ ...BOTH_HELD, tcp: [tcpListenerLine(RTMP_HEX_PORT, STRANGER_SOCKET_INODE)] });

    const outcome = runHealthcheck(proc);

    assert.notEqual(outcome.status, 0);
    assert.match(outcome.output, /TCP 10072 \(RTMP\) is bound by a process outside this container/);
  });

  /**
   * A connection SRS accepted on the RTMP port carries that port as its local address and is held by SRS, so a
   * check that read every socket on the port would pass on it after the listener itself had gone.
   */
  it('counts only a listening socket on the RTMP port, not a connection SRS accepted on it', () => {
    const proc = procFor({ ...BOTH_HELD, tcp: [tcpAcceptedLine(RTMP_HEX_PORT, SRS_RTMP_INODE)] });

    const outcome = runHealthcheck(proc);

    assert.notEqual(outcome.status, 0);
    assert.match(outcome.output, /nothing is listening on TCP 10072 \(RTMP\)/);
  });

  it('accepts an RTMP listener bound on IPv6 rather than IPv4', () => {
    const proc = procFor({ ...BOTH_HELD, tcp: [], tcp6: [tcp6ListenerLine(RTMP_HEX_PORT, SRS_RTMP_INODE)] });

    assert.equal(runHealthcheck(proc).status, 0);
  });

  for (const [which, ports] of [
    ['SRT', { srt: 'not-a-port' }],
    ['RTMP', { rtmp: 'not-a-port' }],
  ] as const) {
    it(`refuses an ${which} port that is not a number, rather than probing for hex garbage`, () => {
      const outcome = runHealthcheck(procFor(BOTH_HELD), ports);

      assert.notEqual(outcome.status, 0);
      assert.match(outcome.output, /must be a port number/);
    });
  }

  /**
   * How compose runs it: with no arguments, reading the two ports from the variables both compose files put into
   * the container's environment, which are the ones the entrypoint wrote SRS's `listen` lines from. The SRT port is
   * given as empty here only so the fake `/proc` can be passed after it, and an empty argument reads the variable.
   */
  it('reads both ports from the environment compose gives the container', () => {
    const proc = procFor(BOTH_HELD);

    assert.equal(runScript(['', proc.root], { SRS_SRT_PORT: SRT_PORT, SRS_RTMP_PORT: RTMP_PORT }).status, 0);

    const elsewhere = runScript(['', proc.root], { SRS_SRT_PORT: SRT_PORT, SRS_RTMP_PORT: '10082' });
    assert.notEqual(elsewhere.status, 0, 'an RTMP port the environment names is the one that is checked');
    assert.match(elsewhere.output, /TCP 10082 \(RTMP\)/);
  });

  it('checks RTMP on 1935 and SRT on 10080 when nothing names either port', () => {
    const proc = procFor({
      udp: [udpLine('2760', SRS_SRT_INODE)],
      tcp: [tcpListenerLine('078F', SRS_RTMP_INODE)],
      ownedInodes: [SRS_SRT_INODE, SRS_RTMP_INODE],
    });

    assert.equal(runScript(['', proc.root]).status, 0);
  });
});

/**
 * That the script these tests drove is the script a container runs, on **both** paths.
 *
 * There are two compose files carrying an `srs` service and they are not interchangeable.
 * `engines/srs/docker-compose.yml` is the standalone one behind `pnpm srs:host`, and
 * `deploy/docker-compose.yml` is what `deploy.sh` puts on a target: the live `latbench-srs-1`
 * reports the second. The first version of this fix wired only the standalone file, so the check
 * would have been absent from every real deployment while every test here passed.
 *
 * The rsync is asserted for the same reason and it is the sharper half. That list carries
 * `--delete`, so a file left out of it is not merely missing on the target, it is removed from a
 * target that had it, and the container would then bind-mount a directory over the script and go
 * permanently unhealthy on a deployment that is fine.
 */
describe('the healthcheck reaches the container on both paths', () => {
  const read = (...parts: string[]): string => readFileSync(join(ROOT_DIR, ...parts), 'utf8');

  /** The `srs` service of a compose file, so a variable another service sets cannot pass for one SRS gets. */
  const srsService = (compose: string): string => {
    const start = compose.indexOf('\n  srs:');
    const next = compose.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next === -1 ? compose.slice(start) : compose.slice(start, start + 1 + next);
  };

  for (const composePath of [
    ['engines', 'srs', 'docker-compose.yml'],
    ['deploy', 'docker-compose.yml'],
  ]) {
    it(`mounts the script and runs it, in ${composePath.join('/')}`, () => {
      const compose = read(...composePath);

      assert.match(compose, /healthcheck\.sh:\/usr\/local\/srs\/conf\/healthcheck\.sh:ro/);
      assert.match(compose, /test: \['CMD', 'bash', '\/usr\/local\/srs\/conf\/healthcheck\.sh'\]/);
    });

    it(`hands the script both ports it checks, in ${composePath.join('/')}`, () => {
      const srs = srsService(read(...composePath));

      assert.match(srs, /^\s*SRS_SRT_PORT:\s*\$\{SRS_SRT_PORT:-10080\}\s*$/m);
      assert.match(srs, /^\s*SRS_RTMP_PORT:\s*\$\{SRS_RTMP_PORT:-1935\}\s*$/m);
    });
  }

  it('ships the script to a remote target, which the compose mount cannot do for itself', () => {
    assert.match(read('deploy', 'scripts', 'deploy.sh'), /engines\/srs\/healthcheck\.sh/);
  });
});
