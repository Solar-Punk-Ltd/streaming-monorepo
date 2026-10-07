import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { SwitchHint } from '../../src/components/SwarmHlsPlayer/following/findNewestFromHint.js';
import { MARKER_REUSE_MS, MarkerFinder } from '../../src/components/SwarmHlsPlayer/markerFinder.js';
import {
  type FeedRung,
  IndexSearchFinder,
  type NewestIndexFinder,
} from '../../src/components/SwarmHlsPlayer/newestIndexFinder.js';
import { markerPeriodAt } from '@swarm-hls-stream/shared';

import { VirtualTime } from '../feedModel/virtualTime.js';
import { TimedGateway } from '../helpers/timedGateway.js';

const OWNER = 'a1'.repeat(20);
const GROUP = Topic.fromString('marker-finder-group');
const LOW = Topic.fromString('marker-finder-360p');
const TOP = Topic.fromString('marker-finder-720p');
const ROUND_TRIP_MS = 650;
const LAG_MS = 800;
/** Three seconds into period 300, about 1,500 indexes into the broadcast. */
const NOW_MS = 3_003_000;

interface Rig {
  time: VirtualTime;
  gateway: TimedGateway;
  /** Every call that reached the search the player made before markers, with the hint it was given. */
  fallbacks: { rung: string; hint: SwitchHint | null }[];
  finder: MarkerFinder;
}

/**
 * A ladder of two qualities live for about fifty minutes, read by a viewer whose clock is
 * `viewerBehindMs` behind the gateway's and who has learned `learnedOffsetMs` of that.
 */
async function rig(options: { viewerBehindMs?: number; learnedOffsetMs?: number } = {}): Promise<Rig> {
  const time = new VirtualTime();
  await time.runUntil(NOW_MS);
  const gateway = new TimedGateway(time, OWNER, ROUND_TRIP_MS);
  gateway.addFeed(LOW, '360p', { lagMs: LAG_MS });
  gateway.addFeed(TOP, '720p', { lagMs: LAG_MS });
  const clock = time.clock(-(options.viewerBehindMs ?? 0));
  const fallbacks: Rig['fallbacks'] = [];
  const fallback: NewestIndexFinder = {
    findNewest: async (rung, hint) => {
      fallbacks.push({ rung: rung.topic.toHex(), hint });
      return null;
    },
  };
  const learned = options.learnedOffsetMs ?? 0;
  const finder = new MarkerFinder(gateway.reader, clock, () => learned, fallback);
  return { time, gateway, fallbacks, finder };
}

/**
 * The head moves on while a search runs, so the answer is the head when it began or a newer one, as
 * the finders' own tests hold it.
 */
function assertHead(
  rig: Rig,
  topic: Topic,
  found: { index: { toBigInt(): bigint } } | null,
  headAtStart: number,
): void {
  const index = Number(found?.index.toBigInt() ?? -1);
  const headAtEnd = rig.gateway.newestAt(topic, rig.time.trueNowMs);
  assert.ok(index >= headAtStart && index <= headAtEnd, `found ${index}, head ${headAtStart} to ${headAtEnd}`);
}

/** A ladder whose uploader writes no markers at all. */
const NO_MARKERS = { omitted: () => true };

function rungOf(topic: Topic): FeedRung {
  return { owner: OWNER, topic, group: GROUP.toHex() };
}

describe('finding the newest index from a time marker', () => {
  it('reads one marker and then one round of slots at the start', async () => {
    const setup = await rig();
    const { time, gateway, fallbacks, finder } = setup;
    gateway.serveMarkers(GROUP);
    const head = gateway.newestAt(TOP, time.trueNowMs);

    const found = await time.runToCompletion(finder.findNewest(rungOf(TOP), null));

    assert.deepEqual(fallbacks, []);
    assertHead(setup, TOP, found, head);
    assert.deepEqual(
      gateway.markerReads.map((read) => read.period),
      [markerPeriodAt(NOW_MS) - 1],
      'one marker read, of the previous period',
    );
    const slotReads = gateway.readsOf(TOP);
    assert.ok(slotReads.length > 0 && slotReads.length <= 8, `${slotReads.length} slot reads, one round at most`);
    assert.equal(new Set(slotReads.map((read) => read.atMs)).size, 1, 'every slot read went out together');
  });

  it('serves a switch right after the start from the marker already read', async () => {
    const setup = await rig();
    const { time, gateway, finder } = setup;
    gateway.serveMarkers(GROUP);

    await time.runToCompletion(finder.findNewest(rungOf(TOP), null));
    await time.runUntil(time.trueNowMs + MARKER_REUSE_MS - 2_000);
    const head = gateway.newestAt(LOW, time.trueNowMs);
    const hint = { index: 1, newestSegmentEndMs: 0, seenAtMs: 0 };
    const found = await time.runToCompletion(finder.findNewest(rungOf(LOW), hint));

    assertHead(setup, LOW, found, head);
    assert.equal(gateway.markerReads.length, 1, 'the marker was read once for both qualities');
  });

  it('takes the period before when the previous one has no marker', async () => {
    const setup = await rig();
    const { time, gateway, fallbacks, finder } = setup;
    const period = markerPeriodAt(NOW_MS);
    gateway.serveMarkers(GROUP, { omitted: (omitted) => omitted === period - 1 });
    const head = gateway.newestAt(TOP, time.trueNowMs);

    const found = await time.runToCompletion(finder.findNewest(rungOf(TOP), null));

    assert.deepEqual(fallbacks, []);
    assertHead(setup, TOP, found, head);
    assert.deepEqual(
      gateway.markerReads.map((read) => [read.period, read.found]),
      [
        [period - 1, false],
        [period - 2, true],
      ],
    );
  });

  it('searches as before, with the hint it was given, when the ladder has no marker', async () => {
    const { time, gateway, fallbacks, finder } = await rig();
    gateway.serveMarkers(GROUP, NO_MARKERS);
    const hint = { index: 1_490, newestSegmentEndMs: 2_980_000, seenAtMs: 2_999_000 };

    await time.runToCompletion(finder.findNewest(rungOf(TOP), hint));

    assert.deepEqual(fallbacks, [{ rung: TOP.toHex(), hint }]);
    assert.equal(gateway.markerReads.length, 2, 'the previous period and the one before, once each');
    assert.deepEqual(gateway.readsOf(TOP), [], 'no slot was read before the fallback');
  });

  it('treats a malformed marker as no marker', async () => {
    const { time, gateway, fallbacks, finder } = await rig();
    gateway.serveMarkers(GROUP, { body: (marker) => JSON.stringify({ ...marker, extra: true }) });

    await time.runToCompletion(finder.findNewest(rungOf(TOP), null));

    assert.deepEqual(fallbacks, [{ rung: TOP.toHex(), hint: null }]);
  });

  it('searches as before for a quality the marker does not name', async () => {
    const { time, gateway, fallbacks, finder } = await rig();
    gateway.serveMarkers(GROUP, {
      body: (marker) => JSON.stringify({ ...marker, rungs: { [LOW.toHex()]: marker.rungs[LOW.toHex()] } }),
    });

    await time.runToCompletion(finder.findNewest(rungOf(TOP), null));

    assert.deepEqual(fallbacks, [{ rung: TOP.toHex(), hint: null }]);
    assert.equal(gateway.markerReads.length, 1);
  });

  it('never reads a missing marker address a second time', async () => {
    const { time, gateway, finder } = await rig();
    gateway.serveMarkers(GROUP, NO_MARKERS);
    const period = markerPeriodAt(NOW_MS);

    await time.runToCompletion(finder.findNewest(rungOf(TOP), null));
    await time.runToCompletion(finder.findNewest(rungOf(LOW), null));
    await time.runUntil(time.trueNowMs + 10_000);
    await time.runToCompletion(finder.findNewest(rungOf(TOP), null));

    assert.deepEqual(
      gateway.markerReads.map((read) => read.period),
      [period - 1, period - 2, period],
      'each address once, and the next period only once it came round',
    );
  });

  it("corrects the viewer's clock by the gateway's, so a viewer a minute behind reads the right period", async () => {
    const setup = await rig({ viewerBehindMs: 60_000, learnedOffsetMs: 60_000 });
    const { time, gateway, fallbacks, finder } = setup;
    gateway.serveMarkers(GROUP);
    const head = gateway.newestAt(TOP, time.trueNowMs);

    const found = await time.runToCompletion(finder.findNewest(rungOf(TOP), null));

    assert.deepEqual(fallbacks, []);
    assert.deepEqual(
      gateway.markerReads.map((read) => read.period),
      [markerPeriodAt(NOW_MS) - 1],
    );
    assertHead(setup, TOP, found, head);
    assert.ok(gateway.readsOf(TOP).length <= 8, 'one round from the marker');
  });

  it('without the correction, a viewer a minute ahead asks for periods not written yet and searches as before', async () => {
    const { time, gateway, fallbacks, finder } = await rig({ viewerBehindMs: -60_000 });
    gateway.serveMarkers(GROUP);

    await time.runToCompletion(finder.findNewest(rungOf(TOP), null));

    const period = markerPeriodAt(NOW_MS + 60_000);
    assert.deepEqual(
      gateway.markerReads.map((read) => [read.period, read.found]),
      [
        [period - 1, false],
        [period - 2, false],
      ],
    );
    assert.deepEqual(fallbacks, [{ rung: TOP.toHex(), hint: null }]);
  });
});

describe('a search for a quality that stops being followed', () => {
  it('reads nothing more once the stop check says so, from the search before markers', async () => {
    const time = new VirtualTime();
    await time.runUntil(NOW_MS);
    const gateway = new TimedGateway(time, OWNER, ROUND_TRIP_MS);
    gateway.addFeed(TOP, '720p', { lagMs: LAG_MS });
    const finder = new IndexSearchFinder(gateway.reader, time.clock());
    let stopped = false;
    time.at(NOW_MS + 100, () => {
      stopped = true;
    });

    await time.runToCompletion(finder.findNewest(rungOf(TOP), null, () => stopped));

    assert.ok(gateway.reads.length > 0, 'the first round went out before the stop');
    assert.deepEqual(
      gateway.reads.filter((read) => read.atMs > NOW_MS + 100),
      [],
      'the search read on after the quality stopped being followed',
    );
  });

  it('reads no slot once the stop check says so while the marker is read', async () => {
    const { time, gateway, finder } = await rig();
    gateway.serveMarkers(GROUP);
    let stopped = false;
    time.at(NOW_MS + 100, () => {
      stopped = true;
    });

    const found = await time.runToCompletion(finder.findNewest(rungOf(TOP), null, () => stopped));

    assert.equal(found, null);
    assert.equal(gateway.markerReads.length, 1);
    assert.deepEqual(gateway.readsOf(TOP), []);
  });
});
