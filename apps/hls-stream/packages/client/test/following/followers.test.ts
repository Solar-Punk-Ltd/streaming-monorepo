import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { FeedEntry, FollowContext } from '../../src/components/SwarmHlsPlayer/following/feedReader';
import { followPredicted } from '../../src/components/SwarmHlsPlayer/following/followPredicted';
import { MARKER_READ_DELAY_MS, PeriodMarkers } from '../../src/components/SwarmHlsPlayer/following/headMarkers';
import { MARKER_PERIOD_SECONDS, markerPeriodStartMs } from '@swarm-hls-stream/shared';

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
  const from = { index: newest, newestSegmentEndMs: newest * 2_000, segmentMs: 2_000 };
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
      from: { index: newest, newestSegmentEndMs: newest * 2_000, segmentMs: 2_000 },
      onEntry: (entry) => found.set(entry.index, time.trueNowMs),
      isStopped: () => stopped,
    });
    await time.runUntil(361_000);
    stopped = true;
    const waits = [...found].slice(30).map(([index, at]) => at - (index * 2_000 + 900));
    assert.ok(Math.max(...waits) < 2_000, `waited up to ${Math.max(...waits)} ms`);
  });

  /**
   * The stage's own setting decides the segment length, and a stage created outside the manager's
   * wizard cuts half-second segments. A follower that assumed two seconds asked each slot two seconds
   * after the last and fell further behind with every one. The round trip is under one segment, since
   * the follower asks one slot at a time and a longer one could not keep this pace whatever it knew.
   */
  it('follows half-second segments at their own pace, by the length the playlists name', async () => {
    const time = new VirtualTime();
    const feed = steadyFeed(time, { lagMs: 900, roundTripMs: 300, segmentMs: 500 });
    const found = new Map<number, number>();
    await time.runUntil(61_000);
    let stopped = false;
    const newest = feed.newestAt(61_000);
    void followPredicted({
      reader: feed,
      clock: time.clock(),
      from: { index: newest, newestSegmentEndMs: newest * 500, segmentMs: 500 },
      onEntry: (entry) => found.set(entry.index, time.trueNowMs),
      isStopped: () => stopped,
    });
    await time.runUntil(181_000);
    stopped = true;

    const waits = [...found].slice(60).map(([index, at]) => at - (index * 500 + 900));
    assert.ok(waits.length > 100, `only ${found.size} slots found in two minutes of half-second segments`);
    assert.ok(Math.max(...waits) < 1_000, `waited up to ${Math.max(...waits)} ms`);
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

/** When the uploader writes a period's marker, and how long until another node serves it. */
const MARKER_WRITE_DELAY_MS = 250;
const MARKER_SERVED_AFTER_MS = 1_500;

describe('the predicted follower through an outage', () => {
  // The publisher stops after index 40, whose slot is readable at 80.9 s, and comes back at 100.5 s,
  // twenty seconds late. The node gives up on an address after three early asks, for a minute.
  const LAST_BEFORE = 40;
  const BACK_AT_MS = 100_500;
  const LAG_MS = 900;
  const readableAtMs = (index: number) =>
    index <= LAST_BEFORE ? index * 2_000 + LAG_MS : BACK_AT_MS + (index - LAST_BEFORE - 1) * 2_000;

  function outageFeed(time: VirtualTime): TimedFeed {
    return new TimedFeed(time, {
      readableAtMs,
      segmentEndMs: (index) => readableAtMs(index) - LAG_MS,
      segmentMs: 2_000,
      roundTripMs: 650,
      skipList: { peers: 3, skipMs: 60_000 },
    });
  }

  /** The uploader's markers, which it keeps writing through the outage, each naming the newest index at its write. */
  function markersOf(time: VirtualTime, feed: TimedFeed, reads: Map<number, number>): PeriodMarkers {
    return new PeriodMarkers(
      time.clock(),
      () => 0,
      async (period) => {
        reads.set(period, (reads.get(period) ?? 0) + 1);
        const askedAtMs = time.trueNowMs;
        await time.delay(650);
        const writtenAtMs = markerPeriodStartMs(period) + MARKER_WRITE_DELAY_MS;
        return askedAtMs < writtenAtMs + MARKER_SERVED_AFTER_MS ? null : feed.newestAt(writtenAtMs);
      },
    );
  }

  it('is back within about one marker period of the publisher, where asking the next slot costs a minute', async () => {
    const time = new VirtualTime();
    const feed = outageFeed(time);
    const markerReads = new Map<number, number>();
    await time.runUntil(61_000);
    const newest = feed.newestAt(61_000);
    const found: { index: number; atMs: number }[] = [];
    let stopped = false;
    void followPredicted({
      reader: feed,
      clock: time.clock(),
      from: { index: newest, newestSegmentEndMs: readableAtMs(newest) - LAG_MS, segmentMs: 2_000 },
      onEntry: (entry) => found.push({ index: entry.index, atMs: time.trueNowMs }),
      isStopped: () => stopped,
      markers: markersOf(time, feed, markerReads),
    });
    await time.runUntil(200_000);
    stopped = true;

    const back = found.find((entry) => entry.index > LAST_BEFORE);
    assert.ok(back, 'never found a slot after the outage');
    const waitedMs = back.atMs - BACK_AT_MS;
    assert.ok(
      waitedMs <= MARKER_PERIOD_SECONDS * 1_000 + MARKER_READ_DELAY_MS + 2_000,
      `back ${waitedMs} ms after the publisher, at index ${back.index}`,
    );
    for (const index of [LAST_BEFORE + 1, LAST_BEFORE + 2]) {
      assert.ok(
        (feed.earlyAsks.get(index) ?? 0) <= 5,
        `index ${index} was asked early ${feed.earlyAsks.get(index)} times`,
      );
    }
    for (const [period, reads] of markerReads) {
      assert.equal(reads, 1, `the marker of period ${period} was read ${reads} times`);
    }
    const after = found.filter((entry) => entry.index > back.index);
    assert.ok(after.length >= 30, `only ${after.length} slots followed after the outage`);
  });
});
