import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { MAX_PARALLEL_READS } from '../../src/components/SwarmHlsPlayer/following/feedReader';
import { findNewestFromHint } from '../../src/components/SwarmHlsPlayer/following/findNewestFromHint';
import { findNewestFromScratch } from '../../src/components/SwarmHlsPlayer/following/findNewestFromScratch';

import { VirtualTime } from '../feedModel/virtualTime';

import { TimedFeed } from './timedFeed';

const SEGMENT_MS = 2_000;
const LAG_MS = 800;

/**
 * A live feed whose head is `head` at true time `nowMs`, publishing one index per segment of
 * `segmentMs`, read by a viewer whose clock is `clockOffsetMs` off.
 */
function liveFeed(time: VirtualTime, head: number, nowMs: number, segmentMs = SEGMENT_MS) {
  const segmentEndMs = (index: number) => nowMs - LAG_MS - 500 - (head - index) * segmentMs;
  return new TimedFeed(time, {
    segmentEndMs,
    segmentMs,
    readableAtMs: (index) => (index < 0 ? Infinity : segmentEndMs(index) + LAG_MS),
    roundTripMs: 650,
  });
}

const HEADS = [-1, 0, 1, 2, 7, 8, 9, 300, 1_023, 1_024, 3_000, 18_000, 60_000];
const CLOCK_OFFSETS = [0, 3_000, -3_000, 60_000, -60_000];

describe('finding the newest index from nothing', () => {
  for (const head of HEADS) {
    for (const offset of CLOCK_OFFSETS) {
      it(`pins head ${head} with the viewer's clock ${offset} ms off, eight reads at a time at most`, async () => {
        const time = new VirtualTime();
        const nowMs = 100_000_000;
        await time.runUntil(nowMs);
        const feed = liveFeed(time, head, nowMs);
        const result = await time.runToCompletion(findNewestFromScratch(feed, time.clock(offset)));

        assert.ok(feed.maxInFlight <= MAX_PARALLEL_READS, `${feed.maxInFlight} reads at once`);
        const newestAtEnd = feed.newestAt(time.trueNowMs);
        const found = result.newest?.index ?? -1;
        // The bounds contain the true newest index: what was found is readable and no older than the
        // head when the search began, and the slot above it was read and missing.
        assert.ok(found >= head && found <= newestAtEnd, `found ${found}, head ${head} to ${newestAtEnd}`);
        assert.equal(result.firstMissing, found + 1);
        assert.ok((feed.earlyAsks.get(found + 1) ?? 0) >= 1 || feed.newestAt(time.trueNowMs) > found);
      });
    }
  }
});

describe('finding the newest index from another quality as a hint', () => {
  const DIVERGENCES = [0, 1, -1, 4, -4, 5, -5, 50, -50, 500, -500];
  for (const divergence of DIVERGENCES) {
    it(`pins a quality ${divergence} indexes from the playing one, eight reads at a time at most`, async () => {
      const time = new VirtualTime();
      const nowMs = 100_000_000;
      await time.runUntil(nowMs);
      const playingHead = 3_000;
      const head = playingHead + divergence;
      const feed = liveFeed(time, head, nowMs);
      const hint = {
        index: playingHead,
        newestSegmentEndMs: nowMs - LAG_MS - 500,
        segmentMs: SEGMENT_MS,
        seenAtMs: nowMs,
      };
      const result = await time.runToCompletion(findNewestFromHint(feed, time.clock(60_000), hint));

      assert.ok(feed.maxInFlight <= MAX_PARALLEL_READS, `${feed.maxInFlight} reads at once`);
      const found = result.newest?.index ?? -1;
      assert.ok(found >= head && found <= feed.newestAt(time.trueNowMs), `found ${found} for head ${head}`);
      assert.equal(result.firstMissing, found + 1);
    });
  }

  it('falls back to the search from nothing when every read around the hint misses', async () => {
    const time = new VirtualTime();
    const nowMs = 100_000_000;
    await time.runUntil(nowMs);
    // This quality is 1,800 slots behind the playing one, further than the round below the hint reaches.
    const feed = liveFeed(time, 1_200, nowMs);
    const hint = { index: 3_000, newestSegmentEndMs: nowMs - LAG_MS - 500, segmentMs: SEGMENT_MS, seenAtMs: nowMs };
    const result = await time.runToCompletion(findNewestFromHint(feed, time.clock(), hint));

    assert.equal(result.usedFallback, true);
    // The head moves on while the search runs, so the answer is the head at the start or a newer one.
    const found = result.newest?.index ?? -1;
    assert.ok(found >= 1_200 && found <= feed.newestAt(time.trueNowMs), `found ${found}`);
    assert.equal(result.firstMissing, found + 1);
    assert.ok(feed.maxInFlight <= MAX_PARALLEL_READS);
  });

  it('does not fall back when the hint brackets the head', async () => {
    const time = new VirtualTime();
    const nowMs = 100_000_000;
    await time.runUntil(nowMs);
    const feed = liveFeed(time, 3_002, nowMs);
    const hint = { index: 3_000, newestSegmentEndMs: nowMs - LAG_MS - 500, segmentMs: SEGMENT_MS, seenAtMs: nowMs };
    const result = await time.runToCompletion(findNewestFromHint(feed, time.clock(), hint));

    assert.equal(result.usedFallback, false);
    assert.equal(result.newest?.index, 3_002);
    assert.equal(result.rounds, 1);
  });

  /**
   * A hint seen five seconds ago is ten half-second segments behind. Moved on by an assumed two
   * seconds it was moved two, and the round around it missed the head.
   */
  it('moves the hint on by the segment length the playing quality names, so one round pins the head', async () => {
    const time = new VirtualTime();
    const seenAtMs = 100_000_000;
    await time.runUntil(seenAtMs + 5_000);
    const feed = liveFeed(time, 3_010, seenAtMs + 5_000, 500);
    const hint = { index: 3_000, newestSegmentEndMs: seenAtMs - LAG_MS - 500, segmentMs: 500, seenAtMs };
    const result = await time.runToCompletion(findNewestFromHint(feed, time.clock(), hint));

    assert.equal(result.usedFallback, false);
    assert.ok((result.newest?.index ?? -1) >= 3_010, `found ${result.newest?.index}`);
    assert.equal(result.rounds, 1);
  });

  /**
   * A hint read off a time marker names no length, since a marker carries no playlist. The search
   * still pins the head, moving the hint on by the length of the first slot it reads.
   */
  it('pins the head from a hint that names no segment length', async () => {
    const time = new VirtualTime();
    const seenAtMs = 100_000_000;
    await time.runUntil(seenAtMs + 5_000);
    const feed = liveFeed(time, 3_010, seenAtMs + 5_000, 500);
    const hint = { index: 3_000, newestSegmentEndMs: seenAtMs - LAG_MS - 500, segmentMs: null, seenAtMs };
    const result = await time.runToCompletion(findNewestFromHint(feed, time.clock(), hint));

    const found = result.newest?.index ?? -1;
    assert.ok(found >= 3_010 && found <= feed.newestAt(time.trueNowMs), `found ${found}`);
    assert.equal(result.firstMissing, found + 1);
  });
});

describe('finding the newest index of half-second segments from nothing', () => {
  /**
   * The bound on the head is the time since the newest slot found, in segments. Counted in an
   * assumed two seconds it fell four times short, and the guess round read around the wrong place.
   */
  it('takes no more rounds than it takes on two-second segments', async () => {
    const rounds = async (segmentMs: number) => {
      const time = new VirtualTime();
      const nowMs = 100_000_000;
      await time.runUntil(nowMs);
      const feed = liveFeed(time, 3_000, nowMs, segmentMs);
      return (await time.runToCompletion(findNewestFromScratch(feed, time.clock()))).rounds;
    };

    assert.ok(
      (await rounds(500)) <= (await rounds(SEGMENT_MS)),
      `${await rounds(500)} rounds against ${await rounds(SEGMENT_MS)}`,
    );
  });
});
