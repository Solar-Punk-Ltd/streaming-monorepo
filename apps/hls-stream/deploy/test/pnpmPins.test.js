import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

const { packageManager } = JSON.parse(read('package.json'));
const pinnedVersion = packageManager.slice('pnpm@'.length).split('+')[0];

/**
 * One pnpm for every image that runs one, named in the root manifest. The uploader's own test checks
 * its Dockerfile. The client activates the pin with corepack as the uploader does, which checks the
 * download against the checksum after the plus sign. Bench and browser install pnpm with npm, for the
 * reason Dockerfile.bench gives, so they name the version alone.
 */
describe('the pnpm each image of the stack runs', () => {
  it('Dockerfile.client activates the pnpm the root manifest names, checksum included', () => {
    assert.ok(
      read('deploy/Dockerfile.client').includes(`corepack prepare ${packageManager} --activate`),
      `the client image must activate ${packageManager}`,
    );
  });

  for (const dockerfile of ['e2e/Dockerfile.bench', 'e2e/Dockerfile.browser']) {
    it(`${dockerfile} installs the pnpm version the root manifest names`, () => {
      const pin = /^ARG PNPM_VERSION=(\S+)$/m.exec(read(dockerfile));

      assert.ok(pin, `${dockerfile} no longer pins pnpm with ARG PNPM_VERSION, so this test checks the wrong thing`);
      assert.equal(
        pin[1],
        pinnedVersion,
        `${dockerfile} installs pnpm ${pin[1]}, the root manifest names ${pinnedVersion}`,
      );
    });
  }
});
