import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

/**
 * dotenv 17 prints a line on every load unless it is told to be quiet, and the line carries dotenv's
 * own advertising: "◇ injected env (3) from .env // tip: …", written with `console.log` whether the
 * file exists or not (measured 2026-09-27 on 17.4.2). This service's output is read by tests,
 * by log collectors and by people, so a load must add nothing to it.
 */

describe('loading the env files', () => {
  it('adds no line of its own to the output', async () => {
    const log = mock.method(console, 'log', () => {});
    try {
      const { loadEnv } = await import('../src/lib/config-reader.js');
      loadEnv();
    } finally {
      log.mock.restore();
    }

    const dotenvLines = log.mock.calls.map((call) => String(call.arguments[0])).filter((line) => /injected env|dotenv/i.test(line));
    assert.deepEqual(dotenvLines, []);
  });
});
