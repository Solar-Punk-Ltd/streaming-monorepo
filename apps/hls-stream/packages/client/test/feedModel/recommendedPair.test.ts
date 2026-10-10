import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { followPredicted } from '../../src/components/SwarmHlsPlayer/following/followPredicted';

import { NO_PENALTY } from './beeNode';
import { followImmediately } from './followImmediately';
import { PROFILE_A, PROFILE_B } from './profiles';
import { FindScenario, FollowScenario, runFind, runFollow } from './runs';
import { summariseFind, summariseFollow } from './summaries';

/**
 * The recommended pair, the predicted follower and the searches by index, held to the numbers the
 * polling study measured for them, over fixed seeds, so a change that makes them worse fails here.
 * The bounds sit about fifteen percent outside what these seeds give today. The study itself, with
 * its full grid, is `study.test.ts`.
 */
const SEEDS = Array.from({ length: 12 }, (_, seed) => seed + 1);

const FOLLOW: FollowScenario = {
  profile: PROFILE_A,
  coalescing: 0.1,
  clockOffsetMs: 0,
  penalty: NO_PENALTY,
  pause: null,
  durationMs: 600_000,
  start: 'pinned',
};

const FIND: FindScenario = {
  profile: PROFILE_A,
  length: 18_000,
  divergence: 0,
  coalescing: 0.1,
  clockOffsetMs: 0,
  penalty: NO_PENALTY,
};

async function followSummary(scenario: FollowScenario, predicted = true) {
  const outcomes = [];
  for (const seed of SEEDS) {
    outcomes.push(
      await runFollow(seed, scenario, (context) => (predicted ? followPredicted(context) : followImmediately(context))),
    );
  }
  return summariseFollow(outcomes);
}

async function findSummary(scenario: FindScenario, finder: 'scratch' | 'hint') {
  const outcomes = [];
  for (const seed of SEEDS) {
    outcomes.push(await runFind(seed, scenario, finder));
  }
  return summariseFind(outcomes);
}

describe('the predicted follower, against the study', () => {
  it('asks about forty times a minute, early about once in two slots, and finds a slot within three seconds', async () => {
    const s = await followSummary(FOLLOW);
    assert.ok(s.requestsPerMinute <= 45, `${s.requestsPerMinute.toFixed(1)} requests a minute`);
    assert.ok(s.earlyAsksPerIndex <= 0.52, `${s.earlyAsksPerIndex.toFixed(2)} early asks per index`);
    assert.ok(s.readableToFound.p90 <= 2_100, `readable to found p90 ${s.readableToFound.p90} ms`);
    assert.ok(s.readableToFound.p99 <= 3_500, `readable to found p99 ${s.readableToFound.p99} ms`);
  });

  it('costs at least a third fewer requests than today, and early asks less than half as often', async () => {
    const predicted = await followSummary(FOLLOW);
    const today = await followSummary(FOLLOW, false);
    assert.ok(predicted.requestsPerMinute <= today.requestsPerMinute * (2 / 3));
    assert.ok(predicted.earlyAsksPerIndex <= today.earlyAsksPerIndex / 2);
    assert.ok(predicted.readableToFound.p90 <= today.readableToFound.p90);
  });

  it('on the slower node too', async () => {
    const s = await followSummary({ ...FOLLOW, profile: PROFILE_B });
    assert.ok(s.requestsPerMinute <= 44, `${s.requestsPerMinute.toFixed(1)} requests a minute`);
    assert.ok(s.readableToFound.p99 <= 4_700, `readable to found p99 ${s.readableToFound.p99} ms`);
  });

  it('does not lose a slot for a minute when four early asks are enough to make the node skip it', async () => {
    const s = await followSummary({ ...FOLLOW, penalty: { asks: 4, from: 'first' } });
    assert.ok(s.readableToFound.p99 <= 3_500, `readable to found p99 ${s.readableToFound.p99} ms`);
    assert.ok(s.longestGap.max <= 15_000, `longest wait ${s.longestGap.max} ms`);
  });

  it('picks a broadcast back up within about two seconds of a twenty second break', async () => {
    const s = await followSummary({ ...FOLLOW, pause: { afterMs: 300_000, lengthMs: 20_000 } });
    assert.ok(s.resumeDelay !== null && s.resumeDelay.p50 <= 2_200, `resume p50 ${s.resumeDelay?.p50} ms`);
    assert.ok(s.resumeDelay.max <= 4_800, `resume worst ${s.resumeDelay.max} ms`);
  });
});

describe('the searches by index, against the study', () => {
  it('finds the head of a ten hour feed in about forty reads and eight seconds', async () => {
    const s = await findSummary(FIND, 'scratch');
    assert.equal(s.correct, 1);
    assert.ok(s.reads.p90 <= 52, `reads p90 ${s.reads.p90}`);
    assert.ok(s.timeMs.p50 <= 8_400, `time p50 ${s.timeMs.p50} ms`);
  });

  it('finds a quality a few slots from the playing one in two rounds, either side', async () => {
    for (const divergence of [5, -5]) {
      const s = await findSummary({ ...FIND, divergence }, 'hint');
      assert.equal(s.correct, 1);
      assert.equal(s.fallbacks, 0);
      assert.ok(s.rounds.p90 <= 2, `divergence ${divergence}: rounds p90 ${s.rounds.p90}`);
    }
  });

  it('finds a quality fifty slots behind without the search from nothing', async () => {
    const s = await findSummary({ ...FIND, divergence: -50 }, 'hint');
    assert.equal(s.correct, 1);
    assert.equal(s.fallbacks, 0);
    assert.ok(s.rounds.p90 <= 4, `rounds p90 ${s.rounds.p90}`);
  });
});
