import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BENCH_STAGE, BENCH_TARGET, makeSandbox, removeSandboxes, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

const REMOTE_BENCH_DIR = 'swarm-hls-bench';

/**
 * What `bench-on-host.sh` leaves out of the mirror it syncs to the bench host.
 *
 * `.git` always, because nothing there reads history. Beyond that, BENCH_SYNC_EXCLUDE names folders
 * of the checkout to leave behind, space separated, for a checkout that holds whole second copies of
 * the tree, such as nested git worktrees. Unset, nothing else is excluded.
 */
describe('bench-on-host leaves out the folders BENCH_SYNC_EXCLUDE names', () => {
  function sandbox() {
    const box = makeSandbox({ realRsync: true });
    mkdirSync(join(box.remoteHome, REMOTE_BENCH_DIR), { recursive: true });
    writeFileSync(join(box.root, '.spend-ledger.env'), 'authorised_at=2026-09-03T09:32:45Z\n');
    return box;
  }

  function excludes(argv) {
    return argv.flatMap((arg, index) => (argv[index - 1] === '--exclude' ? [arg] : []));
  }

  it('excludes each named folder, and .git', async () => {
    const box = sandbox();

    await runScriptOk(box, 'bench-on-host.sh', ['--target', BENCH_TARGET, ...BENCH_STAGE, '--setup-only'], {
      BENCH_SYNC_EXCLUDE: 'nested/copy other-copy',
    });

    const excluded = excludes(box.rsyncArgv());
    assert.ok(excluded.includes('.git'), excluded.join(' '));
    assert.ok(excluded.includes('nested/copy'), excluded.join(' '));
    assert.ok(excluded.includes('other-copy'), excluded.join(' '));
  });

  it('excludes no folder of a checkout by name when nothing is set', async () => {
    const box = sandbox();

    await runScriptOk(box, 'bench-on-host.sh', ['--target', BENCH_TARGET, ...BENCH_STAGE, '--setup-only']);

    assert.deepEqual(excludes(box.rsyncArgv()), ['.git', 'node_modules', 'reports', 'docs/bench']);
  });
});
