import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { chromePath } from '../scripts/chrome-path.mjs';

/** A folder holding one executable of the given name, standing in for a folder on PATH. */
function folderWith(name) {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-path-'));
  writeFileSync(join(dir, name), '#!/bin/sh\n');
  chmodSync(join(dir, name), 0o755);
  return dir;
}

/**
 * Which Chrome the CDP scripts start. CHROME_PATH names it, and without it the browser is looked up on
 * PATH by the names its packages install, so no one machine's install location is assumed.
 */
describe('chromePath', () => {
  it('answers the browser CHROME_PATH names', () => {
    assert.equal(chromePath({ CHROME_PATH: '/opt/example/chrome', PATH: '' }), '/opt/example/chrome');
  });

  it('finds a browser on PATH when the setting is unset', () => {
    const dir = folderWith('chromium');
    try {
      assert.equal(chromePath({ PATH: `/nonexistent:${dir}` }), join(dir, 'chromium'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers Google Chrome over Chromium where both are on PATH', () => {
    const chromium = folderWith('chromium');
    const chrome = folderWith('google-chrome');
    try {
      assert.equal(chromePath({ PATH: `${chromium}:${chrome}` }), join(chrome, 'google-chrome'));
    } finally {
      rmSync(chromium, { recursive: true, force: true });
      rmSync(chrome, { recursive: true, force: true });
    }
  });

  it('refuses, naming the setting, when neither finds one', () => {
    assert.throws(() => chromePath({ PATH: '/nonexistent' }), /CHROME_PATH/);
  });
});
