/**
 * How old a batch reading is by the admin's clock. Unit test: the rule on its own, then beside the catalogue's
 * refusal. `pnpm test`.
 *
 * Pinned here: the time left is the time to live less the time since the manager read it, never below 0 and never
 * more than the node said; a time to live the node did not give, or gave as negative, stays unknown; and a reading is
 * expired by the clock at exactly the moments the catalogue's refusal says `expired` of an active batch, so what the
 * console shows cannot drift from what the admin refuses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { refusalFor } from '../../src/domain/CatalogueBatch.js';
import { stampAge } from '../../src/domain/stampAge.js';

import { catalogueStampRecord } from './support/stageFakes.js';

const DAY = 86_400;
const READ_AT = '2026-09-28T10:00:00.000Z';
const read = Date.parse(READ_AT);

describe('stampAge', () => {
  it('takes the time since the manager read it off the time to live, and stops at 0', () => {
    const reading = { ttlSeconds: 2 * DAY, observedAt: READ_AT };
    assert.deepEqual(stampAge(reading, read), { remainingSeconds: 2 * DAY, expiredByClock: false });
    assert.deepEqual(stampAge(reading, read + (DAY + 3600) * 1000), {
      remainingSeconds: DAY - 3600,
      expiredByClock: false,
    });
    assert.deepEqual(stampAge(reading, read + 3 * DAY * 1000), { remainingSeconds: 0, expiredByClock: true });
  });

  it('counts the time to live as run out only once it has passed', () => {
    const reading = { ttlSeconds: 3600, observedAt: READ_AT };
    assert.deepEqual(stampAge(reading, read + 3_599_500), { remainingSeconds: 1, expiredByClock: false });
    assert.deepEqual(stampAge(reading, read + 3_600_000), { remainingSeconds: 0, expiredByClock: false });
    assert.deepEqual(stampAge(reading, read + 3_600_001), { remainingSeconds: 0, expiredByClock: true });
  });

  it('leaves a time to live the node did not give, or could not tell, unknown, and a 0 at 0', () => {
    const later = read + 3 * DAY * 1000;
    assert.deepEqual(stampAge({ ttlSeconds: null, observedAt: READ_AT }, later), {
      remainingSeconds: null,
      expiredByClock: false,
    });
    assert.deepEqual(stampAge({ ttlSeconds: -1, observedAt: READ_AT }, later), {
      remainingSeconds: null,
      expiredByClock: false,
    });
    assert.deepEqual(stampAge({ ttlSeconds: 0, observedAt: READ_AT }, later), {
      remainingSeconds: 0,
      expiredByClock: false,
    });
  });

  it('gives a reading from a moment the admin’s clock has not reached no more than the node said', () => {
    assert.deepEqual(stampAge({ ttlSeconds: 3600, observedAt: READ_AT }, read - 5000), {
      remainingSeconds: 3600,
      expiredByClock: false,
    });
  });

  it('says expired by the clock exactly when the catalogue refuses an active batch as expired', () => {
    const record = catalogueStampRecord({ ttlSeconds: 2 * DAY, observedAt: READ_AT, state: 'active' });
    for (const seconds of [0, DAY, 2 * DAY - 1, 2 * DAY, 2 * DAY + 1, 3 * DAY]) {
      const now = read + seconds * 1000;
      assert.equal(
        stampAge(record, now).expiredByClock,
        refusalFor(record, now) === 'expired',
        `${seconds} s after the reading`,
      );
    }
  });
});
