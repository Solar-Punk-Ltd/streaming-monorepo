/**
 * Why a copy cannot be written onto an archive stamp: the state the manager read comes before the node, since the
 * manager calls a stamp not writable in every state but active and full.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stampProblem } from '../../src/domain/archive/archiveStates.js';

import { archiveBatch } from './support/archiveFakes.js';

const BATCH = 'a'.repeat(64);
const OBSERVED_AT = '2026-11-17T14:18:01.000Z';
const NOW = Date.parse(OBSERVED_AT) + 60_000;

describe('stampProblem', () => {
  it('says a pending stamp is not usable yet, not that its node is the catalogue node no longer', () => {
    const batch = archiveBatch(BATCH, { state: 'pending', writable: false });
    assert.equal(stampProblem(batch, OBSERVED_AT, NOW), 'The archive stamp is not usable yet.');
  });

  it('says an expired or gone stamp is expired or gone, whatever it says of the node', () => {
    const expired = archiveBatch(BATCH, { state: 'expired', writable: false });
    assert.equal(stampProblem(expired, OBSERVED_AT, NOW), 'The archive stamp is expired.');
    const gone = archiveBatch(BATCH, { state: 'gone', writable: false });
    assert.equal(stampProblem(gone, OBSERVED_AT, NOW), 'The archive stamp is gone.');
  });

  it('says the manager could not read a stamp it reads as unknown or none', () => {
    for (const state of ['unknown', 'none'] as const) {
      const batch = archiveBatch(BATCH, { state, writable: false });
      assert.equal(
        stampProblem(batch, OBSERVED_AT, NOW),
        'The manager could not read the archive stamp from its node.',
      );
    }
  });

  it('says the node is the catalogue node no longer only for a usable stamp the manager calls not writable', () => {
    for (const state of ['active', 'full'] as const) {
      const batch = archiveBatch(BATCH, { state, writable: false });
      assert.match(stampProblem(batch, OBSERVED_AT, NOW)!, /the catalogue node no longer/);
    }
  });

  it('finds nothing against a listed, writable, immutable stamp with life left', () => {
    assert.equal(stampProblem(archiveBatch(BATCH), OBSERVED_AT, NOW), null);
  });
});
