/**
 * What a stop leaves behind when it fails between its claim and its script.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A stop claims the deployment by moving it to STOPPING, then records that the
 * operator acted, then starts the stop script. A stop goes straight to the job,
 * with no deploy reservation around it to settle a failure, so a throw after the
 * claim must be settled by the job itself. Otherwise the row sits in STOPPING
 * with no script running and refuses every later action as busy until the
 * manager restarts. And a deployment replaced since the stop read it belongs to
 * its replacement, so the stop must not claim it at all.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('stop-after-claim-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
const { ProfileInstanceChangedError } = await import('../../src/domain/errors/index.js');

function setup() {
  const harness = orchestratorHarness([makeProfile({ name: 'stage', instance_id: 'instance-1', intent_revision: 3 })]);
  const row = () => {
    const found = harness.profiles.rows.get('stage');
    if (!found) throw new Error('stage is gone');
    return found;
  };
  return { harness, row };
}

describe('a stop that fails after its claim', () => {
  it('leaves a deployment replaced since the stop read it to its replacement', async () => {
    const { harness, row } = setup();
    const readBeforeTheReplacement = structuredClone(row());
    harness.profiles.write('stage', { instance_id: 'instance-2', status: 'RUNNING' });

    await assert.rejects(
      harness.orchestrator.startStop(readBeforeTheReplacement, undefined),
      ProfileInstanceChangedError,
    );

    assert.equal(row().instance_id, 'instance-2');
    assert.equal(row().status, 'RUNNING');
    assert.equal(row().intent_revision, 3);
    assert.equal(harness.runner.runs.length, 0);
  });

  it('marks the deployment failed when recording the operator action throws', async () => {
    const { harness, row } = setup();
    harness.operations.supersedeOpen = async () => {
      throw new Error('the operations table refused the write');
    };

    await assert.rejects(harness.orchestrator.startStop(row(), undefined), /the operations table refused the write/);

    assert.equal(row().status, 'ERROR');
    assert.match(row().last_error ?? '', /the operations table refused the write/);
    assert.equal(harness.runner.runs.length, 0);
  });
});
