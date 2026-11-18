/**
 * Why a copy cannot be written onto an archive stamp: the state the manager read comes before the node, since the
 * manager calls a stamp not writable in every state but active and full. And when a copy's stamp ran out once the
 * record lists it no longer: the end each record gives it, and what the copy then reads.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StreamArchiveRow } from '../../src/domain/archive/ArchiveRepository.js';
import { archiveStampEnds, qualityState, stampProblem } from '../../src/domain/archive/archiveStates.js';

import { archiveBatch } from './support/archiveFakes.js';

const BATCH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const OBSERVED_AT = '2026-11-17T14:18:01.000Z';
const NOW = Date.parse(OBSERVED_AT) + 60_000;
const DAY = 86_400_000;

/** A complete copy of the 360p rung at slot 5 on `BATCH`, with the stamp end a record gave it. */
function copy(stampExpiresAt: Date | null): StreamArchiveRow {
  return {
    stream_id: 'stream-1',
    rendition: '360p',
    batch_id: BATCH,
    feed_owner: 'f'.repeat(40),
    feed_topic: 'c'.repeat(64),
    manifest_index: 5,
    state: 'complete',
    parity_missing: 0,
    segments: 3,
    chunks: 300,
    bytes: 1_200_000,
    chunks_rebuilt: 0,
    bucket_sum_before: null,
    bucket_sum_after: null,
    bzz_spent_estimate_plur: null,
    completed_at: new Date(OBSERVED_AT),
    completed_by_user_id: null,
    completed_by: 'operator',
    stamp_expires_at: stampExpiresAt,
  };
}

/** The end a record observed at `observedAt` gives `BATCH`, read with `over`. */
function endFrom(observedAt: string, over: Parameters<typeof archiveBatch>[1]): Date {
  const [end] = archiveStampEnds({ observedAt, archiveBatches: [archiveBatch(BATCH, over)] });
  return new Date(end!.expiresAt);
}

/** The stamps the admin holds once the record lists `OTHER` alone, as read at `now`. */
const withoutIt = (now: number) => ({ batches: [archiveBatch(OTHER)], observedAt: new Date(now).toISOString() });

describe('a copy whose stamp the record lists no longer', () => {
  it('reads expired once the end its last listing gave it has passed', () => {
    const end = endFrom(OBSERVED_AT, { ttlSeconds: 86_400 });
    const later = Date.parse(OBSERVED_AT) + 2 * DAY;
    assert.equal(qualityState(copy(end), 5, withoutIt(later), later), 'expired');
  });

  it('reads unlisted while that end is still ahead', () => {
    const end = endFrom(OBSERVED_AT, { ttlSeconds: 86_400 });
    const sooner = Date.parse(OBSERVED_AT) + DAY / 2;
    assert.equal(qualityState(copy(end), 5, withoutIt(sooner), sooner), 'unlisted');
  });

  it('reads unlisted when no record ever listed it, so no end is known', () => {
    const later = Date.parse(OBSERVED_AT) + 400 * DAY;
    assert.equal(qualityState(copy(null), 5, withoutIt(later), later), 'unlisted');
  });

  it('keeps reading the record while the record lists it, whatever end is stored', () => {
    const later = Date.parse(OBSERVED_AT) + 2 * DAY;
    const listed = { batches: [archiveBatch(BATCH)], observedAt: new Date(later).toISOString() };
    assert.equal(qualityState(copy(new Date(OBSERVED_AT)), 5, listed, later), 'complete');
  });
});

describe('archiveStampEnds', () => {
  it('gives each listed stamp its observedAt plus its time to live, or its observedAt once it ran out', () => {
    const ends = archiveStampEnds({
      observedAt: OBSERVED_AT,
      archiveBatches: [
        archiveBatch(BATCH, { ttlSeconds: 3_600 }),
        archiveBatch(OTHER, { state: 'expired', ttlSeconds: 0 }),
        archiveBatch('c'.repeat(64), { state: 'gone', ttlSeconds: null }),
      ],
    });
    assert.deepEqual(ends, [
      { batchId: BATCH, expiresAt: '2026-11-17T15:18:01.000Z' },
      { batchId: OTHER, expiresAt: OBSERVED_AT },
      { batchId: 'c'.repeat(64), expiresAt: OBSERVED_AT },
    ]);
  });

  it('follows a later reading: later after a top-up, sooner after a dilution', () => {
    const first = endFrom(OBSERVED_AT, { ttlSeconds: 10 * 86_400 });
    const afterTopUp = endFrom('2026-11-18T14:18:01.000Z', { ttlSeconds: 30 * 86_400 });
    const afterDilution = endFrom('2026-11-19T14:18:01.000Z', { ttlSeconds: 2 * 86_400 });
    assert.equal(first.toISOString(), '2026-11-27T14:18:01.000Z');
    assert.equal(afterTopUp.toISOString(), '2026-12-18T14:18:01.000Z');
    assert.equal(afterDilution.toISOString(), '2026-11-21T14:18:01.000Z');
  });

  it('leaves out a stamp whose time to live the manager could not read, and a record with no archive stamps', () => {
    const unread = archiveBatch(BATCH, { state: 'unknown', ttlSeconds: null });
    assert.deepEqual(archiveStampEnds({ observedAt: OBSERVED_AT, archiveBatches: [unread] }), []);
    assert.deepEqual(archiveStampEnds({ observedAt: OBSERVED_AT }), []);
  });
});

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
