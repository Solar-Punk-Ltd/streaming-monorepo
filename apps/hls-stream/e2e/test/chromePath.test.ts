import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { chromePath } from '../src/browser/chromePath.js';

/** A folder holding one executable of the given name, standing in for a folder on PATH. */
function folderWith(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-path-'));
  writeFileSync(join(dir, name), '#!/bin/sh\n');
  chmodSync(join(dir, name), 0o755);
  return dir;
}

/**
 * Which Chrome the browser harness launches. BROWSER_CHROME_PATH names it, and without it the browser is
 * looked up on PATH by the names its packages install, which in the browser image finds Google Chrome.
 */
describe('chromePath', () => {
  it('answers the browser BROWSER_CHROME_PATH names', () => {
    assert.equal(chromePath({ BROWSER_CHROME_PATH: '/opt/example/chrome', PATH: '' }), '/opt/example/chrome');
  });

  it('finds a browser on PATH when the setting is unset', () => {
    const dir = folderWith('google-chrome-stable');
    try {
      assert.equal(chromePath({ PATH: `/nonexistent:${dir}` }), join(dir, 'google-chrome-stable'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses, naming the setting, when neither finds one', () => {
    assert.throws(() => chromePath({ PATH: '/nonexistent' }), /BROWSER_CHROME_PATH/);
  });
});
