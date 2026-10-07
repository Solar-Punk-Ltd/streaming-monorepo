import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { FeedEntry, FollowContext } from '../../src/components/SwarmHlsPlayer/following/feedReader';
import { followPredicted } from '../../src/components/SwarmHlsPlayer/following/followPredicted';

import { followAfterSegment } from '../feedModel/followAfterSegment';
import { followImmediately } from '../feedModel/followImmediately';
import { VirtualTime } from '../feedModel/virtualTime';

import { steadyFeed, TimedFeed } from './timedFeed';

type Follower = (context: FollowContext) => Promise<void>;

const FOLLOWERS: ReadonlyArray<readonly [string, Follower]> = [
  ['today', (context) => followImmediately(context)],
  ['after a segment', (context) => followAfterSegment(context)],
  ['predicted', (context) => followPredicted(context)],
];

/** Follow `feed` from its newest index at `startMs` for `forMs`, and hand back what was delivered. */
async function follow(time: VirtualTime, feed: TimedFeed, follower: Follower, startMs: number, forMs: number) {
  await time.runUntil(startMs);
  const newest = feed.newestAt(startMs);
  const delivered: FeedEntry[] = [];
  let stopped = false;
  const from = { index: newest, newestSegmentEndMs: newest * 2_000 };
  void follower({
    reader: feed,
    clock: time.clock(),
    from,
    onEntry: (entry) => delivered.push(entry),
    isStopped: () => stopped,
  });
  await time.runUntil(startMs + forMs);
  stopped = true;
  return { from, delivered };
}

describe('every follower', () => {
  for (const [name, follower] of FOLLOWERS) {
    it(`${name}: delivers each new index once, in order, and never asks for one it has found`, async () => {
      const time = new VirtualTime();
      const feed = steadyFeed(time, { lagMs: 700, roundTripMs: 600 });
      const { from, delivered } = await follow(time, feed, follower, 61_000, 120_000);

      assert.ok(delivered.length >= 55, `only ${delivered.length} indexes in two minutes`);
      delivered.forEach((entry, position) => assert.equal(entry.index, from.index + 1 + position));
      for (const entry of delivered) {
        // Exactly one ask answered it, and every other ask for it came before, while it was absent.
        assert.equal(feed.asks.get(entry.index), (feed.earlyAsks.get(entry.index) ?? 0) + 1, `index ${entry.index}`);
      }
    });
  }
});

describe('the predicted follower', () => {
  it('asks a slot early at most once in steady state', async () => {
    const time = new VirtualTime();
    const feed = steadyFeed(time, { lagMs: 900, roundTripMs: 650 });
    const { delivered } = await follow(time, feed, (context) => followPredicted(context), 61_000, 300_000);

    const steady = delivered.slice(30);
    assert.ok(steady.length > 100);
    for (const entry of steady) {
      assert.ok(
        (feed.earlyAsks.get(entry.index) ?? 0) <= 1,
        `index ${entry.index} was asked early ${feed.earlyAsks.get(entry.index)} times`,
      );
    }
  });

  it('finds each index within one segment of it becoming readable in steady state', async () => {
    const time = new VirtualTime();
    const feed = steadyFeed(time, { lagMs: 900, roundTripMs: 650 });
    const found = new Map<number, number>();
    await time.runUntil(61_000);
    let stopped = false;
    const newest = feed.newestAt(61_000);
    void followPredicted({
      reader: feed,
      clock: time.clock(),
      from: { index: newest, newestSegmentEndMs: newest * 2_000 },
      onEntry: (entry) => found.set(entry.index, time.trueNowMs),
      isStopped: () => stopped,
    });
    await time.runUntil(361_000);
    stopped = true;
    const waits = [...found].slice(30).map(([index, at]) => at - (index * 2_000 + 900));
    assert.ok(Math.max(...waits) < 2_000, `waited up to ${Math.max(...waits)} ms`);
  });

  it('spends at most its early-ask budget on a slot that does not come, then backs off', async () => {
    const time = new VirtualTime();
    // The publisher stops after index 40, so 41 is asked for and never there.
    const feed = steadyFeed(time, { lagMs: 900, roundTripMs: 650, stopsAfter: 40 });
    await follow(time, feed, (context) => followPredicted(context), 31_000, 120_000);

    const times = feed.askTimes.get(41) ?? [];
    const afterBudget = times.slice(3);
    assert.ok(afterBudget.length > 0, 'the slot was given up on rather than backed off');
    const gaps = afterBudget.map((at, position) => at - times[position + 2]);
    // A segment at first, doubling to four seconds: about thirty asks in two minutes, where today's
    // cadence makes about eighty.
    gaps.forEach((gap, position) => assert.ok(gap >= 2_000, `ask ${position + 4} came ${gap} ms after the one before`));
    assert.ok(
      gaps.slice(2).every((gap) => gap >= 4_000),
      `gaps ${gaps.join(', ')}`,
    );
    assert.ok(times.length <= 35, `${times.length} asks in two minutes`);
  });
});
