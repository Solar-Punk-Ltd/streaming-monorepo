import { Topic } from '@ethersphere/bee-js';
import type { Rendition } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { FeedHealthTracker } from '../src/components/SwarmHlsPlayer/feedState';
import {
  ManifestFetcher,
  ManifestStateManager,
  RungNotReadyError,
} from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { RequestJitter } from '../src/utils/requestJitter';
import { UNSUPPORTED } from '../src/swarm/answers';
import type { SwarmReader } from '../src/swarm/client';

import { VirtualTime } from './feedModel/virtualTime';
import { TimedGateway } from './helpers/timedGateway';

/**
 * A level request on a source whose misses are slow.
 *
 * Measured 2026-10-17 and 18: a freshly started light Bee 2.8.3 answered a read of a feed entry not
 * written yet after 6 to 10 s, and one it held in about 0.5 to 2 s, against 1.3 to 1.6 s for a miss
 * on a full node. A rung's search is several such reads one after another, so on that node it ran
 * past the 20 s a level request waited, every quality was failed in turn, and the player restarted in
 * a loop without showing a frame. Both rigs read a recording, whose time markers are gone, so the
 * search starts from nothing as it did there.
 */

const OWNER = '00000000000000000000000000000000005104e1';
const GROUP_ID = 'slow-source-group';
const SOURCE_URL = `swarm://${OWNER}/${GROUP_ID}`;
const RENDITION: Rendition = {
  name: '720p',
  width: 1280,
  height: 720,
  topic: 'slow-source-720p',
  bandwidth: 2_800_000,
  avgBandwidth: 2_800_000,
};
const RUNG_TOPIC = Topic.fromString(RENDITION.topic);
const RUNG_URL = `swarm://${OWNER}/${RENDITION.topic}`;

/** The light node's typical miss, and a hit on it. */
const SLOW_MISS_MS = 7_000;
const SLOW_HIT_MS = 1_500;
/** The full node's, at the top of what it measured. */
const FAST_MISS_MS = 1_600;
const FAST_HIT_MS = 650;

/** Late enough in a period that the marker of the period before is written, as at most joins. */
const JOIN_AT_MS = 121_000;

const NO_JITTER = new RequestJitter(0, () => 0);
const state = ManifestStateManager.getInstance();
let fetchers: ManifestFetcher[] = [];

/** The window each read was asked with, in order, absent where the caller left the usual one. */
type AskedWindows = Array<number | undefined>;

function swarmOver(gateway: TimedGateway, windows: AskedWindows): SwarmReader {
  return {
    readFeedHead: (owner, topic, options) => {
      windows.push(options?.timeoutMs);
      return gateway.reader.readFeedHead(owner, topic, options);
    },
    readFeedEntry: (owner, topic, index, options) => {
      windows.push(options?.timeoutMs);
      return gateway.reader.readFeedEntry(owner, topic, index, options);
    },
    readSoc: (owner, identifier, options) => {
      windows.push(options?.timeoutMs);
      return gateway.reader.readSoc(owner, identifier, options);
    },
    readChunk: async () => UNSUPPORTED,
    readBytes: async () => UNSUPPORTED,
    urlFor: (reference) => `http://segments.test/${reference}`,
    urlSource: () => null,
  };
}

/** A fetcher on simulated time over a gateway whose hits and misses take as long as given. */
function makeRig(hitMs: number, missMs: number, options: { rungPublished?: boolean } = {}) {
  const time = new VirtualTime();
  const gateway = new TimedGateway(time, OWNER, hitMs, missMs);
  if (options.rungPublished ?? true) {
    gateway.addFeed(RUNG_TOPIC, '720p', { lagMs: 900 });
  } else {
    // A rung this gateway does not hold: its feed never has a slot, and the marker names nothing.
    gateway.addFeed(RUNG_TOPIC, '720p', { lagMs: 900, startsAtMs: Infinity });
  }
  gateway.serveMarkers(Topic.fromString(GROUP_ID), { omitted: () => true });
  const waited: number[] = [];
  const fetcher = new ManifestFetcher(
    state,
    new FeedHealthTracker(() => time.trueNowMs),
    (ms) => {
      waited.push(ms);
      return time.delay(ms);
    },
    NO_JITTER,
    750,
    undefined,
    time.clock(),
  );
  const windows: AskedWindows = [];
  fetcher.useSwarm(swarmOver(gateway, windows));
  fetcher.registerLadder(SOURCE_URL, () => ({ owner: OWNER, renditions: [RENDITION] }));
  fetchers.push(fetcher);
  return { time, fetcher, waited, windows };
}

/** What a level request for the rung ends in, run on simulated time from the join. */
async function levelRequest(rig: ReturnType<typeof makeRig>): Promise<{ playlist: string | null; error: unknown }> {
  await rig.time.runUntil(JOIN_AT_MS);
  await rig.fetcher.fetchSource(SOURCE_URL);
  const request = rig.fetcher.fetch(RUNG_URL).then(
    (playlist) => ({ playlist, error: null }),
    (error: unknown) => ({ playlist: null, error }),
  );
  return rig.time.runToCompletion(request, 300_000);
}

beforeEach(() => {
  state.clear();
  fetchers = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const fetcher of fetchers) {
    fetcher.unregisterLadder(SOURCE_URL);
  }
  vi.restoreAllMocks();
});

describe('a level request on a source whose misses take six to ten seconds', () => {
  it('waits for the rung rather than failing the level, and is answered with its playlist', async () => {
    const outcome = await levelRequest(makeRig(SLOW_HIT_MS, SLOW_MISS_MS));

    assert.equal(outcome.error, null, `the level failed: ${String(outcome.error)}`);
    assert.match(outcome.playlist ?? '', /#EXTINF/);
  });

  it('says the source starts slowly once its misses have been timed', async () => {
    const rig = makeRig(SLOW_HIT_MS, SLOW_MISS_MS);
    assert.equal(rig.fetcher.startsSlowly(), false, 'slow before anything was read');

    await levelRequest(rig);

    assert.equal(rig.fetcher.startsSlowly(), true);
  });

  it('gives its reads a longer window than the usual 10 s once its misses have been timed', async () => {
    const rig = makeRig(SLOW_HIT_MS, SLOW_MISS_MS);

    await levelRequest(rig);

    assert.equal(rig.windows[0], undefined, 'the first read, before any miss was timed');
    // Twice a round of one and a half typical misses.
    assert.equal(rig.windows.at(-1), 3 * SLOW_MISS_MS);
  });
});

describe('a level request on a gateway whose misses answer within 1.6 s', () => {
  it('fails a rung the gateway does not hold at the same 20 s as before', async () => {
    const rig = makeRig(FAST_HIT_MS, FAST_MISS_MS, { rungPublished: false });

    const outcome = await levelRequest(rig);

    assert.ok(outcome.error instanceof RungNotReadyError, `expected a failed level, got ${String(outcome.error)}`);
    assert.equal(outcome.error.deadlineMs, 20_000);
    assert.deepEqual(
      rig.waited.filter((ms) => ms >= 1_000),
      [20_000],
    );
    assert.equal(rig.fetcher.startsSlowly(), false);
  });

  it('is answered with the playlist of a rung it holds', async () => {
    const outcome = await levelRequest(makeRig(FAST_HIT_MS, FAST_MISS_MS));

    assert.equal(outcome.error, null);
    assert.match(outcome.playlist ?? '', /#EXTINF/);
  });

  it('leaves every read the usual window', async () => {
    const rig = makeRig(FAST_HIT_MS, FAST_MISS_MS);

    await levelRequest(rig);

    assert.ok(rig.windows.length > 0);
    assert.ok(rig.windows.every((window) => window === undefined));
  });
});

/** A source that answers nothing it could time, so whatever is recorded after a switch came from before it. */
const UNTIMED_SOURCE: SwarmReader = {
  readFeedHead: async () => UNSUPPORTED,
  readFeedEntry: async () => UNSUPPORTED,
  readSoc: async () => UNSUPPORTED,
  readChunk: async () => UNSUPPORTED,
  readBytes: async () => UNSUPPORTED,
  urlFor: () => null,
  urlSource: () => null,
};

describe('the source a slow verdict belongs to', () => {
  it('is forgotten when the viewer picks another source', async () => {
    const rig = makeRig(SLOW_HIT_MS, SLOW_MISS_MS);
    await levelRequest(rig);
    assert.equal(rig.fetcher.startsSlowly(), true);

    rig.fetcher.useSwarm(UNTIMED_SOURCE);

    assert.equal(rig.fetcher.startsSlowly(), false);
  });

  it('is not the old source when a miss it was still answering arrives after the switch', async () => {
    const rig = makeRig(SLOW_HIT_MS, SLOW_MISS_MS);
    await rig.time.runUntil(JOIN_AT_MS);
    await rig.fetcher.fetchSource(SOURCE_URL);
    void rig.fetcher.fetch(RUNG_URL).catch(() => {});
    // Past the two time marker reads, 7 s each, the search's first round of reads is out, and its
    // misses answer 7 s after it started.
    await rig.time.runUntil(JOIN_AT_MS + 15_000);

    rig.fetcher.useSwarm(UNTIMED_SOURCE);
    await rig.time.runUntil(JOIN_AT_MS + 60_000);

    assert.equal(rig.fetcher.startsSlowly(), false);
  });
});

describe('a source whose misses take 20 s', () => {
  it('is waited for at most 125 s, eight rounds capped at 15 s and the margin', async () => {
    const rig = makeRig(SLOW_HIT_MS, 20_000, { rungPublished: false });
    // Its first quality fails at 20 s, when only one 20 s miss has been answered, too few to judge.
    const first = await levelRequest(rig);
    assert.ok(first.error instanceof RungNotReadyError);
    assert.equal(first.error.deadlineMs, 20_000);
    // The walk goes on searching, so by hls.js's retry its misses have judged the source.
    await rig.time.runUntil(JOIN_AT_MS + 100_000);
    assert.equal(rig.fetcher.startsSlowly(), true);

    const retry = rig.fetcher.fetch(RUNG_URL).then(
      () => null,
      (error: unknown) => error,
    );
    const error = await rig.time.runToCompletion(retry, 300_000);

    assert.ok(error instanceof RungNotReadyError, `expected a failed level, got ${String(error)}`);
    assert.equal(error.deadlineMs, 125_000);
    assert.equal(rig.windows.at(-1), 30_000);
  });
});
