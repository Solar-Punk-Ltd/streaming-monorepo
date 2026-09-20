import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ManagedLifecycleConflict,
  classifyManagedEvent,
  isManagedPermissionTransitionAllowed,
  isManagedRunTransitionAllowed,
  matchesManagedClaim,
} from '../../src/domain/managedLifecycle.js';

describe('managed lifecycle event ordering', () => {
  it('accepts a new event and identifies an exact retry', () => {
    assert.equal(classifyManagedEvent(null, { sequence: 1, digest: 'live-1' }), 'accept');
    assert.equal(
      classifyManagedEvent(
        { sequence: 2, digest: 'waiting-2' },
        { sequence: 2, digest: 'waiting-2' },
      ),
      'duplicate',
    );
  });

  it('distinguishes a stale event from a conflicting retry', () => {
    assert.throws(
      () =>
        classifyManagedEvent(
          { sequence: 4, digest: 'vod-4' },
          { sequence: 3, digest: 'closed-3' },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ManagedLifecycleConflict);
        assert.equal(error.code, 'stale_event');
        return true;
      },
    );
    assert.throws(
      () =>
        classifyManagedEvent(
          { sequence: 4, digest: 'vod-4' },
          { sequence: 4, digest: 'different-vod-4' },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ManagedLifecycleConflict);
        assert.equal(error.code, 'event_conflict');
        return true;
      },
    );
  });
});

describe('managed lifecycle state invariants', () => {
  it('allows reconnect and finalization without reopening a closed run', () => {
    assert.equal(isManagedRunTransitionAllowed('ready', 'claimed'), true);
    assert.equal(isManagedRunTransitionAllowed('claimed', 'live'), true);
    assert.equal(isManagedRunTransitionAllowed('live', 'waiting'), true);
    assert.equal(isManagedRunTransitionAllowed('waiting', 'live'), true);
    assert.equal(isManagedRunTransitionAllowed('waiting', 'closed'), true);
    assert.equal(isManagedRunTransitionAllowed('closed', 'vod'), true);

    assert.equal(isManagedRunTransitionAllowed('closed', 'live'), false);
    assert.equal(isManagedRunTransitionAllowed('vod', 'live'), false);
    assert.equal(isManagedRunTransitionAllowed('vod', 'waiting'), false);
  });

  it('never reopens a closed publishing permission', () => {
    assert.equal(isManagedPermissionTransitionAllowed('open', 'claimed'), true);
    assert.equal(isManagedPermissionTransitionAllowed('open', 'closed'), true);
    assert.equal(isManagedPermissionTransitionAllowed('claimed', 'closed'), true);
    assert.equal(isManagedPermissionTransitionAllowed('closed', 'closed'), true);

    assert.equal(isManagedPermissionTransitionAllowed('closed', 'open'), false);
    assert.equal(isManagedPermissionTransitionAllowed('closed', 'claimed'), false);
  });

  it('binds a claimed run to both uploader and claim identity', () => {
    const run = {
      uploaderId: 'srs-157-90-34-105',
      claimId: '44444444-4444-4444-8444-444444444444',
    };

    assert.equal(matchesManagedClaim(run, run.uploaderId, run.claimId), true);
    assert.equal(matchesManagedClaim(run, 'different-uploader', run.claimId), false);
    assert.equal(
      matchesManagedClaim(run, run.uploaderId, '99999999-9999-4999-8999-999999999999'),
      false,
    );
  });
});
