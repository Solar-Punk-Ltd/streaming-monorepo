import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FundingBatch, FundingPostage } from './funding.js';
import {
  DILUTE_MAX_STEPS,
  DILUTE_MIN_SECONDS_AFTER,
  operableBatch,
  SECONDS_PER_DAY,
  stampDiluteQuote,
  stampTopUpQuote,
} from './stampQuote.js';

/** Gnosis Chain's block time and postage floor, at a price of 24000 PLUR per chunk per block. */
const POSTAGE: FundingPostage = { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 };

const BATCH: FundingBatch = {
  batchId: `0x${'ab'.repeat(32)}`,
  depth: 20,
  immutable: false,
  usable: true,
  ttlSeconds: 30 * SECONDS_PER_DAY,
  fillRatio: 0.25,
  readError: null,
};

describe('a top-up, quoted', () => {
  it('pays for every block of the days, per chunk, for each of the 2^depth chunks', () => {
    const quote = stampTopUpQuote(1, 20, 3600, POSTAGE);
    assert.equal(quote.amountPerChunkPlur, (17280n * 24000n).toString());
    assert.equal(quote.costPlur, (17280n * 24000n * 2n ** 20n).toString());
    assert.equal(quote.ttlAfterSeconds, 3600 + SECONDS_PER_DAY);
  });

  it('rounds the blocks up, so the days are never short', () => {
    const quote = stampTopUpQuote(1, 17, 0, { ...POSTAGE, blockSeconds: 7 });
    assert.equal(quote.amountPerChunkPlur, (12343n * 24000n).toString());
  });

  it('takes any whole number of days, with no cap, and keeps every digit', () => {
    const quote = stampTopUpQuote(10_000, 41, 0, POSTAGE);
    assert.equal(quote.costPlur, (172_800_000n * 24000n * 2n ** 41n).toString());
  });

  it('throws for days that are not a whole number of 1 or more', () => {
    for (const days of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => stampTopUpQuote(days, 20, 0, POSTAGE), RangeError, String(days));
    }
  });
});

describe('a dilution, quoted', () => {
  it('raises the depth and halves the time left for each step', () => {
    assert.deepEqual(stampDiluteQuote(1, 20, 30 * SECONDS_PER_DAY), {
      newDepth: 21,
      ttlAfterSeconds: 15 * SECONDS_PER_DAY,
      problem: null,
    });
    assert.deepEqual(stampDiluteQuote(2, 20, 40 * SECONDS_PER_DAY), {
      newDepth: 22,
      ttlAfterSeconds: 10 * SECONDS_PER_DAY,
      problem: null,
    });
  });

  it('is refused when the time left after it would be under 7 days, and allowed at exactly 7', () => {
    assert.equal(stampDiluteQuote(2, 20, 10 * SECONDS_PER_DAY).problem, 'It would leave the batch under 7 days.');
    assert.equal(stampDiluteQuote(1, 20, 2 * DILUTE_MIN_SECONDS_AFTER).problem, null);
    assert.equal(
      stampDiluteQuote(1, 20, 2 * DILUTE_MIN_SECONDS_AFTER - 2).problem,
      'It would leave the batch under 7 days.',
    );
  });

  it('is refused for other than 1 or 2 steps', () => {
    for (const steps of [0, DILUTE_MAX_STEPS + 1, 1.5, -1]) {
      assert.equal(
        stampDiluteQuote(steps, 20, 365 * SECONDS_PER_DAY).problem,
        'A dilution takes 1 or 2 steps.',
        String(steps),
      );
    }
  });
});

describe('a batch a stamp operation may be sent for', () => {
  it('is one read whole, usable and not expired', () => {
    assert.equal(operableBatch(BATCH), true);
  });

  it('is never one the node could not be read about, an unusable one, an expired one, or none', () => {
    const unread: FundingBatch = {
      ...BATCH,
      depth: null,
      immutable: null,
      usable: null,
      ttlSeconds: null,
      fillRatio: null,
      readError: 'The node did not answer.',
    };
    for (const [tag, batch] of [
      ['unread', unread],
      ['read error', { ...BATCH, readError: 'The batch is not on the node.' }],
      ['no depth', { ...BATCH, depth: null }],
      ['no time read', { ...BATCH, ttlSeconds: null }],
      ['expired', { ...BATCH, ttlSeconds: 0 }],
      ['not usable', { ...BATCH, usable: false }],
      ['null', null],
      ['undefined', undefined],
    ] as const) {
      assert.equal(operableBatch(batch), false, tag);
    }
  });
});
