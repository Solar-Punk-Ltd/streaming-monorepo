/**
 * The segment length a deploy hands SRS and the uploader.
 *
 * Unit test: the deploy orchestrator against a fake runner, a scratch stack
 * root standing in for the deploy server's.
 *
 * The stack has no default segment length since 2026-10-08 and both containers
 * refuse to start without one, so every deploy has to write it. A version cut
 * before that still falls back to 0.5 on its own, and is handed the manager's 2.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { SRS_SERVICE } from '@streaming-infra-manager/common';
import { throwawayRoot } from '../support/throwawayRoot.js';

// envUtils reads SHLS_ROOT once when it loads, so the root is set before
// anything reaching it loads.
const root = throwawayRoot('segment-length-');
process.env.SHLS_ROOT = root;
const BASE_ENV = 'ENGINE=srs\nAPI_PORT=10000\n';
writeFileSync(join(root, '.env'), BASE_ENV, 'utf8');

const { ALLOCATION_CONTRACT } = await import('../support/allocationContract.js');
const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');
const { makeProfile } = await import('../support/profileFixtures.js');

describe('what a deploy hands SRS for the segment length', () => {
  async function deployed(name: string, baseEnv: string, engineSettings: Record<string, string> = {}): Promise<string> {
    writeFileSync(join(root, '.env'), baseEnv, 'utf8');
    const stored = makeProfile({ name, stamp_id: 'a'.repeat(64), engine_settings: engineSettings });
    const harness = orchestratorHarness([stored]);
    await harness.versions.setContract(1, {
      ...structuredClone(ALLOCATION_CONTRACT),
      engineDefaults: { HLS_FRAGMENT: '0.5' },
    });

    await harness.orchestrator.startDeploy(stored, [SRS_SERVICE]);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, name);

    return readFileSync(join(root, `.env.${name}`), 'utf8');
  }

  after(() => writeFileSync(join(root, '.env'), BASE_ENV, 'utf8'));

  it("writes the manager's 2 where neither the deployment nor the host sets one", async () => {
    assert.match(await deployed('fragment-default', BASE_ENV), /^HLS_FRAGMENT=2$/m);
  });

  it('keeps the value the host sets', async () => {
    assert.match(await deployed('fragment-host', `${BASE_ENV}HLS_FRAGMENT=1\n`), /^HLS_FRAGMENT=1$/m);
  });

  it('writes what the deployment stored over both', async () => {
    const file = await deployed('fragment-stored', `${BASE_ENV}HLS_FRAGMENT=1\n`, { HLS_FRAGMENT: '1.5' });

    assert.match(file, /^HLS_FRAGMENT=1\.5$/m);
    assert.doesNotMatch(file, /^HLS_FRAGMENT=1$/m);
  });
});
