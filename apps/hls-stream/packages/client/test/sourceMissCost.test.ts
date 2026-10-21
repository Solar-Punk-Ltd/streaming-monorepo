import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { SourceMissCost } from '../src/components/SwarmHlsPlayer/sourceMissCost';

function costOf(missesMs: readonly number[]): SourceMissCost {
  const cost = new SourceMissCost();
  for (const missMs of missesMs) {
    cost.record(missMs);
  }
  return cost;
}

describe('what makes a source slow', () => {
  it('is not one slow first miss among fast ones, as a cold connection gives', () => {
    for (let fast = 1; fast <= 6; fast++) {
      const cost = costOf([4_000, ...Array.from({ length: fast }, () => 1_400)]);

      assert.equal(cost.isSlow(), false, `slow after one 4 s miss and ${fast} fast ones`);
      assert.equal(cost.readWindowMs(), null);
    }
  });

  it('is not a single slow miss, which is all a cold start has shown', () => {
    assert.equal(costOf([4_000]).isSlow(), false);
  });

  it('is two misses both slow, as the light node had answered when its first 20 s ran out', () => {
    assert.equal(costOf([5_700, 5_800]).isSlow(), true);
  });

  it('is the light node, whose misses take 6 to 7 s', () => {
    assert.equal(costOf([6_200, 7_100, 5_800, 6_900, 6_400, 7_000]).isSlow(), true);
  });

  it('ends once its latest misses are fast again', () => {
    const cost = costOf([6_000, 6_000, 6_000, 6_000, 6_000]);
    assert.equal(cost.isSlow(), true);

    for (let fast = 0; fast < 16; fast++) {
      cost.record(1_400);
    }

    assert.equal(cost.isSlow(), false);
    assert.equal(cost.readWindowMs(), null);
  });
});

describe('what a slow source is allowed', () => {
  it('is judged by the median of its latest misses, not by its slowest', () => {
    const cost = costOf([6_000, 6_000, 6_000, 6_000, 40_000]);

    assert.equal(cost.typicalMs(), 6_000);
    assert.equal(cost.roundMs(), 9_000);
  });

  it('gives a read two rounds, a round being one and a half typical misses', () => {
    assert.equal(costOf([7_000, 7_000, 7_000, 7_000, 7_000]).readWindowMs(), 21_000);
  });

  it('caps a round at 15 s and a read at 30 s, however slow its misses', () => {
    const cost = costOf([20_000, 20_000, 20_000, 20_000, 20_000]);

    assert.equal(cost.roundMs(), 15_000);
    assert.equal(cost.readWindowMs(), 30_000);
  });

  it('never gives a read less than the usual 10 s', () => {
    assert.equal(costOf([3_100, 3_100, 3_100, 3_100, 3_100]).readWindowMs(), 10_000);
  });
});
