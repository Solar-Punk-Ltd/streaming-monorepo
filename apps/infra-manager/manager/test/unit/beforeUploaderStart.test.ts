/**
 * The step a deploy runs right before it starts a stream uploader: the stage
 * publisher's push, so the uploader's first call finds its token known.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * It runs once the deployment's env file is written, since the record carries
 * the token that file gives the uploader, and before the script is spawned. A
 * failure there is a warning: the deploy goes on.
 */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { Profile } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('before-uploader-start-');
process.env.SHLS_ROOT = root;
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

const BATCH = 'a'.repeat(64);
const streamer = (over: Partial<Profile> = {}): Profile =>
  makeProfile({ name: 'stage', stamp_id: BATCH, status: 'STOPPED', ...over });

describe('before a deploy starts the uploader', () => {
  it('runs the step once the env file is written and before the script starts', async () => {
    const { orchestrator, profiles, runner } = orchestratorHarness([streamer()]);
    const seen: Array<{ name: string; runs: number; envWritten: boolean }> = [];
    orchestrator.setBeforeUploaderStart(async (profile) => {
      seen.push({ name: profile.name, runs: runner.runs.length, envWritten: existsSync(join(root, '.env.stage')) });
    });

    await orchestrator.startDeploy(profiles.rows.get('stage')!, undefined);

    assert.deepEqual(seen, [{ name: 'stage', runs: 0, envWritten: true }]);
    assert.equal(runner.runs.length, 1);
  });

  it('runs it for the uploader-only deploy too', async () => {
    const { orchestrator, profiles } = orchestratorHarness([streamer()]);
    const seen: string[] = [];
    orchestrator.setBeforeUploaderStart(async (profile) => void seen.push(profile.name));

    await orchestrator.startDeployUploader(profiles.rows.get('stage')!);

    assert.deepEqual(seen, ['stage']);
  });

  it('does not hold the deploy when the step fails', async () => {
    const { orchestrator, profiles, runner } = orchestratorHarness([streamer()]);
    orchestrator.setBeforeUploaderStart(async () => {
      throw new Error('the admin did not answer');
    });

    await orchestrator.startDeploy(profiles.rows.get('stage')!, undefined);

    assert.equal(runner.runs.length, 1, 'the script started anyway');
  });

  it('does not run for a deploy that starts no uploader', async () => {
    const { orchestrator, profiles, runner } = orchestratorHarness([streamer()]);
    const seen: string[] = [];
    orchestrator.setBeforeUploaderStart(async (profile) => void seen.push(profile.name));

    await orchestrator.startDeploy(profiles.rows.get('stage')!, ['srs']);

    assert.deepEqual(seen, []);
    assert.equal(runner.runs.length, 1);
  });
});
