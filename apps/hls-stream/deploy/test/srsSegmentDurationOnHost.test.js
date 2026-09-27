import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'srs-segment-duration-on-host.sh');
const RUN_TIMEOUT_MS = 30_000;
const stubDirs = [];

after(() => {
  for (const dir of stubDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A PATH whose ssh, docker and ffmpeg write their name to a journal and fail, so a run that reaches
 * for the host is seen doing so and nothing leaves this machine.
 */
function journallingPath() {
  const dir = mkdtempSync(join(tmpdir(), 'srs-probe-on-host-'));
  stubDirs.push(dir);
  const journal = join(dir, 'journal');
  for (const tool of ['ssh', 'docker', 'ffmpeg']) {
    const stub = join(dir, tool);
    writeFileSync(stub, `#!/bin/sh\necho ${tool} >> '${journal}'\nexit 1\n`);
    chmodSync(stub, 0o755);
  }
  return { path: `${dir}${delimiter}${process.env.PATH}`, journal };
}

describe('srs-segment-duration-on-host.sh', () => {
  it('refuses to start without the host address, before it reaches for the host', () => {
    const stubs = journallingPath();
    const env = { ...process.env, PATH: stubs.path };
    delete env.PROBE_HOST_ADDR;

    const run = spawnSync('bash', [SCRIPT, '0.5', '1', 'bench', '5'], { env, encoding: 'utf8', timeout: RUN_TIMEOUT_MS });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /PROBE_HOST_ADDR/);
    assert.equal(existsSync(stubs.journal), false, 'the script called ssh, docker or ffmpeg before it knew the host address');
  });
});
