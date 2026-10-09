import { Topic } from '@ethersphere/bee-js';
import {
  buildMasterPlaylist,
  ladderMarkerIdentifier,
  markerPeriodAt,
  markerPeriodStartMs,
  type Rendition,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'vitest';

import {
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FeedHealthTracker,
} from '../src/components/SwarmHlsPlayer/feedState';
import { ManifestFetcher, ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { RequestJitter } from '../src/utils/requestJitter';

import { slotPathsOf } from './helpers/slotPaths';
import { waitFor } from './helpers/waiting';
import { segmentsUnder, swarmOverGlobalFetch } from './helpers/playerReader';

/**
 * The ladder entry points, which arrived with the ABR merge carrying no tests at all.
 *
 * `fetchSource` is the one hls.js calls from `loadSource`, so once a stream can be a ladder it is the
 * read every mount makes and every restart comes back through. That makes it the place a gateway
 * outage is met, which is why the guards asserted below belong to it and not only to
 * `handleInitialFetch` — the path it replaced on this route.
 */

const BEE_URL = 'http://bee.test';
const OWNER = '0x2222222222222222222222222222222222222222';
const SOURCE_TOPIC = 'ladder-source';
const NO_JITTER = new RequestJitter(0, () => 0);
/** Short enough that a rung's first read lands inside a test, long enough not to spin. */
const POLL_MS = 2;

const sourceTopic = Topic.fromString(SOURCE_TOPIC);
const hexSource = sourceTopic.toString();

function rung(name: string, width: number, height: number, bandwidth: number): Rendition {
  return { name, width, height, topic: `rung-${name}`, bandwidth, avgBandwidth: bandwidth };
}

const LADDER = [rung('360p', 640, 360, 700_000), rung('720p', 1280, 720, 2_800_000)];
const RUNG_TOPICS = LADDER.map((r) => Topic.fromString(r.topic).toString());
const FOUR = [
  rung('360p', 640, 360, 700_000),
  rung('480p', 854, 480, 1_400_000),
  rung('720p', 1280, 720, 2_800_000),
  rung('1080p', 1920, 1080, 5_000_000),
];
const FOUR_TOPICS = FOUR.map((r) => Topic.fromString(r.topic).toString());

/** Every rung's newest slot. The rungs are read by index, so each holds slots 0 to this one. */
const RUNG_HEAD = 3;
const rungSlots = slotPathsOf(
  OWNER,
  [...LADDER, ...FOUR].map((r) => Topic.fromString(r.topic)),
);

/** The rung a read was for, by hex topic, or null for any other read. */
function rungOf(path: string): string | null {
  return rungSlots.get(path)?.hex ?? null;
}

/** The slot path of a rung's index. */
function slotPathOf(hex: string, index: number): string {
  return [...rungSlots].find(([, slot]) => slot.hex === hex && slot.index === index)![0];
}

function mediaPlaylist(segment: string): string {
  return ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', segment].join('\n');
}

/** A feed read carrying the index header the fetcher takes its next position from. */
function feedResponse(body: string, index = 3n): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Swarm-Feed-Index': index.toString(16).padStart(16, '0') },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function settle(ticks = 30): Promise<void> {
  for (let tick = 0; tick < ticks; tick++) {
    await sleep(0);
  }
}

const manager = ManifestStateManager.getInstance();
const realFetch = globalThis.fetch;
const realConsoleLog = console.log;
const realConsoleError = console.error;

describe('the ladder entry points', () => {
  let fetcher: ManifestFetcher;
  let health: FeedHealthTracker;
  let requested: string[];

  beforeEach(() => {
    manager.clear();
    health = new FeedHealthTracker();
    fetcher = new ManifestFetcher(manager, health, undefined, NO_JITTER, POLL_MS);
    fetcher.useSwarm(swarmOverGlobalFetch(BEE_URL));
    requested = [];
    // The master is logged once per session, deliberately, and it is not what any of these assert.
    console.log = () => {};
  });

  afterEach(() => {
    fetcher.unregisterLadder(`${OWNER}/${SOURCE_TOPIC}`);
    globalThis.fetch = realFetch;
    console.log = realConsoleLog;
    console.error = realConsoleError;
  });

  /** Answers the source feed with `sourceBody` and every rung slot up to {@link RUNG_HEAD} with `rungBody`. */
  function stubFetch(sourceBody: string, rungBody = mediaPlaylist('rung-seg.ts')): void {
    globalThis.fetch = (async (url: string) => {
      const path = url.replace(`${BEE_URL}/`, '');
      requested.push(path);

      if (path === `feeds/${OWNER}/${hexSource}`) {
        return feedResponse(sourceBody);
      }
      const slot = rungSlots.get(path);
      if (slot && slot.index <= RUNG_HEAD) {
        return new Response(rungBody, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  describe('a published master', () => {
    it('is returned as it stands, because the uploader is the authority on its own ladder', async () => {
      const master = buildMasterPlaylist(OWNER, LADDER);
      stubFetch(master);

      assert.equal(await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`), master);
    });

    it('registers every rung it names and reads none of them before hls.js asks for one', async () => {
      stubFetch(buildMasterPlaylist(OWNER, LADDER));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      await settle();

      for (const hex of RUNG_TOPICS) {
        assert.ok(!requested.some((path) => rungOf(path) === hex), `rung ${hex} was read before anyone played it`);
      }
    });

    /**
     * Only the quality hls.js plays is read (Levi, 2026-10-07). A level request starts that rung, a
     * second one starts the rung switched to, and the switch reported by hls.js stops the first.
     * Counted on the requests a real fetch makes, by the rung each one names.
     */
    it('reads only the rung a level request names, and stops the old rung once the switch is reported', async () => {
      const [low, top] = RUNG_TOPICS;
      stubFetch(buildMasterPlaylist(OWNER, LADDER));
      const readsOf = (hex: string) => requested.filter((path) => rungOf(path) === hex).length;

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      await fetcher.fetch(`${OWNER}/${LADDER[1].topic}`);
      await settle();
      assert.equal(
        manager.getIndex(top)?.toBigInt(),
        BigInt(RUNG_HEAD),
        'the playing rung did not start at its newest',
      );
      assert.ok(readsOf(top) > 0, 'the playing rung was not read');
      assert.equal(readsOf(low), 0, 'a rung nobody plays was read');
      assert.ok(!requested.some((path) => path.startsWith('feeds/') && path !== `feeds/${OWNER}/${hexSource}`));

      const beforeSwitch = requested.length;
      await fetcher.fetch(`${OWNER}/${LADDER[0].topic}`);
      assert.equal(manager.getIndex(low)?.toBigInt(), BigInt(RUNG_HEAD), 'the switch did not start the new rung');
      assert.equal(rungOf(requested[beforeSwitch]), low, 'the switch read something before its finder');

      fetcher.followOnlyRung(low);
      assert.equal(manager.getIndex(top), null, 'the rung switched away from kept its index');
      const afterSwitch = requested.length;
      await settle();
      assert.ok(
        requested.slice(afterSwitch).every((path) => rungOf(path) !== top),
        'the old rung was still read after the switch',
      );
    });

    it('does not ingest the master as a media playlist, which would serve zero segments', async () => {
      stubFetch(buildMasterPlaylist(OWNER, LADDER));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.equal(manager.serialize(hexSource, segmentsUnder(`${BEE_URL}/bytes`)), '');
    });

    /**
     * The overlay subscribes to the SOURCE topic, so the ended signal has to land there, not on the
     * rung topics finalization is actually read from. V5's first live run is why this is asserted at
     * this level: the poller stopped its walks on ENDLIST while the viewer stayed on `live` over a
     * frozen frame.
     */
    it('ends the source topic once the playing rung and its sibling are both finalized', async () => {
      stubFetch(buildMasterPlaylist(OWNER, LADDER), `${mediaPlaylist('rung-seg.ts')}\n#EXT-X-ENDLIST`);

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      await fetcher.fetch(`${OWNER}/${LADDER[1].topic}`);

      for (let tick = 0; tick < 200 && health.state(hexSource) !== FEED_STATE_ENDED; tick++) {
        await settle(1);
      }
      assert.equal(health.state(hexSource), FEED_STATE_ENDED);
    });

    /**
     * The rung that was playing watches for its broadcaster, and every wait it takes is drawn through
     * this fetcher's own jitter, as the single rendition's is. Counted through the jitter's source:
     * nothing else here draws from it, since there is no stagger bound and no backoff to spread.
     */
    it('draws the wait before every ask of the finished rung through the jitter the fetcher was built with', async () => {
      const WATCH_MS = 5;
      let draws = 0;
      const counting = new RequestJitter(0, () => {
        draws += 1;
        return 0;
      });
      const watching = new ManifestFetcher(manager, health, undefined, counting, POLL_MS, WATCH_MS);
      watching.useSwarm(swarmOverGlobalFetch(BEE_URL));
      stubFetch(buildMasterPlaylist(OWNER, LADDER), `${mediaPlaylist('rung-seg.ts')}\n#EXT-X-ENDLIST`);
      // The watch asks for the slot after the finished one, which the search for the newest index also
      // read, so only the asks made once the end is recorded are the watch's.
      const watched = slotPathOf(RUNG_TOPICS[1], RUNG_HEAD + 1);
      let readBeforeTheEnd = 0;
      const asks = () => requested.filter((path) => path === watched).length - readBeforeTheEnd;

      try {
        await watching.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
        await watching.fetch(`${OWNER}/${LADDER[1].topic}`);
        await waitFor(() => health.state(hexSource) === FEED_STATE_ENDED, 'the broadcast to end', 5_000);
        readBeforeTheEnd = asks();
        await waitFor(() => asks() >= 3, 'the finished rung to ask three times', 5_000);

        const asked = asks();
        assert.ok(asked >= 3, `the finished rung asked ${asked} times`);
        // One draw per ask, plus one for a wait in progress when this reads.
        assert.ok(
          draws >= asked && draws <= asked + 1,
          `${draws} waits were drawn through the fetcher for ${asked} asks`,
        );
      } finally {
        watching.unregisterLadder(`${OWNER}/${SOURCE_TOPIC}`);
      }
    });
  });

  /**
   * Decision 33 (Levi, 2026-10-07): a stream whose entry in the stream list names its renditions is
   * answered with the master built from them, and the master feed is not read at all. That read was
   * the slowest at start, 4.2 to 4.7 s in phase 0, a head lookup of the master topic.
   */
  describe('a stream list entry that names its renditions', () => {
    it('is answered with the master built from the list, reading nothing, and the first read is the start rung', async () => {
      stubFetch(buildMasterPlaylist(OWNER, FOUR));
      fetcher.registerLadder(`${OWNER}/${SOURCE_TOPIC}`, () => ({ owner: OWNER, renditions: FOUR }));

      const master = await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      assert.equal(master, buildMasterPlaylist(OWNER, FOUR));
      assert.deepEqual(requested, [], 'starting playback read something before hls.js asked for a level');

      await fetcher.fetch(`${OWNER}/${FOUR[3].topic}`);
      // Before it, the ladder's time markers are asked for, which this stub does not hold.
      const firstRungRead = requested.findIndex((path) => rungOf(path) !== null);
      assert.equal(rungOf(requested[firstRungRead]), FOUR_TOPICS[3], 'the first read was not the start rung');
      assert.ok(firstRungRead <= 2, `${firstRungRead} reads came before the start rung's, more than two markers`);
      assert.ok(!requested.includes(`feeds/${OWNER}/${hexSource}`), 'the master topic was read');
    });

    it('keeps the source read for an entry that names no renditions', async () => {
      stubFetch(buildMasterPlaylist(OWNER, LADDER));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.deepEqual(requested, [`feeds/${OWNER}/${hexSource}`]);
    });
  });

  /**
   * Architecture review 2026-10-08, P2 #7. The entry turns live after the first quality reports to the
   * admin, and the others report a moment later, up to about 20 s when an encoder reconnects. A viewer
   * who joins in that moment is handed an entry naming only the qualities reported so far, and the
   * master is built from it once. The ladder's time marker names every rung that has published, so it
   * is what says the entry was short.
   */
  describe('an entry that joined before every quality had reported', () => {
    /** Answers the stub's feeds as {@link stubFetch} does, and the ladder's recent markers naming `rungs`. */
    function stubFetchWithMarker(rungs: string[]): void {
      stubFetch(buildMasterPlaylist(OWNER, FOUR));
      const feeds = globalThis.fetch;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const path = url.replace(`${BEE_URL}/`, '');
        const period = markerPeriodAt(Date.now());
        for (const wanted of [period - 1, period - 2]) {
          if (path.startsWith('soc/') && path.endsWith(ladderMarkerIdentifier(sourceTopic, wanted).toHex())) {
            requested.push(path);
            const marker = {
              v: 2,
              period: wanted,
              segmentMs: 2_000,
              writtenAt: markerPeriodStartMs(wanted) + 1,
              rungs: Object.fromEntries(rungs.map((hex) => [hex, RUNG_HEAD])),
            };
            return new Response(JSON.stringify(marker), { status: 200 });
          }
        }
        return feeds(url, init);
      }) as typeof fetch;
    }

    /** Starts the watch on what the list names now, and stops it once the start check has answered. */
    async function shortSaidAtStart(listed: Rendition[]): Promise<number> {
      let said = 0;
      const stop = fetcher.watchLadderCompletion(
        `${OWNER}/${SOURCE_TOPIC}`,
        OWNER,
        () => listed.map((r) => Topic.fromString(r.topic).toString()),
        () => said++,
      );
      await settle();
      stop();
      return said;
    }

    it('says the entry is short at the start when the marker names rungs it lacks', async () => {
      stubFetchWithMarker(FOUR_TOPICS);

      assert.equal(await shortSaidAtStart([FOUR[0]]), 1);
    });

    /**
     * A page may start the player on the stream's first marker before the list names any rendition,
     * and such an entry is short in the same way.
     */
    it('says an entry naming no rendition is short when the marker names rungs', async () => {
      stubFetchWithMarker(FOUR_TOPICS);

      assert.equal(await shortSaidAtStart([]), 1);
    });

    it('reads the marker once for the start check and for the start rung together', async () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      stubFetchWithMarker(FOUR_TOPICS);
      fetcher.registerLadder(source, () => ({ owner: OWNER, renditions: [FOUR[0]] }));
      await fetcher.fetchSource(source);

      const stop = fetcher.watchLadderCompletion(
        source,
        OWNER,
        () => [FOUR_TOPICS[0]],
        () => {},
      );
      await fetcher.fetch(`${OWNER}/${FOUR[0].topic}`);
      stop();

      // A rung that has caught up waits on later markers, so only the reads before its first slot count.
      const firstRungRead = requested.findIndex((path) => rungOf(path) !== null);
      const atStart = requested.slice(0, firstRungRead).filter((path) => path.startsWith('soc/'));
      assert.equal(atStart.length, 1, `the marker was read ${atStart.length} times before the start rung`);
    });

    it('says nothing when the entry already has every rung the marker names', async () => {
      stubFetchWithMarker(FOUR_TOPICS);

      assert.equal(await shortSaidAtStart(FOUR), 0);
    });

    it('says nothing when the stream has no marker, so a stream without them plays as before', async () => {
      stubFetch(buildMasterPlaylist(OWNER, FOUR));

      assert.equal(await shortSaidAtStart([]), 0);
    });
  });

  describe('a catalog entry written before masters were published', () => {
    it('is answered with a locally built master, so it plays as a ladder rather than one rung', async () => {
      stubFetch(mediaPlaylist('lowest-rung-seg.ts'));
      fetcher.registerLadder(`${OWNER}/${SOURCE_TOPIC}`, () => ({ owner: OWNER, renditions: LADDER }));

      assert.equal(await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`), buildMasterPlaylist(OWNER, LADDER));
    });

    it('has no master to synthesise once the ladder is unregistered', async () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      fetcher.registerLadder(source, () => ({ owner: OWNER, renditions: LADDER }));
      assert.ok(fetcher.masterFor(source));

      fetcher.unregisterLadder(source);

      assert.equal(fetcher.masterFor(source), null);
    });

    it('is not a ladder when the resolver has no rungs, so a single-rendition stream is left alone', () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      fetcher.registerLadder(source, () => ({ owner: OWNER, renditions: [] }));

      assert.equal(fetcher.masterFor(source), null);
    });
  });

  describe('a single-rendition stream', () => {
    it('is ingested from the read that identified it, rather than fetched a second time', async () => {
      stubFetch(mediaPlaylist('only-seg.ts'));

      const manifest = await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.match(manifest, /only-seg\.ts/);
      assert.deepEqual(requested, [`feeds/${OWNER}/${hexSource}`], 'the head was read twice for one playlist');
    });

    it('commits the index the gateway resolved, so the next poll follows on rather than resyncing', async () => {
      stubFetch(mediaPlaylist('only-seg.ts'));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.equal(manager.getIndex(hexSource)?.toBigInt(), 3n);
    });
  });

  /**
   * The guards `handleInitialFetch` documents at length. `fetchSource` is the same kind of read and
   * had none of them: a gateway outage was an unbounded restart loop with no backoff accumulating and
   * nothing for the overlay to report.
   */
  describe('the guards a head read needs', () => {
    it('records the gateway as failing when it does not answer', async () => {
      console.error = () => {};
      globalThis.fetch = (async () => new Response('gone', { status: 502 })) as typeof fetch;

      await assert.rejects(fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`));

      assert.equal(health.state(hexSource), FEED_STATE_RECONNECTING);
      assert.ok(health.backoffRemainingMs(hexSource) > 0, 'nothing would hold the restart loop off');
    });

    it('records it as reachable once it answers, so the overlay does not stay on reconnecting', async () => {
      stubFetch(buildMasterPlaylist(OWNER, LADDER));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.equal(health.state(hexSource), FEED_STATE_LIVE);
    });

    it('waits out the backoff a failing gateway earned, rather than asking again at once', async () => {
      const waited: number[] = [];
      const waiting = new ManifestFetcher(
        manager,
        health,
        async (ms) => {
          waited.push(ms);
        },
        NO_JITTER,
        POLL_MS,
      );
      waiting.useSwarm(swarmOverGlobalFetch(BEE_URL));
      health.recordGatewayFailure(hexSource);
      // Read before the call, because a successful read clears the backoff: comparing afterwards
      // would be comparing against zero. Bounded rather than equal, because the tracker returns the
      // time *remaining*, which decays between this read and the one inside the fetcher.
      const owed = health.backoffRemainingMs(hexSource);
      assert.ok(owed > 0, 'one recorded failure has to owe a wait, or this test asserts nothing');
      stubFetch(mediaPlaylist('after-the-wait.ts'));

      await waiting.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.equal(waited.length, 1, 'the wait has to happen exactly once per attempt');
      assert.ok(waited[0] > owed / 2 && waited[0] <= owed, `waited ${waited[0]}ms against ${owed}ms owed`);
    });

    it('does not resurrect a topic torn down while the head read was in flight', async () => {
      const gate = deferred<void>();
      globalThis.fetch = (async () => {
        await gate.promise;
        return feedResponse(mediaPlaylist('landed-too-late.ts'));
      }) as typeof fetch;

      const pending = fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      manager.clear(hexSource);
      gate.resolve();

      await assert.rejects(pending, /torn down/);
      assert.equal(manager.getIndex(hexSource), null, 'a cleared topic came back at a pre-teardown index');
      assert.equal(manager.serialize(hexSource, segmentsUnder(`${BEE_URL}/bytes`)), '');
    });

    it('does not start four rung pollers when a master lands after the topic was torn down', async () => {
      // The master branch of the same race. `startVariants` starts all four rung walks, and their only
      // stopper is `unregisterLadder`, which the teardown already ran against no rungs. Without the
      // guard the late master both resolves the read and leaves four orphan walks that nothing stops.
      const gate = deferred<void>();
      globalThis.fetch = (async (url: string) => {
        const path = url.replace(`${BEE_URL}/`, '');
        requested.push(path);
        await gate.promise;
        return feedResponse(buildMasterPlaylist(OWNER, LADDER));
      }) as typeof fetch;

      const pending = fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      manager.clear(hexSource);
      gate.resolve();

      await assert.rejects(pending, /torn down/);
      await settle();

      for (const hex of RUNG_TOPICS) {
        assert.ok(
          !requested.some((path) => rungOf(path) === hex),
          `rung ${hex} was walked after teardown, so a torn-down player left an orphan poller running`,
        );
      }
    });

    it('refuses a 200 whose body is not a playlist, rather than answering with an empty string', async () => {
      console.error = () => {};
      stubFetch('<html>captive portal</html>');

      await assert.rejects(fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`));

      assert.equal(health.state(hexSource), FEED_STATE_RECONNECTING);
    });
  });

  describe('unregistering a ladder', () => {
    it('discards every rung playlist, so the next session does not resume this one', async () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      stubFetch(buildMasterPlaylist(OWNER, LADDER));
      await fetcher.fetchSource(source);
      await fetcher.fetch(`${OWNER}/${LADDER[1].topic}`);
      await settle();
      assert.ok(
        RUNG_TOPICS.some((hex) => manager.serialize(hex, segmentsUnder(`${BEE_URL}/bytes`)) !== ''),
        'no rung accumulated a playlist, so this test cannot show one being cleared',
      );

      fetcher.unregisterLadder(source);

      for (const hex of RUNG_TOPICS) {
        assert.equal(manager.serialize(hex, segmentsUnder(`${BEE_URL}/bytes`)), '', `rung ${hex} kept its playlist`);
      }
    });

    /** The rung the player was following stops with the ladder, and nothing is read afterwards. */
    it('stops the rung the player was following, so nothing is read after the teardown', async () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      stubFetch(buildMasterPlaylist(OWNER, LADDER));
      fetcher.registerLadder(source, () => ({ owner: OWNER, renditions: LADDER }));
      await fetcher.fetchSource(source);
      await fetcher.fetch(`${OWNER}/${LADDER[1].topic}`);
      await settle();

      fetcher.unregisterLadder(source);
      const stillRunning = requested.length;
      await settle();

      assert.equal(requested.length, stillRunning, 'a rung kept polling after its player was torn down');
    });

    it('is safe on a source that was never registered, since teardown runs on every unmount', () => {
      assert.doesNotThrow(() => fetcher.unregisterLadder('never/registered'));
    });
  });
});
