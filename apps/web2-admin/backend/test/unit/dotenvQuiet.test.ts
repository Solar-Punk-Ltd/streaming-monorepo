import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

/**
 * dotenv 17 prints a line on every load unless it is told to be quiet, and the line carries dotenv's
 * own advertising: "◇ injected env (3) from .env // tip: …", written with `console.log` whether the
 * file exists or not (measured 2026-09-27 on 17.4.2). This service's output is read by tests,
 * by log collectors and by people, so a load must add nothing to it.
 *
 * This service loads through `import 'dotenv/config'`, whose own option reader sets `quiet` to true
 * unless told otherwise, so it passes on 17 with nothing changed. The case stays to keep it so: a move
 * to `dotenv.config()` without `quiet: true` would start printing.
 */

describe('loading the env files', () => {
  it('adds no line of its own to the output', async () => {
    // `dotenv/config` reads the working directory's .env and says nothing when there is none, so the
    // case runs where one exists, holding one made-up key.
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-quiet-'));
    writeFileSync(join(dir, '.env'), 'DOTENV_QUIET_PROBE=1\n');
    const cwd = process.cwd();
    const log = mock.method(console, 'log', () => {});
    try {
      process.chdir(dir);
      // The config refuses a missing required variable by throwing once dotenv has run, which is not
      // what this case is about. That dotenv ran is asserted below, so a failed import cannot pass.
      await import('../../src/utils/config.js').catch(() => undefined);
    } finally {
      log.mock.restore();
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(process.env.DOTENV_QUIET_PROBE, '1', 'dotenv never loaded the file');

    const dotenvLines = log.mock.calls.map((call) => String(call.arguments[0])).filter((line) => /injected env|dotenv/i.test(line));
    assert.deepEqual(dotenvLines, []);
  });
});
