import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BENCH_STAGE, BENCH_TARGET, makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * That `bench-on-host.sh` refuses to run from a checkout that holds no spend ledger, before it copies
 * anything to the host.
 *
 * ⛔ `.spend-ledger.env` is the operator's spend ceiling, a setting written by `spend-ledger.sh` at the root
 * of the checkout and kept out of git. The `spend-ceiling` preflight reads the copy the script syncs
 * to the host, so a checkout without the file could never pass that gate. The gap was the order: the
 * rsync ran first, with `--delete`, so a launch from such a checkout would have replaced the host's
 * harness copy, ledger included, with a tree nobody had authorised, and only then been refused. Any
 * fresh clone is such a checkout, since it holds only what git tracks.
 *
 * Only presence is checked here. What the ledger says is `spendCeiling.test.js`'s question.
 */
const REMOTE_BENCH_DIR = 'swarm-hls-bench';
const SPEND_LEDGER = '.spend-ledger.env';
const OPERATOR_LEDGER = 'authorised_at=2026-09-03T09:32:45Z\n';

/** `--no-setup` opens with `cd ~/swarm-hls-bench` on the far side, and the ssh stub really runs it. */
function sandboxWithRemoteDir() {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR), { recursive: true });
  return sandbox;
}

describe('bench-on-host refuses a checkout that holds no spend ledger', () => {
  it('stops before anything reaches the host', async () => {
    const sandbox = makeSandbox();

    const run = await runScript(sandbox, 'bench-on-host.sh', [
      '--target',
      BENCH_TARGET,
      ...BENCH_STAGE,
      '--script',
      'browser:watch',
    ]);

    assert.notEqual(run.exitCode, 0, 'a checkout without a ledger was allowed to sync');
    assert.match(run.stderr, /\.spend-ledger\.env does not exist/);
    assert.match(run.stderr, /nothing is copied to the host/);
    // The advice names this run's stage. Without it spend-ledger.sh reads the default stage's nodes.
    assert.match(run.stderr, /spend-ledger\.sh --profile=bench-stage --portSlot=7 --authorise=<BZZ>/);
    assert.equal(sandbox.sshCommands().length, 0, `ssh was reached: ${sandbox.sshCommands().join('\n')}`);
    assert.equal(existsSync(join(sandbox.remoteHome, REMOTE_BENCH_DIR)), false, 'the rsync ran before the refusal');
  });

  it('refuses --no-setup too, since the checkout is still the one launching a sitting', async () => {
    const sandbox = sandboxWithRemoteDir();

    const run = await runScript(sandbox, 'bench-on-host.sh', [
      '--target',
      BENCH_TARGET,
      ...BENCH_STAGE,
      '--no-setup',
      '--script',
      'browser:watch',
    ]);

    assert.notEqual(run.exitCode, 0, 'a checkout without a ledger launched with --no-setup');
    assert.match(run.stderr, /\.spend-ledger\.env does not exist/);
    assert.equal(sandbox.sshCommands().length, 0);
  });

  it('runs from a checkout that carries the ledger', async () => {
    const sandbox = sandboxWithRemoteDir();
    writeFileSync(join(sandbox.root, SPEND_LEDGER), OPERATOR_LEDGER);

    const run = await runScript(sandbox, 'bench-on-host.sh', [
      '--target',
      BENCH_TARGET,
      ...BENCH_STAGE,
      '--no-setup',
      '--script',
      'browser:watch',
    ]);

    assert.equal(run.exitCode, 0, `bench-on-host.sh failed: ${run.stdout}${run.stderr}`);
    // The busy-target guard's `docker ps` and then the run, which is what a checkout with a ledger
    // reaches the host for. See `benchOnHostOrphanGuard.test.js`.
    assert.equal(sandbox.sshCommands().length, 2);
    assert.doesNotMatch(run.stderr, /spend-ledger/);
  });
});
