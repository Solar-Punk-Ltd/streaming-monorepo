import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ManagerUpgradeGuard } from '../../src/domain/versions/managerUpgradeGuard.js';

describe('the manager upgrade record', () => {
  let base: string;
  let root: string;
  let installation: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'upgrade-guard-')));
    root = join(base, 'guard', 'upgrade');
    installation = join(base, 'installation');
    await mkdir(installation, { mode: 0o700 });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('leaves only its record behind after each successful write, no temporary file', async () => {
    const guard = new ManagerUpgradeGuard(root, installation);

    guard.acquire({ version: 'v2.4' });
    assert.deepEqual(await readdir(root), ['owner.json']);

    guard.phase('building');
    assert.deepEqual(await readdir(root), ['owner.json']);
  });
});
