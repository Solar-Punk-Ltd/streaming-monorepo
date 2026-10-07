import type { FeedEntry, FollowContext } from '../../src/components/SwarmHlsPlayer/following/feedReader';
import { findNewestFromHint } from '../../src/components/SwarmHlsPlayer/following/findNewestFromHint';
import { findNewestFromScratch } from '../../src/components/SwarmHlsPlayer/following/findNewestFromScratch';

import { EarlyAskPenalty, SimNode } from './beeNode';
import { Delivery, playBehind } from './player';
import type { NodeProfile } from './profiles';
import { historyPauses, Pause, QualityFeed } from './publisher';
import { Random } from './random';
import { VirtualTime } from './virtualTime';

/** The spread of a slot's readable lag from slot to slot, fitted to phase 0 (see the study report). */
export const CALIBRATED_JITTER_MS = 300;

export type Follower = (context: FollowContext) => Promise<void>;
export type Finder = 'bee' | 'scratch' | 'hint';

export interface FollowScenario {
  readonly profile: NodeProfile;
  readonly coalescing: number;
  readonly clockOffsetMs: number;
  readonly penalty: EarlyAskPenalty;
  /** A break in the broadcast this long after the viewer joins, or none. */
  readonly pause: { readonly afterMs: number; readonly lengthMs: number } | null;
  readonly durationMs: number;
  /** Start from the head as if just found, or find it first with this finder and follow from its answer. */
  readonly start: 'pinned' | 'scratch' | 'bee';
  readonly jitterMs?: number;
}

export interface FollowOutcome {
  readonly minutes: number;
  readonly reads: number;
  readonly earlyAsks: number;
  readonly delivered: number;
  /** Slots stepped over by a look past a refused slot. */
  readonly skipped: number;
  /** Per delivered slot, true time from readable to delivered. */
  readonly readableToFoundMs: number[];
  /** Gaps between consecutive deliveries, true time. */
  readonly deliveryGapsMs: number[];
  /** How many reads each delivered slot took, the follower's own. */
  readonly readsPerSlot: number[];
  /** Early asks on the slot right after the one the follower started from, finder's and follower's together. */
  readonly firstSlotEarlyAsks: number;
  /** From the first readable slot after a pause to its delivery, or null with no pause. */
  readonly resumeDelayMs: number | null;
  readonly stalls: number;
  readonly stalledMs: number;
}

function qualityFeed(random: Random, slots: number, coalescing: number, jitterMs: number, pauses: readonly Pause[]) {
  return new QualityFeed({
    random,
    slots,
    startMs: 0,
    coalescing,
    lagMs: random.uniform(400, 1_200),
    jitterMs,
    pdtOffsetMs: random.uniform(500, 2_000),
    pauses,
  });
}

/** One viewer following one quality for `durationMs`, from one seed. */
export async function runFollow(seed: number, scenario: FollowScenario, follower: Follower): Promise<FollowOutcome> {
  const random = new Random(seed);
  const time = new VirtualTime();
  const startSlot = 1_000;
  const slots = startSlot + Math.ceil(scenario.durationMs / 2_000) + 200;

  // The pause is placed by slot, so the feed is built once without it to find which slot that is.
  const feedRandomSeed = random.next() * 2 ** 32;
  const jitterMs = scenario.jitterMs ?? CALIBRATED_JITTER_MS;
  const probe = qualityFeed(new Random(feedRandomSeed), slots, scenario.coalescing, jitterMs, []);
  const joinMs = probe.readableAt(startSlot) + random.uniform(0, 2_000);
  const pauses: Pause[] =
    scenario.pause === null
      ? []
      : [{ afterSlot: probe.newestAt(joinMs + scenario.pause.afterMs), lengthMs: scenario.pause.lengthMs }];
  const feed =
    pauses.length === 0 ? probe : qualityFeed(new Random(feedRandomSeed), slots, scenario.coalescing, jitterMs, pauses);
  const node = new SimNode(time, feed, scenario.profile, random, scenario.penalty);

  await time.runUntil(joinMs);
  let from: FeedEntry;
  if (scenario.start === 'pinned') {
    from = feed.entry(feed.newestAt(joinMs));
  } else if (scenario.start === 'scratch') {
    const found = await time.runToCompletion(findNewestFromScratch(node, time.clock(scenario.clockOffsetMs)));
    from = found.newest!;
  } else {
    const found = await time.runToCompletion(node.lookup());
    from = found.newest!;
  }
  const followFromMs = time.trueNowMs;
  const readsBeforeFollowing = node.tally.reads;
  const earlyBeforeFollowing = node.tally.earlyAsks;
  const readsBySlotBefore = new Map(node.readsBySlot);

  const deliveries: Delivery[] = [];
  const delivered: FeedEntry[] = [];
  let stopped = false;
  void follower({
    reader: node,
    clock: time.clock(scenario.clockOffsetMs),
    from,
    onEntry: (entry) => {
      delivered.push(entry);
      deliveries.push({ atMs: time.trueNowMs, newestSegmentEndMs: entry.newestSegmentEndMs });
    },
    isStopped: () => stopped,
  });
  const endMs = followFromMs + scenario.durationMs;
  await time.runUntil(endMs);
  stopped = true;

  const readableToFoundMs = delivered.map(
    (entry, position) => deliveries[position].atMs - feed.readableAt(entry.index),
  );
  const deliveryGapsMs = deliveries.slice(1).map((delivery, position) => delivery.atMs - deliveries[position].atMs);
  let skipped = 0;
  let previous = from.index;
  for (const entry of delivered) {
    skipped += entry.index - previous - 1;
    previous = entry.index;
  }
  const readsPerSlot = delivered.map(
    (entry) => (node.readsBySlot.get(entry.index) ?? 0) - (readsBySlotBefore.get(entry.index) ?? 0),
  );
  let resumeDelayMs: number | null = null;
  if (pauses.length > 0) {
    const resumed = pauses[0].afterSlot + 1;
    const position = delivered.findIndex((entry) => entry.index >= resumed);
    resumeDelayMs =
      position === -1 ? endMs - feed.readableAt(resumed) : deliveries[position].atMs - feed.readableAt(resumed);
  }
  const played = playBehind(followFromMs, from.newestSegmentEndMs, deliveries, endMs);

  return {
    minutes: scenario.durationMs / 60_000,
    reads: node.tally.reads - readsBeforeFollowing,
    earlyAsks: node.tally.earlyAsks - earlyBeforeFollowing,
    delivered: delivered.length,
    skipped,
    readableToFoundMs,
    deliveryGapsMs,
    readsPerSlot,
    firstSlotEarlyAsks: node.earlyAsksBySlot.get(from.index + 1) ?? 0,
    resumeDelayMs,
    stalls: played.stalls,
    stalledMs: played.stalledMs,
  };
}

export interface FindScenario {
  readonly profile: NodeProfile;
  /** The target feed's newest index when the search starts. */
  readonly length: number;
  /** How far the playing quality's head is from the target's, used by the hint finder only. */
  readonly divergence: number;
  readonly coalescing: number;
  readonly clockOffsetMs: number;
  readonly penalty: EarlyAskPenalty;
}

export interface FindOutcome {
  readonly reads: number;
  readonly earlyAsks: number;
  readonly rounds: number;
  readonly timeMs: number;
  /** The answer was the head at the start of the search or newer, and readable. */
  readonly correct: boolean;
  /** Early asks the search left on the slot right after its answer, the one a follower asks next. */
  readonly nextSlotEarlyAsks: number;
  readonly usedFallback: boolean;
}

/** One search for the newest index of a feed `length` long, live, with days of history behind it. */
export async function runFind(seed: number, scenario: FindScenario, finder: Finder): Promise<FindOutcome> {
  const random = new Random(seed);
  const time = new VirtualTime();
  const liveSlots = 600;
  const slots = scenario.length + 400;
  const target = qualityFeed(
    random,
    slots,
    scenario.coalescing,
    CALIBRATED_JITTER_MS,
    historyPauses(random, slots, liveSlots),
  );
  const head = scenario.length;
  const nowMs = target.readableAt(head) + random.uniform(0, target.readableAt(head + 1) - target.readableAt(head));
  await time.runUntil(nowMs);
  const node = new SimNode(time, target, scenario.profile, random, scenario.penalty);
  const clock = time.clock(scenario.clockOffsetMs);

  let newest: FeedEntry | null;
  let rounds: number;
  let usedFallback = false;
  if (finder === 'bee') {
    const answer = await time.runToCompletion(node.lookup());
    // One request to the node around its search.
    await time.runToCompletion(
      time.delay(random.logNormal(scenario.profile.foundMs.median, scenario.profile.foundMs.sigma)),
    );
    newest = answer.newest;
    rounds = answer.rounds;
  } else if (finder === 'scratch') {
    const answer = await time.runToCompletion(findNewestFromScratch(node, clock));
    newest = answer.newest;
    rounds = answer.rounds;
  } else {
    const playingHead = Math.max(0, head - scenario.divergence);
    // The playing quality's head, read a moment ago, on the same broadcast clock, with this
    // quality's PDT offset differing by up to about ten seconds for a rung that started late.
    const pdtSkewMs = random.chance(0.25) ? random.uniform(-10_000, 10_000) : random.uniform(-1_000, 1_000);
    const hint = {
      index: playingHead,
      newestSegmentEndMs: target.segmentEndMs[head] + pdtSkewMs - random.uniform(0, 2_000),
      seenAtMs: clock.now() - random.uniform(0, 500),
    };
    const answer = await time.runToCompletion(findNewestFromHint(node, clock, hint));
    newest = answer.newest;
    rounds = answer.rounds;
    usedFallback = answer.usedFallback;
  }

  const foundIndex = newest?.index ?? -1;
  return {
    reads: node.tally.reads,
    earlyAsks: node.tally.earlyAsks,
    rounds,
    timeMs: time.trueNowMs - nowMs,
    correct: foundIndex >= head && target.readableAt(foundIndex) <= time.trueNowMs,
    nextSlotEarlyAsks: node.earlyAsksBySlot.get(foundIndex + 1) ?? 0,
    usedFallback,
  };
}
