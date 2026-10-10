import { FeedIndex, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_STALLED,
  FeedHealthTracker,
  UNSERVED_SLOT_STALL_MS,
} from '../src/components/SwarmHlsPlayer/feedState.js';
import type { FollowClock } from '../src/components/SwarmHlsPlayer/following/feedReader.js';
import { PREDICTED_DEFAULTS } from '../src/components/SwarmHlsPlayer/following/followPredicted.js';
import {
  LadderFeedPoller,
  type LadderFeedPollerOptions,
  STALL_REPROBE_MS,
} from '../src/components/SwarmHlsPlayer/LadderFeedPoller.js';
import { ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement.js';
import { IndexSearchFinder, type NewestIndexFinder } from '../src/components/SwarmHlsPlayer/newestIndexFinder.js';
import { parseManifest } from '../src/components/SwarmHlsPlayer/playlist.js';
import { rungHeadMarkers } from '../src/components/SwarmHlsPlayer/rungHeadMarkers.js';
import { STALE_RUNG_LAG_MS } from '../src/components/SwarmHlsPlayer/rungPosition.js';
import { markerPeriodAt, markerPeriodStartMs } from '@swarm-hls-stream/shared';

import { fastClock } from './helpers/fastClock.js';
import { FakeLadderGateway, LADDER_EPOCH_MS, ladderPlaylist, SEGMENT_S } from './helpers/fakeLadderGateway.js';
import { waitFor } from './helpers/waiting.js';
import { SEGMENTS_AS_WRITTEN } from '../src/components/SwarmHlsPlayer/ManifestManagement';

/**
 * The player follows only the quality it plays (the owner, 2026-10-07: "only one quality request at the
 * time. Not 4! We only request what we watch."). One case per row of the plan's behaviour checklist,
 * Q1 to Q7, plus the two traps the uploader's own code sets: rungs whose indexes do not line up, and
 * rungs whose stamps run seconds apart. Neither may be read as a dead rung.
 */

const OWNER = 'aabbcc';
const GROUP = Topic.fromString('one-quality-group').toString();
const POLL_MS = 2;
/** The progress bound, short so a trial ends inside a test. Production's is `rungProgressBoundMs`. */
const BOUND_MS = 150;
const RETURN_MS = 5;
/**
 * The bound for a case where the sibling does move. The sibling's read must land inside the bound, which a 150 ms
 * timer did not always give a loaded machine, and failover is decided when the bound ends, so it stays well under
 * a wait's two seconds.
 */
const SIBLING_MOVES_BOUND_MS = 600;
/**
 * How much faster than real time the follower runs: a two second segment is twenty milliseconds. Slow
 * enough that a switch's search, which moves its hint on by the segments since it was read, still
 * starts close to the playing rung.
 */
const FOLLOW_SPEED = 100;

const LOW = Topic.fromString('oq-360p');
const MID = Topic.fromString('oq-720p');
const TOP = Topic.fromString('oq-1080p');
const RUNGS = [
  { topic: LOW, bandwidth: 700_000 },
  { topic: MID, bandwidth: 2_800_000 },
  { topic: TOP, bandwidth: 5_000_000 },
];
const hex = (topic: Topic): string => topic.toString();

function makeClock() {
  let ms = 1_000_000;
  return { now: () => ms, advance: (by: number) => void (ms += by) };
}

const state = ManifestStateManager.getInstance();

function segmentUris(topic: Topic): string[] {
  const serialized = state.serialize(hex(topic), SEGMENTS_AS_WRITTEN);
  return serialized ? parseManifest(serialized).segments.map((segment) => segment.uri) : [];
}

interface Rig {
  gateway: FakeLadderGateway;
  health: FeedHealthTracker;
  poller: LadderFeedPoller;
  clock: ReturnType<typeof makeClock>;
  stopped: { rung: string; failoverTo: string | null; reason: string }[];
  playhead: { ms: number | null };
  /** The rungs the finder was asked about, in order, by hex topic. */
  finds: string[];
  followClock: FollowClock;
}

let rigs: Rig[] = [];

function makeRig(
  options: {
    finderFor?: (gateway: FakeLadderGateway) => NewestIndexFinder;
    progressBoundMs?: number;
    headMarkersFor?: (gateway: FakeLadderGateway) => LadderFeedPollerOptions['headMarkers'];
  } = {},
): Rig {
  const gateway = new FakeLadderGateway(OWNER);
  const clock = makeClock();
  const health = new FeedHealthTracker(clock.now);
  const playhead = { ms: null as number | null };
  const followClock = fastClock(FOLLOW_SPEED);
  const finds: string[] = [];
  const finder = options.finderFor?.(gateway) ?? new IndexSearchFinder(gateway.reader, followClock);
  const poller = new LadderFeedPoller(state, gateway.reader, POLL_MS, health, undefined, () => RETURN_MS, {
    now: clock.now,
    progressBoundMs: options.progressBoundMs ?? BOUND_MS,
    playheadMs: () => playhead.ms,
    finder: {
      findNewest: (rung, hint, isStopped) => {
        finds.push(rung.topic.toString());
        return finder.findNewest(rung, hint, isStopped);
      },
    },
    followClock,
    headMarkers: options.headMarkersFor?.(gateway),
  });
  const stopped: Rig['stopped'] = [];
  health.onRungStopped((rung, detail) => {
    stopped.push({ rung, failoverTo: detail.failoverTo, reason: detail.reason });
  });
  const rig = { gateway, health, poller, clock, stopped, playhead, finds, followClock };
  rigs.push(rig);
  return rig;
}

/** Waits a few of the walk's own polls, for a case asserting something does not happen. */
async function polls(count = 20): Promise<void> {
  await sleep(POLL_MS * count);
}

beforeEach(() => {
  state.clear();
  rigs = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const rig of rigs) {
    rig.poller.unregister(RUNGS.map((rung) => rung.topic));
  }
  vi.restoreAllMocks();
});

describe('Q1: only the rung that plays is walked', () => {
  it('registers every rung and reads none of them until one is activated', async () => {
    const { gateway, poller } = makeRig();
    for (const { topic } of RUNGS) {
      gateway.publishLive(topic, topic === LOW ? 'low' : topic === MID ? 'mid' : 'top', 10);
    }

    poller.register(OWNER, RUNGS, GROUP);
    await polls();

    assert.deepEqual(gateway.requests, [], 'a registered rung was read before anything asked for it');
    assert.equal(poller.isRegistered(hex(TOP)), true);
    assert.equal(poller.isActive(hex(TOP)), false);
  });

  it('walks the activated rung alone, and a switch adds only the new rung, whose walk starts with the finder', async () => {
    const { gateway, poller, finds } = makeRig();
    gateway.publishLive(LOW, 'low', 10);
    gateway.publishLive(MID, 'mid', 10);
    gateway.publishLive(TOP, 'top', 10);
    poller.register(OWNER, RUNGS, GROUP);

    poller.activate(hex(TOP));
    await poller.ready(hex(TOP));
    gateway.publishNext(TOP);
    await waitFor(() => segmentUris(TOP).includes('top-seg-11'), 'the top rung to follow its feed');
    await polls();

    assert.deepEqual(gateway.requestsFor(hex(LOW)), [], 'the low rung was read while nobody played it');
    assert.deepEqual(gateway.requestsFor(hex(MID)), [], 'the mid rung was read while nobody played it');

    poller.activate(hex(MID));
    await poller.ready(hex(MID));
    assert.deepEqual(finds, [hex(TOP), hex(MID)], 'the new rung did not start with the finder');

    poller.followOnly(hex(MID));
    const topReadsAtSwitch = gateway.requestsFor(hex(TOP)).length;
    gateway.publishNext(TOP);
    await polls();

    assert.equal(gateway.requestsFor(hex(TOP)).length, topReadsAtSwitch, 'the old rung kept walking after the switch');
    assert.deepEqual(gateway.requestsFor(hex(LOW)), [], 'a switch read a rung it was not switching to');
    assert.equal(poller.isActive(hex(TOP)), false);
  });

  it("hands the finder the ladder's group, where its time markers are found, at a start and at a switch", async () => {
    const groups: (string | null | undefined)[] = [];
    const { gateway, poller } = makeRig({
      finderFor: (gateway) => {
        const search = new IndexSearchFinder(gateway.reader, fastClock(FOLLOW_SPEED));
        return {
          findNewest(rung, hint) {
            groups.push(rung.group);
            return search.findNewest(rung, hint);
          },
        };
      },
    });
    gateway.publishLive(TOP, 'top', 7);
    gateway.publishLive(MID, 'mid', 7);
    poller.register(OWNER, RUNGS, GROUP);

    poller.activate(hex(TOP));
    await poller.ready(hex(TOP));
    poller.activate(hex(MID));
    await poller.ready(hex(MID));

    assert.deepEqual(groups, [GROUP, GROUP]);
  });

  it('hands the search a stop check that turns true once the rung is unregistered', async () => {
    let stopCheck: (() => boolean) | undefined;
    let release = () => {};
    const { poller } = makeRig({
      finderFor: () => ({
        findNewest(_rung, _hint, isStopped) {
          stopCheck = isStopped;
          return new Promise((resolve) => {
            release = () => resolve(null);
          });
        },
      }),
    });
    poller.register(OWNER, RUNGS, GROUP);
    poller.activate(hex(TOP));
    await waitFor(() => stopCheck !== undefined, 'the search to start');
    assert.equal(stopCheck?.(), false);

    poller.unregister([TOP]);

    assert.equal(stopCheck?.(), true, 'the search in flight was not told the rung stopped');
    release();
  });

  it('hands the finder the playing rung newest slot as a hint, and walks whatever the finder says is newest', async () => {
    const hints: unknown[] = [];
    const { gateway, poller } = makeRig({
      finderFor: (gateway) => ({
        async findNewest(rung, hint) {
          hints.push(hint === null ? null : { index: hint.index, newestSegmentEndMs: hint.newestSegmentEndMs });
          const head = gateway.head(rung.topic);
          const response = await gateway.answerPath(gateway.slotPath(rung.topic, head));
          return { index: FeedIndex.fromBigInt(BigInt(head)), playlist: response.text };
        },
      }),
    });
    gateway.publishLive(TOP, 'top', 7);
    gateway.publishLive(MID, 'mid', 900, { sequenceOffset: 7 - 900 });
    poller.register(OWNER, RUNGS, GROUP);

    poller.activate(hex(TOP));
    await poller.ready(hex(TOP));
    poller.activate(hex(MID));
    await poller.ready(hex(MID));

    // Index 7 of the top rung ends with segment 7, stamped from the ladder's epoch.
    const segmentEndMs = LADDER_EPOCH_MS + 8 * SEGMENT_S * 1000;
    assert.deepEqual(
      hints,
      [null, { index: 7, newestSegmentEndMs: segmentEndMs }],
      'the first rung has no hint, and a switch hints the playing slot',
    );
    assert.equal(state.getIndex(hex(MID))?.toBigInt(), 900n, 'the hint was read as the new rung index');
  });

  it('finds the newest index by reading slots, never through the feed head lookup', async () => {
    const { gateway, poller } = makeRig();
    gateway.publishLive(TOP, 'top', 300);
    gateway.publishLive(MID, 'mid', 300);
    poller.register(OWNER, RUNGS, GROUP);

    poller.activate(hex(TOP));
    await poller.ready(hex(TOP));
    poller.activate(hex(MID));
    await poller.ready(hex(MID));

    assert.equal(state.getIndex(hex(TOP))?.toBigInt(), 300n);
    assert.equal(state.getIndex(hex(MID))?.toBigInt(), 300n);
    assert.deepEqual(
      gateway.requests.filter((read) => read.kind === 'head'),
      [],
      'a rung was started through the feed head lookup',
    );
    const switchReads = gateway.requestsFor(hex(MID)).length;
    assert.ok(switchReads <= 16, `a switch between level rungs cost ${switchReads} reads`);
  });
});

describe('Q2: a quality that stopped while not playing is found at switch time', () => {
  async function playTopThenSwitchTo(rig: Rig, target: Topic): Promise<void> {
    rig.poller.register(OWNER, RUNGS, GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    rig.poller.activate(hex(target));
    await rig.poller.ready(hex(target));
  }

  it('refuses a rung whose newest playlist is finished while the playing rung is live, and announces it once', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 40);
    rig.gateway.publishLive(MID, 'mid', 40);
    rig.gateway.finishHead(MID);

    await playTopThenSwitchTo(rig, MID);
    rig.poller.activate(hex(MID));
    await polls();

    assert.equal(rig.poller.readiness(hex(MID)), 'refused');
    assert.deepEqual(
      rig.stopped.map(({ rung, failoverTo }) => ({ rung, failoverTo })),
      [{ rung: hex(MID), failoverTo: hex(TOP) }],
    );
    assert.equal(rig.poller.isActive(hex(TOP)), true, 'the viewer lost the rung they were playing');
  });

  it(`refuses a rung whose newest segment is more than ${STALE_RUNG_LAG_MS / 1000}s behind the playing one`, async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 60);
    // Twenty segments behind is forty seconds of a broadcast this rung stopped carrying.
    rig.gateway.publishLive(MID, 'mid', 40);

    await playTopThenSwitchTo(rig, MID);

    assert.equal(rig.poller.readiness(hex(MID)), 'refused');
    assert.equal(rig.stopped.length, 1);
  });

  it('lets the switch happen onto a rung whose index is far from the playing one, which is ordinary', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 40);
    // Index counts playlists published, which coalesce under load, so siblings drift without bound.
    rig.gateway.publishLive(MID, 'mid', 400, { sequenceOffset: 40 - 400 });

    await playTopThenSwitchTo(rig, MID);

    assert.equal(rig.poller.readiness(hex(MID)), 'ready');
    assert.deepEqual(rig.stopped, []);
  });

  it('lets the switch happen onto a rung whose stamps run ten seconds behind, which a late start does', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 40);
    rig.gateway.publishLive(MID, 'mid', 40, { stampShiftMs: -10_000 });

    await playTopThenSwitchTo(rig, MID);

    assert.equal(rig.poller.readiness(hex(MID)), 'ready');
    assert.deepEqual(rig.stopped, []);
  });
});

describe('Q3: the playing quality stops', () => {
  /** The top rung plays and has gone quiet for the stall threshold. */
  async function stallTop(rig: Rig): Promise<void> {
    rig.poller.register(OWNER, RUNGS, GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    await waitFor(() => rig.health.unservedPollsRecorded(hex(TOP)) > 0, 'the top rung to sit on an unwritten slot');
    rig.clock.advance(UNSERVED_SLOT_STALL_MS);
  }

  it('walks the next lower rung as a candidate and fails over to it once it shows a new index', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);
    rig.gateway.publishLive(LOW, 'low', 20);

    await stallTop(rig);
    await waitFor(() => rig.poller.isActive(hex(MID)), 'the next lower rung to be tried');
    rig.gateway.publishNext(MID);
    await waitFor(() => rig.stopped.length > 0, 'the playing rung to be failed over');

    assert.deepEqual(
      rig.stopped.map(({ rung, failoverTo }) => ({ rung, failoverTo })),
      [{ rung: hex(TOP), failoverTo: hex(MID) }],
    );
    assert.deepEqual(rig.gateway.requestsFor(hex(LOW)), [], 'a rung below the candidate was read');
  });

  it('reads a broadcast that paused as stalled, stops the candidate, and fails nothing over', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);

    await stallTop(rig);
    await waitFor(() => rig.poller.isActive(hex(MID)), 'the next lower rung to be tried');
    await waitFor(() => !rig.poller.isActive(hex(MID)), 'the candidate to be stopped once the bound passed');

    assert.deepEqual(rig.stopped, []);
    assert.equal(rig.health.state(GROUP), FEED_STATE_STALLED);
  });

  it('tries once per stall, and again only after thirty seconds more', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);
    const midHeads = () => rig.finds.filter((rung) => rung === hex(MID)).length;

    await stallTop(rig);
    await waitFor(() => !rig.poller.isActive(hex(MID)) && midHeads() === 1, 'the first trial to end');
    await polls(BOUND_MS / POLL_MS + 20);
    assert.equal(midHeads(), 1, 'the candidate was tried again inside the same stall');

    rig.clock.advance(STALL_REPROBE_MS);
    await waitFor(() => midHeads() === 2, 'a second trial thirty seconds on');
  });

  it('fails over to a lower rung whose index is far from the playing one, and never removes it', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 700, { sequenceOffset: 20 - 700 });

    await stallTop(rig);
    await waitFor(() => rig.poller.isActive(hex(MID)), 'the next lower rung to be tried');
    rig.gateway.publishNext(MID);
    await waitFor(() => rig.stopped.length > 0, 'the playing rung to be failed over');

    assert.deepEqual(
      rig.stopped.map(({ rung }) => rung),
      [hex(TOP)],
    );
  });

  it('gives a sibling its whole bound once its newest index is found, however long the search took', async () => {
    let finding: Promise<void> = Promise.resolve();
    const rig = makeRig({
      finderFor: (gateway) => {
        const search = new IndexSearchFinder(gateway.reader, fastClock(FOLLOW_SPEED));
        return {
          async findNewest(rung, hint) {
            const found = await search.findNewest(rung, hint);
            if (rung.topic.toString() === hex(MID)) {
              // Longer than the whole bound, as a search on a slow node can be.
              finding = sleep(BOUND_MS * 2);
              await finding;
            }
            return found;
          },
        };
      },
    });
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);

    await stallTop(rig);
    await waitFor(() => rig.finds.includes(hex(MID)), 'the next lower rung to be searched');
    await sleep(BOUND_MS * 2 + 20);
    await finding;
    rig.gateway.publishNext(MID);
    await waitFor(() => rig.stopped.length > 0, 'the playing rung to be failed over');

    assert.deepEqual(
      rig.stopped.map(({ rung, failoverTo }) => ({ rung, failoverTo })),
      [{ rung: hex(TOP), failoverTo: hex(MID) }],
    );
  });

  it('fails over to a lower rung whose stamps run ten seconds behind, and never removes it', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20, { stampShiftMs: -10_000 });

    await stallTop(rig);
    await waitFor(() => rig.poller.isActive(hex(MID)), 'the next lower rung to be tried');
    rig.gateway.publishNext(MID);
    await waitFor(() => rig.stopped.length > 0, 'the playing rung to be failed over');

    assert.deepEqual(
      rig.stopped.map(({ rung }) => rung),
      [hex(TOP)],
    );
  });

  /** Decision 37: the player fails over again and again until it is on a quality that moves. */
  it('fails over a second time when the quality it moved to stops as well', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);
    rig.gateway.publishLive(LOW, 'low', 20);

    await stallTop(rig);
    await waitFor(() => rig.poller.isActive(hex(MID)), 'the next lower rung to be tried');
    rig.gateway.publishNext(MID);
    await waitFor(() => rig.stopped.length > 0, 'the playing rung to be failed over');
    rig.poller.followOnly(hex(MID));
    await waitFor(() => rig.health.unservedPollsRecorded(hex(MID)) > 0, 'the middle rung to sit on an unwritten slot');
    rig.clock.advance(UNSERVED_SLOT_STALL_MS);
    await waitFor(() => rig.poller.isActive(hex(LOW)), 'the lowest rung to be tried');
    rig.gateway.publishNext(LOW);
    await waitFor(() => rig.stopped.length > 1, 'the middle rung to be failed over');

    assert.deepEqual(
      rig.stopped.map(({ rung, failoverTo }) => ({ rung, failoverTo })),
      [
        { rung: hex(TOP), failoverTo: hex(MID) },
        { rung: hex(MID), failoverTo: hex(LOW) },
      ],
    );
  });

  it('fails over past a quality it refused at a switch, to the next one that moves', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 40);
    rig.gateway.publishLive(MID, 'mid', 20);
    rig.gateway.publishLive(LOW, 'low', 40);
    rig.poller.register(OWNER, RUNGS, GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    rig.poller.activate(hex(MID));
    await waitFor(() => rig.poller.readiness(hex(MID)) === 'refused', 'the stale middle rung to be refused');

    await waitFor(() => rig.health.unservedPollsRecorded(hex(TOP)) > 0, 'the top rung to sit on an unwritten slot');
    rig.clock.advance(UNSERVED_SLOT_STALL_MS);
    await waitFor(() => rig.poller.isActive(hex(LOW)), 'the lowest rung to be tried past the refused one');
    rig.gateway.publishNext(LOW);
    await waitFor(() => rig.stopped.length > 1, 'the playing rung to be failed over');

    assert.deepEqual(
      rig.stopped.map(({ rung, failoverTo }) => ({ rung, failoverTo })),
      [
        { rung: hex(MID), failoverTo: hex(TOP) },
        { rung: hex(TOP), failoverTo: hex(LOW) },
      ],
    );
  });
});

describe('Q4: ended is the playing rung finishing, confirmed by one sibling', () => {
  async function playTopToItsEnd(rig: Rig): Promise<void> {
    rig.poller.register(OWNER, RUNGS, GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    rig.gateway.publishNext(TOP, true);
  }

  it('records the end once when the sibling has finished too', async () => {
    const rig = makeRig();
    const states: string[] = [];
    rig.health.subscribe(GROUP, (feedState) => states.push(feedState));
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);
    rig.gateway.finishHead(MID);

    await playTopToItsEnd(rig);
    await waitFor(() => rig.health.state(GROUP) === FEED_STATE_ENDED, 'the broadcast to end');
    await polls();

    assert.deepEqual(states, [FEED_STATE_LIVE, FEED_STATE_ENDED]);
    assert.deepEqual(rig.stopped, []);
  });

  it('fails over instead when the sibling is still publishing, because one rung alone stopped', async () => {
    const rig = makeRig({ progressBoundMs: SIBLING_MOVES_BOUND_MS });
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);

    await playTopToItsEnd(rig);
    await waitFor(() => rig.poller.isActive(hex(MID)), 'the sibling to be tried');
    rig.gateway.publishNext(MID);
    await waitFor(() => rig.stopped.length > 0, 'the finished rung to be failed over');

    assert.deepEqual(
      rig.stopped.map(({ rung, failoverTo }) => ({ rung, failoverTo })),
      [{ rung: hex(TOP), failoverTo: hex(MID) }],
    );
    assert.notEqual(rig.health.state(GROUP), FEED_STATE_ENDED);
  });

  it('ends when the sibling is open but shows nothing new inside the bound', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);

    await playTopToItsEnd(rig);
    await waitFor(() => rig.health.state(GROUP) === FEED_STATE_ENDED, 'the broadcast to end');

    assert.equal(rig.poller.isActive(hex(MID)), false, 'the sibling kept walking after the end');
    assert.deepEqual(rig.stopped, []);
  });

  it('counts a sibling that publishes and then finishes inside the bound as the end, not as one rung stopping', async () => {
    // The qualities of one broadcast finish moments apart, each as its upload drains.
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);

    await playTopToItsEnd(rig);
    await waitFor(() => rig.poller.isActive(hex(MID)), 'the sibling to be tried');
    rig.gateway.publishNext(MID);
    rig.gateway.publishNext(MID, true);
    await waitFor(() => rig.health.state(GROUP) === FEED_STATE_ENDED, 'the broadcast to end');
    await polls();

    assert.deepEqual(rig.stopped, [], 'the viewer was failed over to a quality that was finishing too');
    assert.equal(rig.health.state(GROUP), FEED_STATE_ENDED);
  });

  it('runs the end check when the quality failed over to finishes before the player has switched to it', async () => {
    const rig = makeRig({ progressBoundMs: SIBLING_MOVES_BOUND_MS });
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);
    rig.gateway.publishLive(LOW, 'low', 20);
    rig.gateway.finishHead(LOW);

    await playTopToItsEnd(rig);
    await waitFor(() => rig.poller.isActive(hex(MID)), 'the sibling to be tried');
    rig.gateway.publishNext(MID);
    await waitFor(() => rig.stopped.length > 0, 'the finished rung to be failed over');
    rig.gateway.publishNext(MID, true);

    await waitFor(() => rig.health.state(GROUP) === FEED_STATE_ENDED, 'the broadcast to end');
  });
});

describe('Q5: a returning broadcast is watched on the rung that was playing', () => {
  it('asks only that rung, and rejoins as today once it opens again', async () => {
    const rig = makeRig();
    const resumed: string[] = [];
    rig.health.onFeedResumed((topic) => resumed.push(topic));
    rig.gateway.publishLive(TOP, 'top', 20);
    rig.gateway.publishLive(MID, 'mid', 20);
    rig.gateway.finishHead(MID);
    rig.poller.register(OWNER, RUNGS, GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    const finishedAt = rig.gateway.publishNext(TOP, true);
    await waitFor(() => rig.health.state(GROUP) === FEED_STATE_ENDED, 'the broadcast to end');

    const midReadsAtEnd = rig.gateway.requestsFor(hex(MID)).length;
    const watchPath = rig.gateway.slotPath(TOP, finishedAt + 1);
    await waitFor(
      () => rig.gateway.requests.filter((read) => read.path === watchPath).length >= 3,
      'the watch to ask three times',
    );
    assert.equal(rig.gateway.requestsFor(hex(MID)).length, midReadsAtEnd, 'a second rung was watched');

    rig.gateway.publishNext(TOP);
    await waitFor(() => resumed.includes(GROUP), 'the return to be announced on the group');
    assert.notEqual(rig.health.state(GROUP), FEED_STATE_ENDED);
  });
});

describe('a switch asked before hls.js reports the rung it started on', () => {
  it('keeps following the rung hls.js is loading when it reports the rung it is leaving', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 10);
    rig.gateway.publishLive(MID, 'mid', 10);
    rig.poller.register(OWNER, RUNGS, GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    rig.poller.activate(hex(MID));
    await rig.poller.ready(hex(MID));

    rig.poller.followOnly(hex(TOP), hex(MID));

    assert.equal(rig.poller.isActive(hex(MID)), true, 'the switch target was dropped');
    assert.equal(state.getIndex(hex(MID))?.toBigInt(), 10n, 'the switch target forgot what it read');
    rig.poller.activate(hex(MID));
    rig.poller.followOnly(hex(MID));
    assert.equal(rig.poller.isActive(hex(TOP)), false);
    assert.deepEqual(
      rig.finds.filter((rung) => rung === hex(MID)),
      [hex(MID)],
      'the switch target was searched for twice',
    );
  });
});

describe('Q6: a rung switched back to starts again at its newest index', () => {
  it('forgets a rung it leaves, and comes back to it with one finder read rather than a walk', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 10);
    rig.gateway.publishLive(MID, 'mid', 10);
    rig.poller.register(OWNER, RUNGS, GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    rig.poller.activate(hex(MID));
    await rig.poller.ready(hex(MID));
    rig.poller.followOnly(hex(MID));

    assert.equal(state.getIndex(hex(TOP)), null, 'the rung left behind kept its index');
    assert.equal(segmentUris(TOP).length, 0, 'the rung left behind kept its playlist');

    // Two minutes on at one index a segment.
    rig.gateway.publishLive(TOP, 'top', 70);
    rig.gateway.publishLive(MID, 'mid', 70);
    await waitFor(() => state.getIndex(hex(MID))?.toBigInt() === 70n, 'the playing rung to reach index 70');
    const topReadsBefore = rig.gateway.requestsFor(hex(TOP)).length;
    const findsBefore = rig.finds.length;
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));

    const comeback = rig.gateway.requestsFor(hex(TOP)).slice(topReadsBefore);
    assert.deepEqual(rig.finds.slice(findsBefore), [hex(TOP)], 'coming back did not start with the finder');
    assert.equal(state.getIndex(hex(TOP))?.toBigInt(), 70n);
    // One round of eight around the playing rung's index, which a level rung pins at once. Slots are counted once
    // each, because on a loaded machine the follower polls the next slot again before ready() returns.
    const slots = new Set(comeback.map((read) => rig.gateway.slotIndexOf(read.path)));
    assert.ok(slots.size <= 9, `coming back read ${slots.size} slots: ${[...slots].join(', ')}`);
  });
});

describe('Q7: a switch while the viewer is behind live keeps their position', () => {
  async function switchWhileBehind(rig: Rig, playheadSequence: number): Promise<void> {
    rig.poller.register(OWNER, RUNGS, GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    rig.playhead.ms = LADDER_EPOCH_MS + playheadSequence * SEGMENT_S * 1000;
    rig.poller.activate(hex(MID));
    await rig.poller.ready(hex(MID));
  }

  it('reads the new rung back to the playing position, from indexes that exist', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 40);
    rig.gateway.publishLive(MID, 'mid', 40);

    // The newest window holds segments 36 to 40, and the viewer is on segment 25.
    await switchWhileBehind(rig, 25);

    const uris = segmentUris(MID);
    assert.ok(uris.includes('mid-seg-25'), `the switch lost the position, holding ${uris[0]} to ${uris.at(-1)}`);
    assert.equal(uris.at(-1), 'mid-seg-40');
    // The search reads a round around the playing rung's index, misses above the newest included.
    // The reads back to the viewer are below the newest, so every one of those names a slot that exists.
    const head = rig.gateway.head(MID);
    const reads = rig.gateway.requestsFor(hex(MID)).map((read) => rig.gateway.slotIndexOf(read.path));
    assert.ok(
      reads.every((index) => index !== null && index >= 0),
      `asked for something other than a slot: ${reads.join(', ')}`,
    );
    const above = reads.filter((index) => index! > head);
    assert.ok(above.length <= 4, `asked for ${above.length} slots past the newest: ${above.join(', ')}`);
    assert.ok(reads.length <= 8 + 10 + 2, `${reads.length} slot reads for one switch`);
  });

  it('goes to the live edge and says so once ten reads cannot reach the position', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 200);
    rig.gateway.publishLive(MID, 'mid', 200);

    await switchWhileBehind(rig, 5);

    assert.equal(segmentUris(MID)[0], 'mid-seg-196');
    assert.ok(
      vi.mocked(console.debug).mock.calls.some((call) => String(call[0]).includes('live edge')),
      'the switch went to the live edge without saying so',
    );
  });

  it('reports a gateway fault while reading back as a fault, not as a viewer too far behind', async () => {
    const rig = makeRig();
    rig.gateway.publishLive(TOP, 'top', 40);
    rig.gateway.publishLive(MID, 'mid', 40);
    // The first read back from index 40 steps one window less a segment, to 36.
    rig.gateway.faultSlot(MID, 36);

    await switchWhileBehind(rig, 25);

    const debugLines = vi.mocked(console.debug).mock.calls.map((call) => String(call[0]));
    assert.ok(!debugLines.some((line) => line.includes('further behind')), 'a fault was logged as distance');
    assert.ok(
      vi.mocked(console.warn).mock.calls.some((call) => String(call[0]).includes('could not read')),
      'the fault was not logged',
    );
    assert.ok(rig.health.backoffRemainingMs(hex(MID)) > 0, 'the fault was not recorded against the rung');
    assert.equal(segmentUris(MID).at(-1), 'mid-seg-40', 'the switch still lands on the live edge');
  });
});

describe('Q8: a quality whose broadcaster went quiet waits on the time markers, not on its next slot', () => {
  /** A quiet spell of twenty seconds, longer than the follower's asks for one slot last. */
  const QUIET_MS = 20_000;
  /** Asked for before it exists this many times, an address is not found for a minute. */
  const PEERS = 4;
  const SKIP_MS = 60_000;

  /** The newest segment index a rung holds, by the segment names the player has merged. */
  function newestSegment(topic: Topic): number {
    return Math.max(-1, ...segmentUris(topic).map((uri) => Number(uri.split('-').at(-1))));
  }

  /**
   * The uploader on the follow clock: a playlist of the top rung every two seconds, stamped when it is
   * written, paused for `QUIET_MS` from `pauseAtMs`, and the ladder's marker 250 ms into every period,
   * which it keeps writing through the pause. Resolves once `isDone` says so.
   */
  async function broadcast(rig: Rig, pauseAtMs: number, isDone: () => boolean, resumed: { atMs: number | null }) {
    const { gateway, followClock } = rig;
    const group = new Topic(GROUP);
    let index = gateway.head(TOP);
    let nextSlotMs = followClock.now() + SEGMENT_S * 1000;
    let nextMarkerPeriod = markerPeriodAt(followClock.now()) + 1;
    while (!isDone()) {
      const markerAtMs = markerPeriodStartMs(nextMarkerPeriod) + 250;
      const atMs = Math.min(nextSlotMs, markerAtMs);
      await followClock.sleep(Math.max(0, atMs - followClock.now()));
      const nowMs = followClock.now();
      if (atMs === markerAtMs) {
        const period = markerPeriodAt(nowMs);
        const marker = {
          v: 2,
          period,
          writtenAt: Math.floor(nowMs),
          rungs: { [TOP.toHex()]: index },
          segmentMs: SEGMENT_S * 1000,
        };
        gateway.publishMarker(group, period, JSON.stringify(marker));
        nextMarkerPeriod = period + 1;
        continue;
      }
      nextSlotMs += SEGMENT_S * 1000;
      if (nowMs >= pauseAtMs && nowMs < pauseAtMs + QUIET_MS) {
        continue;
      }
      index += 1;
      resumed.atMs ??= nowMs >= pauseAtMs ? nowMs : null;
      const firstSequence = Math.max(0, index - 4);
      gateway.publishSlot(
        TOP,
        index,
        ladderPlaylist({
          name: 'top',
          firstSequence,
          count: index - firstSequence + 1,
          startMs: LADDER_EPOCH_MS + nowMs - (index - firstSequence) * SEGMENT_S * 1000,
        }),
      );
    }
  }

  it('stops asking the missing slot while the broadcaster is quiet, reads each marker once, and resumes', async () => {
    const rig = makeRig({
      headMarkersFor: (gateway) => (rung, clock) => rungHeadMarkers(gateway.reader, rung, clock, () => 0),
    });
    rig.gateway.publishLive(TOP, 'top', 5);
    rig.poller.register(OWNER, [{ topic: TOP, bandwidth: 5_000_000 }], GROUP);
    rig.poller.activate(hex(TOP));
    await rig.poller.ready(hex(TOP));
    // From here, so the search that starts the walk, whose round reaches past the head, is not counted.
    rig.gateway.modelSkipList(PEERS, SKIP_MS, rig.followClock.now);

    let lastBefore = -1;
    const resumed = { atMs: null as number | null };
    let caughtUp = false;
    const pauseAtMs = rig.followClock.now() + 15_000;
    const giveUpAtMs = pauseAtMs + QUIET_MS + 3 * SKIP_MS;
    const uploader = broadcast(rig, pauseAtMs, () => caughtUp || rig.followClock.now() > giveUpAtMs, resumed);
    while (!caughtUp && rig.followClock.now() <= giveUpAtMs) {
      await sleep(1);
      if (resumed.atMs === null) {
        lastBefore = rig.gateway.head(TOP);
      } else {
        caughtUp = newestSegment(TOP) > lastBefore;
      }
    }
    await uploader;

    // Timings on this clock are real timers sped up, so this checks what the player asked, never how
    // fast it came back. The time it takes is proved on virtual time in `following/followers.test.ts`.
    assert.ok(caughtUp, 'the player never caught up after the quiet spell');
    const missingAsks = rig.gateway
      .requestsFor(hex(TOP))
      .filter((request) => rig.gateway.slotIndexOf(request.path) === lastBefore + 1).length;
    assert.ok(
      missingAsks <= PREDICTED_DEFAULTS.slotAsksWithMarkers + 2,
      `the slot after the quiet spell's start was asked ${missingAsks} times`,
    );
    const markerReads = rig.gateway.markerRequests();
    assert.ok(markerReads.length > 0, 'no marker was read while the broadcaster was quiet');
    assert.equal(new Set(markerReads).size, markerReads.length, 'a marker address was read twice');
  });
});
