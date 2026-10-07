import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { FeedHealthTracker } from '../src/components/SwarmHlsPlayer/feedState.js';
import { LadderFeedPoller, type LadderFeedPollerOptions } from '../src/components/SwarmHlsPlayer/LadderFeedPoller.js';
import { ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement.js';

import { VirtualTime } from './feedModel/virtualTime.js';
import { TimedGateway } from './helpers/timedGateway.js';

/**
 * The poller on simulated time, against a gateway that answers every read after phase 0's 650 ms and
 * publishes one index every two seconds. What is checked is how the playing quality is followed: the
 * asks the study's predicted follower makes, wired into the player rather than run on its own.
 */

const OWNER = 'ddeeff';
const GROUP = Topic.fromString('rung-following-group').toString();
const LOW = Topic.fromString('rf-360p');
const TOP = Topic.fromString('rf-720p');
const RUNGS = [
  { topic: LOW, bandwidth: 700_000 },
  { topic: TOP, bandwidth: 3_000_000 },
];
const ROUND_TRIP_MS = 650;
const JOIN_AT_MS = 61_000;

const state = ManifestStateManager.getInstance();
let pollers: LadderFeedPoller[] = [];

function makeRig(options: LadderFeedPollerOptions = {}) {
  const time = new VirtualTime();
  const gateway = new TimedGateway(time, OWNER, ROUND_TRIP_MS);
  gateway.addFeed(TOP, 'top', { lagMs: 900 });
  gateway.addFeed(LOW, 'low', { lagMs: 900 });
  const health = new FeedHealthTracker(() => time.trueNowMs);
  const poller = new LadderFeedPoller(state, gateway.fetchResource, 750, health, undefined, undefined, {
    now: () => time.trueNowMs,
    followClock: time.clock(),
    finder: gateway.knownHeadFinder(),
    ...options,
  });
  poller.register(OWNER, RUNGS, GROUP);
  pollers.push(poller);
  return { time, gateway, health, poller };
}

beforeEach(() => {
  state.clear();
  pollers = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const poller of pollers) {
    poller.unregister(RUNGS.map((rung) => rung.topic));
  }
  vi.restoreAllMocks();
});

describe('following the playing quality with the predicted follower', () => {
  it('asks each slot early at most once in steady state, and about forty times a minute', async () => {
    const { time, gateway, poller } = makeRig();
    await time.runUntil(JOIN_AT_MS);
    poller.activate(TOP.toString());
    const followFromMs = JOIN_AT_MS + 60_000;
    await time.runUntil(followFromMs + 300_000);

    const startedAt = gateway.readsOf(TOP)[0].index;
    const newest = Number(state.getIndex(TOP.toString())?.toBigInt() ?? -1n);
    assert.ok(newest >= gateway.newestAt(TOP, time.trueNowMs) - 1, `followed to ${newest} only`);

    const early = gateway.earlyAsks(TOP);
    const steady = gateway.readsOf(TOP).filter((read) => read.atMs >= followFromMs);
    for (const index of new Set(steady.map((read) => read.index))) {
      if (index > startedAt) {
        assert.ok((early.get(index) ?? 0) <= 1, `index ${index} was asked early ${early.get(index)} times`);
      }
    }
    const perMinute = steady.length / 5;
    assert.ok(perMinute <= 45, `${perMinute.toFixed(1)} reads a minute`);
  });

  it('looks one slot past a slot that is late rather than waiting on it', async () => {
    const { time, gateway, poller } = makeRig();
    // The node refuses one slot the publisher wrote, while the slots after it are served on time.
    const refused = 45;
    const readable = gateway.readableAtMs.bind(gateway);
    gateway.readableAtMs = (topic, index) => (index === refused ? Infinity : readable(topic, index));
    await time.runUntil(JOIN_AT_MS);
    poller.activate(TOP.toString());
    const dueAtMs = gateway.readableAtMs(TOP, refused + 1);
    await time.runUntil(dueAtMs + 8_000);

    const taken = Number(state.getIndex(TOP.toString())?.toBigInt());
    assert.ok(taken > refused, `the walk stayed on refused slot ${refused}`);
    const past = gateway.readsOf(TOP).find((read) => read.index === refused + 1 && read.found);
    assert.ok(past && past.atMs - dueAtMs <= 6_000, `the slot past the refused one was taken ${past?.atMs} ms`);
  });
});
