import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts');

/**
 * That a bench script names the stage it drives rather than falling back to one.
 *
 * Each of these used to default to one stage's profile and port slot, so a launch that forgot to name
 * the stage published into that one and spent its postage. The stage is now required the way
 * `--target` already was, and every name and port the script uses is derived from it.
 *
 * Every tool a script could reach is stubbed to leave a mark, so a refusal that came after a docker,
 * ssh, curl or rsync call is caught rather than passing on its exit status alone.
 */

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'bench-stage-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const tool of ['docker', 'ssh', 'curl', 'rsync', 'scp']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\ntouch '${join(dir, 'tool-ran')}'\nexit 1\n`, { mode: 0o755 });
  }
  return { dir, bin, ran: () => existsSync(join(dir, 'tool-ran')) };
}

function run(script, args, extraEnv = {}) {
  const box = sandbox();
  const result = spawnSync('bash', [join(SCRIPTS, script), ...args], {
    env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.dir, TMPDIR: box.dir, ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stderr: result.stderr, ran: box.ran() };
}

/** Drivers configured from the environment, the way they run detached on the bench host. */
const ENV_DRIVEN = [
  'buffer-sweep-sitting.sh',
  'byte-source-arms.sh',
  'cache-flag-control.sh',
  'cold-gateway-idle-cpu.sh',
  'crash-arms.sh',
  'does-the-network-warm-up.sh',
  'gateway-funding-arms.sh',
  'overnight-golden-zone.sh',
  'phase06-light-vs-ultralight.sh',
  'retrieval-debt-probe.sh',
  'sweep-interleaved.sh',
  'validate-light-vs-ultralight.sh',
  'viewer-arms.sh',
];

describe('a bench driver with no stage named', () => {
  for (const script of ENV_DRIVEN) {
    it(`${script} refuses without PROFILE, before any tool runs`, () => {
      const refused = run(script, [], { PORT_SLOT: '3' });

      assert.notEqual(refused.status, 0, refused.stderr);
      assert.match(refused.stderr, /PROFILE/);
      assert.equal(refused.ran, false, 'a tool ran before the refusal');
    });

    it(`${script} refuses without PORT_SLOT, before any tool runs`, () => {
      const refused = run(script, [], { PROFILE: 'stage-a' });

      assert.notEqual(refused.status, 0, refused.stderr);
      assert.match(refused.stderr, /PORT_SLOT/);
      assert.equal(refused.ran, false, 'a tool ran before the refusal');
    });
  }

  it('unfunded-gateway.sh refuses without PROFILE or FUNDED_CONTAINER, before any tool runs', () => {
    const refused = run('unfunded-gateway.sh', ['status']);

    assert.notEqual(refused.status, 0, refused.stderr);
    assert.match(refused.stderr, /PROFILE or FUNDED_CONTAINER/);
    assert.equal(refused.ran, false, 'a tool ran before the refusal');
  });
});

/** Launchers run from a workstation, which take the stage as flags beside --target. */
describe('a bench launcher with no stage named', () => {
  for (const script of ['bench-on-host.sh', 'bench-profiles.sh', 'bench-sweep.sh', 'browser-on-host.sh']) {
    it(`${script} refuses without --profile and --portSlot, before any tool runs`, () => {
      for (const args of [
        ['--target', 'bench.example.com'],
        ['--target', 'bench.example.com', '--profile', 'stage-a'],
        ['--target', 'bench.example.com', '--portSlot', '3'],
      ]) {
        const refused = run(script, args);

        assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stderr}`);
        assert.match(refused.stderr, /--profile <profile> and --portSlot <slot> are required/);
        assert.equal(refused.ran, false, 'a tool ran before the refusal');
      }
    });
  }
});

/** Tools a driver calls, which read a node at ports derived from the stage rather than one slot's. */
describe('a node reader with no stage named', () => {
  it('node-metrics.sh refuses a snapshot without PORT_SLOT or the three ports, before any tool runs', () => {
    const refused = run('node-metrics.sh', ['snapshot', '/dev/null', 'label']);

    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /PORT_SLOT/);
    assert.equal(refused.ran, false, 'a tool ran before the refusal');
  });

  it('stamp-guard.sh refuses without --port, before any tool runs', () => {
    const refused = run('stamp-guard.sh', ['--batch', 'a'.repeat(64)]);

    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /--port is required/);
    assert.equal(refused.ran, false, 'a tool ran before the refusal');
  });

  for (const script of ['soc-miss-cost.sh', 'feed-under-concurrency.sh']) {
    it(`${script} refuses without PORT_SLOT or GATEWAY_BEE_PORT, before any tool runs`, () => {
      const refused = run(script, []);

      assert.notEqual(refused.status, 0, refused.stderr);
      assert.match(refused.stderr, /PORT_SLOT/);
      assert.equal(refused.ran, false, 'a tool ran before the refusal');
    });
  }
});
