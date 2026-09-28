import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundedCleanup, CLEANUP_TIMEOUT_MS } from './boundedCleanup.js';

describe('boundedCleanup', () => {
  it('gives five seconds by default', () => {
    assert.equal(CLEANUP_TIMEOUT_MS, 5000);
  });

  it('answers with what the work answered when it finishes in time', async () => {
    assert.equal(await boundedCleanup(Promise.resolve('done'), 1000), 'done');
  });

  it('passes on the work failing in time as the work failed', async () => {
    await assert.rejects(boundedCleanup(Promise.reject(new Error('rollback refused')), 1000), /rollback refused/);
  });

  it('gives up on work that never finishes', async () => {
    await assert.rejects(boundedCleanup(new Promise(() => {}), 10), /Migration connection cleanup timed out\./);
  });
});
