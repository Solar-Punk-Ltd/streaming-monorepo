/**
 * How long a new Chrome may take to open its debugging port.
 *
 * On GitHub's ubuntu-24.04 runner image of 2026-09-27, Chrome 154 took about
 * 19 seconds to answer its first starts, where Chrome 153 on the image before
 * it took under two. The launcher waited 15 seconds for the port, so the first
 * three browser suites of every run failed with "Timed out waiting for Chrome
 * debugging port" and every suite after them passed.
 *
 * A Node-only file: no browser, no Vite. `CHROME_BIN` points at a stand-in
 * that opens its port after 16 seconds, which is past the old budget, and this
 * case takes that long.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { launchChrome } from './chrome.mjs';

const SLOW_CHROME = fileURLToPath(new URL('./slow-chrome.mjs', import.meta.url));
/** Past the fifteen seconds every wait gets by default. */
const SLOW_START_MS = 16_000;

test('waits for a browser that takes longer than fifteen seconds to open its port', async (t) => {
  process.env.CHROME_BIN = SLOW_CHROME;
  process.env.SLOW_CHROME_DELAY_MS = String(SLOW_START_MS);

  const failure = await launchChrome(t, 'http://127.0.0.1:1').then(
    () => null,
    (error) => error,
  );

  // The stand-in's port has nothing behind it, so a launcher that waited long
  // enough fails on the request after the port wait, never on the wait itself.
  assert.ok(failure, 'the stand-in serves no tabs, so the launch cannot succeed');
  assert.doesNotMatch(failure.message, /Chrome debugging port/, `gave up on a slow start: ${failure.message}`);
});
