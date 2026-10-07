import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { makeFeedIdentifier } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeEach, describe, it } from 'vitest';

import {
  backoffDelayMs,
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  FeedHealthTracker,
  FeedState,
  UNSERVED_SLOT_STALL_MS,
} from '../src/components/SwarmHlsPlayer/feedState.js';
import { LadderFeedPoller } from '../src/components/SwarmHlsPlayer/LadderFeedPoller.js';
import { ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement.js';
import type { PlayerReader } from '../src/components/SwarmHlsPlayer/playerReads.js';
import { parseManifest } from '../src/components/SwarmHlsPlayer/playlist.js';
import { ManifestFetchError } from '../src/components/SwarmHlsPlayer/refusedSlot.js';
import type { PathResponse } from './helpers/playerReader';
import { RequestJitter } from '../src/utils/requestJitter.js';

import { fastClock } from './helpers/fastClock.js';
import { headLookupFinder } from './helpers/headLookupFinder.js';
import { readerOverPaths } from './helpers/playerReader.js';
import { waitFor } from './helpers/waiting.js';
import { SEGMENTS_AS_WRITTEN } from '../src/components/SwarmHlsPlayer/ManifestManagement';

const OWNER = 'aabbcc';
const POLL_MS = 2;

/** Far enough down the schedule that the doubling has flattened, whatever the cap is set to. */
const SETTLED_SCHEDULE_ATTEMPT = 32;

/** A cumulative live manifest, the shape the uploader publishes at each feed index. */
function manifest(segments: number, finalized = false): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < segments; i++) {
    lines.push('#EXTINF:1.5,', `ref-${i}`);
  }
  if (finalized) {
    lines.push('#EXT-X-ENDLIST');
  }
  return lines.join('\n');
}

function socPath(topic: Topic, index: number): string {
  return `soc/${OWNER}/${makeFeedIdentifier(topic, FeedIndex.fromBigInt(BigInt(index))).toString()}`;
}

function feedHeadPath(topic: Topic): string {
  return `feeds/${OWNER}/${topic.toString()}`;
}

/**
 * Serves whatever has been published so far and 404s the rest, which is exactly how a feed behaves
 * while a stream is running: the next index does not exist yet, and then it does.
 */
class FakeGateway {
  public readonly responses = new Map<string, string>();
  public readonly requests: string[] = [];
  /** Reproduces a proxy that drops the `swarm-feed-index` header, so a head lookup carries no index. */
  public stripFeedIndexHeader = false;
  /**
   * Status a missing path is refused with. Set to 404 to model a slot the publisher has not written
   * yet, the way the real fetcher does. Left undefined it throws a transport-style error, which is a
   * gateway that is not answering at all.
   */
  public missingSlotStatus?: number;
  /**
   * Feed head paths the gateway will not answer at all, whatever is published against them.
   *
   * Models the case the sibling release exists for, one rung failing while another is being served,
   * which `missingSlotStatus` cannot express because it is a property of the gateway rather than of
   * a feed. Only the head path is refusable, and only the head path is needed: a rung refused here
   * never bootstraps, so it never asks for anything else.
   */
  public readonly unreachableHeads = new Set<string>();

  private readonly held = new Map<string, Promise<void>>();

  publishFeedHead(topic: Topic, index: number, body: string): void {
    this.responses.set(feedHeadPath(topic), body);
    this.responses.set(`__index__${topic.toString()}`, index.toString(16));
  }

  publishSoc(topic: Topic, index: number, body: string): void {
    this.responses.set(socPath(topic, index), body);
  }

  /** Blocks one path until the returned function is called, to pin a request in flight. */
  hold(path: string): () => void {
    let release = () => {};
    this.held.set(
      path,
      new Promise<void>((resolve) => {
        release = () => {
          this.held.delete(path);
          resolve();
        };
      }),
    );
    return () => release();
  }

  /** The player's reads, answered by {@link answerPath}. */
  readonly reader: PlayerReader = readerOverPaths((path) => this.answerPath(path));

  /** Answers one Bee path, as the gateway the player's reads are asked of. */
  answerPath = async (path: string): Promise<PathResponse> => {
    this.requests.push(path);

    const blocked = this.held.get(path);
    if (blocked) {
      await blocked;
    }

    if (this.unreachableHeads.has(path)) {
      throw new Error(`Failed to fetch: ${path}`);
    }

    const body = this.responses.get(path);
    if (body === undefined) {
      if (this.missingSlotStatus !== undefined) {
        throw new ManifestFetchError(path, this.missingSlotStatus);
      }
      throw new Error(`Failed to fetch: ${path}`);
    }

    const headers = new Headers();
    const feedMatch = /^feeds\/[^/]+\/(.+)$/.exec(path);
    if (feedMatch && !this.stripFeedIndexHeader) {
      headers.set('Swarm-Feed-Index', this.responses.get(`__index__${feedMatch[1]}`) ?? '0');
    }

    return { ok: true, status: 200, headers, text: body };
  };
}

/**
 * The poller with its follower on a clock a test can outrun, and finding a rung through the fake's feed
 * head, since this file is about the walk once a rung is found rather than about the search.
 */
class FastPoller extends LadderFeedPoller {
  constructor(
    ...[state, fetch, interval, health, backoff, returnWait, options]: ConstructorParameters<typeof LadderFeedPoller>
  ) {
    super(state, fetch, interval, health, backoff, returnWait, {
      followClock: fastClock(),
      finder: headLookupFinder(fetch),
      ...options,
    });
  }
}

/**
 * Registers these rungs and follows every one of them, which is the shape of a switch under way: the
 * rung playing and the rung being switched to. The first one named becomes the playing rung.
 */
function follow(poller: LadderFeedPoller, owner: string, topics: Topic[], group: string | null = null): void {
  poller.register(
    owner,
    topics.map((topic) => ({ topic })),
    group,
  );
  for (const topic of topics) {
    poller.activate(topic.toString());
  }
}

function segmentCount(state: ManifestStateManager, topic: Topic): number {
  const serialized = state.serialize(topic.toString(), SEGMENTS_AS_WRITTEN);
  return serialized ? parseManifest(serialized).segments.length : 0;
}

describe('LadderFeedPoller', () => {
  let state: ManifestStateManager;

  beforeEach(() => {
    state = ManifestStateManager.getInstance();
    state.clear();
  });

  it('bootstraps at the feed head and then walks forward one index at a time', async () => {
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));
    gateway.publishSoc(topic, 1, manifest(2));
    gateway.publishSoc(topic, 2, manifest(3));

    const poller = new FastPoller(state, gateway.reader, POLL_MS);
    follow(poller, OWNER, [topic]);

    try {
      await waitFor(() => segmentCount(state, topic) === 3, 'three segments');
      assert.equal(state.getIndex(topic.toString())?.toBigInt(), 2n);
    } finally {
      poller.unregister([topic]);
    }
  });

  it('consumes a backlog in one pass rather than one index per playlist refresh', async () => {
    // The reason this exists: a rung nobody is playing still has to reach the live edge, and
    // walking it at hls.js's refresh rate would take minutes.
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));
    for (let i = 1; i <= 20; i++) {
      gateway.publishSoc(topic, i, manifest(i + 1));
    }

    const poller = new FastPoller(state, gateway.reader, 10_000);
    follow(poller, OWNER, [topic]);

    try {
      // A 10s poll interval means a second pass cannot have happened: everything below was
      // consumed by the first one.
      await waitFor(() => segmentCount(state, topic) === 21, 'the whole backlog');
    } finally {
      poller.unregister([topic]);
    }
  });

  it('walks only the rung it was asked to follow, of every rung registered', async () => {
    const topics = ['group-1-360p', 'group-1-720p', 'group-1-1080p'].map((t) => Topic.fromString(t));
    const gateway = new FakeGateway();
    for (const topic of topics) {
      gateway.publishFeedHead(topic, 0, manifest(1));
      gateway.publishSoc(topic, 1, manifest(2));
    }

    const poller = new FastPoller(state, gateway.reader, POLL_MS);
    poller.register(
      OWNER,
      topics.map((topic) => ({ topic })),
      null,
    );
    poller.activate(topics[2].toString());

    try {
      await waitFor(() => segmentCount(state, topics[2]) === 2, 'the followed rung at index 1');
      await sleep(20);
      const unfollowed = topics
        .slice(0, 2)
        .flatMap((topic) => [feedHeadPath(topic), socPath(topic, 1), socPath(topic, 2)]);
      assert.deepEqual(
        gateway.requests.filter((path) => unfollowed.includes(path)),
        [],
        'a rung nobody plays was read',
      );
    } finally {
      poller.unregister(topics);
    }
  });

  /**
   * What remains after ENDLIST is the watch for the broadcaster coming back, which asks once per
   * `FEED_RETURN_WATCH_INTERVAL_MS` rather than once per poll. That interval is thirty seconds here,
   * so nothing it asks can land inside this test.
   */
  it('stops walking a rung once its playlist is finalized', async () => {
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));
    gateway.publishSoc(topic, 1, manifest(2, true));

    const poller = new FastPoller(state, gateway.reader, POLL_MS);
    follow(poller, OWNER, [topic]);

    try {
      await waitFor(() => segmentCount(state, topic) === 2, 'the final playlist');
      await sleep(20);

      const afterStop = gateway.requests.length;
      await sleep(20);
      assert.equal(gateway.requests.length, afterStop, 'a finished rung was still polled at the live cadence');
    } finally {
      poller.unregister([topic]);
    }
  });

  /**
   * The ended overlay listens on the GROUP topic, and the poller follows one rung. So the end is the
   * playing rung's ENDLIST, confirmed by one sibling, and recorded against the group. Without that
   * bridge the broadcast finalized as a VOD while the viewer sat on `live` over a frozen frame.
   */
  describe('telling the viewer the broadcast ended', () => {
    const groupHex = Topic.fromString('group-1').toString();

    it('records ended on the group once the playing rung finished and its sibling has too', async () => {
      const [playing, sibling] = ['group-1-720p', 'group-1-360p'].map((t) => Topic.fromString(t));
      const gateway = new FakeGateway();
      const tracker = new FeedHealthTracker();
      gateway.publishFeedHead(playing, 0, manifest(1));
      gateway.publishSoc(playing, 1, manifest(2, true));
      gateway.publishFeedHead(sibling, 4, manifest(2, true));

      const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
      poller.register(
        OWNER,
        [
          { topic: sibling, bandwidth: 1 },
          { topic: playing, bandwidth: 2 },
        ],
        groupHex,
      );
      poller.activate(playing.toString());

      try {
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the group to end');
      } finally {
        poller.unregister([playing, sibling]);
      }
    });

    /**
     * A finished rung beside a sibling that still publishes is a rung retired, not a broadcast over.
     * The uploader finishes a ladder without a rung whose stop failed, and that mark lives in the
     * catalog, which this poller never reads.
     */
    it('does not record ended while the sibling still publishes, and fails over to it instead', async () => {
      const [finished, live] = ['group-1-720p', 'group-1-360p'].map((t) => Topic.fromString(t));
      const gateway = new FakeGateway();
      const tracker = new FeedHealthTracker();
      const stopped: string[] = [];
      tracker.onRungStopped((rung) => stopped.push(rung));
      gateway.missingSlotStatus = 404;
      gateway.publishFeedHead(finished, 0, manifest(2, true));
      gateway.publishFeedHead(live, 0, manifest(1));
      gateway.publishSoc(live, 1, manifest(2));

      const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker, undefined, undefined, {
        progressBoundMs: 2_000,
      });
      poller.register(
        OWNER,
        [
          { topic: live, bandwidth: 1 },
          { topic: finished, bandwidth: 2 },
        ],
        groupHex,
      );
      poller.activate(finished.toString());

      try {
        // The sibling is watched for the whole bound before it counts as carrying on.
        await waitFor(() => stopped.length > 0, 'the finished rung to be failed over', 4_000);

        assert.deepEqual(stopped, [finished.toString()]);
        assert.equal(tracker.state(groupHex), FEED_STATE_LIVE);
      } finally {
        poller.unregister([finished, live]);
      }
    });

    it('records nothing when the walk was started without a group', async () => {
      const topic = Topic.fromString('group-1-360p');
      const gateway = new FakeGateway();
      const tracker = new FeedHealthTracker();
      gateway.publishFeedHead(topic, 0, manifest(2, true));

      const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
      follow(poller, OWNER, [topic]);

      try {
        await waitFor(() => segmentCount(state, topic) === 2, 'the finalized rung read');
        await sleep(20);

        assert.equal(tracker.state(groupHex), FEED_STATE_LIVE);
      } finally {
        poller.unregister([topic]);
      }
    });
  });

  /**
   * ⛔⛔ **A finished ladder is not necessarily over.** Live, 2026-09-24: a declared stream's encoder
   * dropped for longer than the reconnect window, the uploader finalized all four rungs at 18:41:57
   * UTC, and the broadcaster came back at 18:43:18 with every rung resuming its feed at the next
   * index. The viewer who had watched it end sat on "This broadcast has ended" for more than fifteen
   * minutes, because this walk stopped on ENDLIST for good. A viewer who opened the page afterwards
   * played the broadcast live.
   */
  describe('watching a finished ladder for its broadcaster coming back', () => {
    const groupHex = Topic.fromString('group-1').toString();
    const RUNGS = ['group-1-360p', 'group-1-720p'].map((name) => Topic.fromString(name));
    /** Where the uploader wrote each rung's finished playlist. */
    const FINISHED_AT = 1;
    /** Short enough that several watches land inside a test, and still five polls long. */
    const WATCH_MS = 10;

    /** A ladder the uploader has closed, with nothing written after the finished playlists yet. */
    function finishedLadder(): FakeGateway {
      const gateway = new FakeGateway();
      gateway.missingSlotStatus = 404;
      for (const topic of RUNGS) {
        gateway.publishFeedHead(topic, 0, manifest(1));
        gateway.publishSoc(topic, FINISHED_AT, manifest(2, true));
      }
      return gateway;
    }

    /** Every rung writing `body` at `index`, the way the uploader resumes a declared stream's rungs. */
    function publishOnEveryRung(gateway: FakeGateway, index: number, body: string): void {
      for (const topic of RUNGS) {
        gateway.publishSoc(topic, index, body);
      }
    }

    function makeWatchedTracker() {
      const tracker = new FeedHealthTracker();
      const resumed: string[] = [];
      tracker.onFeedResumed((topicId) => resumed.push(topicId));
      return { tracker, resumed };
    }

    /** The rung the viewer plays. The other is its lower sibling, read once to confirm an end. */
    const PLAYING = RUNGS[1];

    /**
     * A poller playing {@link PLAYING} with no backoff, whose finished rung asks every
     * {@link WATCH_MS}, and whose sibling is given a short bound to show progress in.
     */
    function watchingPoller(gateway: FakeGateway, tracker: FeedHealthTracker): LadderFeedPoller {
      const poller = new FastPoller(
        state,
        gateway.reader,
        POLL_MS,
        tracker,
        () => 0,
        () => WATCH_MS,
        { progressBoundMs: 30 },
      );
      poller.register(
        OWNER,
        RUNGS.map((topic, rank) => ({ topic, bandwidth: rank })),
        groupHex,
      );
      poller.activate(PLAYING.toString());
      return poller;
    }

    it('reports the broadcast back once the slot after the finished playlist holds an open one', async () => {
      const gateway = finishedLadder();
      const { tracker, resumed } = makeWatchedTracker();
      const poller = watchingPoller(gateway, tracker);

      try {
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the ladder to end');

        publishOnEveryRung(gateway, FINISHED_AT + 1, manifest(3));

        await waitFor(() => tracker.state(groupHex) === FEED_STATE_LIVE, 'the ladder to come back');
        assert.ok(resumed.includes(groupHex), 'the group, which is the topic a player listens on, was never told');
      } finally {
        poller.unregister(RUNGS);
      }
    });

    /**
     * The whole of a live end as a viewer on one rung lives it. The rung waits on its publisher
     * through the reconnect window, the ladder finishes, and the broadcaster comes back. The viewer is
     * told the broadcast is waiting, then that it has ended, and then nothing.
     *
     * ⛔ The viewer's rung still carried its wait from before the end, so the group used to come back
     * reading as waiting to continue.
     */
    it('comes back live for the viewer on a rung, rather than as the wait before the end', async () => {
      let clockMs = 0;
      const tracker = new FeedHealthTracker(() => clockMs);
      const seen: FeedState[] = [];
      tracker.subscribe(groupHex, (feedState) => seen.push(feedState));
      const gateway = new FakeGateway();
      gateway.missingSlotStatus = 404;
      for (const topic of RUNGS) {
        gateway.publishFeedHead(topic, 0, manifest(1));
      }
      const watchedByTheViewer = PLAYING;
      const poller = watchingPoller(gateway, tracker);

      try {
        await waitFor(
          () => tracker.unservedPollsRecorded(watchedByTheViewer.toString()) > 0,
          'the playing rung to wait on its publisher',
        );
        tracker.watchRung(groupHex, watchedByTheViewer.toString());
        clockMs += UNSERVED_SLOT_STALL_MS;
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_STALLED, 'the viewer to be told it is waiting');

        publishOnEveryRung(gateway, FINISHED_AT, manifest(2, true));
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the ladder to end');
        gateway.publishSoc(watchedByTheViewer, FINISHED_AT + 1, manifest(3));
        await waitFor(() => tracker.state(groupHex) !== FEED_STATE_ENDED, 'the ladder to come back');

        assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_STALLED, FEED_STATE_ENDED, FEED_STATE_LIVE]);
      } finally {
        poller.unregister(RUNGS);
      }
    });

    /**
     * ⛔ The tracker outlives every session on the page. A viewer who watched the ladder end, went
     * elsewhere in the app, and came back after the broadcaster returned found the end still recorded
     * against the group, because only a watch cleared it and the watch stopped with the session that
     * ran it: "This broadcast has ended" over a live picture. Two sessions on one tracker here, as the
     * page has.
     */
    it('clears an end an earlier session left once a fresh session finds the ladder live', async () => {
      const gateway = finishedLadder();
      const { tracker, resumed } = makeWatchedTracker();
      const earlier = watchingPoller(gateway, tracker);
      await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the earlier session to see the end');
      // What `unregisterLadder` does when that viewer leaves.
      earlier.unregister(RUNGS);
      for (const topic of RUNGS) {
        state.clear(topic.toString());
      }

      // The broadcaster comes back while nobody is watching.
      for (const topic of RUNGS) {
        gateway.publishFeedHead(topic, FINISHED_AT + 1, manifest(3));
      }
      const later = watchingPoller(gateway, tracker);

      try {
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_LIVE, 'the stale end to be cleared');
        assert.deepEqual(resumed, [], 'a stale end was announced as a return, which would arm a rejoin');
      } finally {
        later.unregister(RUNGS);
      }
    });

    /** The other direction: a fresh session that finds the ladder still finished keeps the end. */
    it('keeps an end an earlier session left while the ladder is still finished', async () => {
      const gateway = finishedLadder();
      const { tracker } = makeWatchedTracker();
      const earlier = watchingPoller(gateway, tracker);
      await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the earlier session to see the end');
      earlier.unregister(RUNGS);
      for (const topic of RUNGS) {
        state.clear(topic.toString());
        gateway.publishFeedHead(topic, FINISHED_AT, manifest(2, true));
      }
      const later = watchingPoller(gateway, tracker);

      try {
        await waitFor(() => segmentCount(state, PLAYING) === 2, 'the fresh session to read the finished rung');
        assert.equal(tracker.state(groupHex), FEED_STATE_ENDED);
      } finally {
        later.unregister(RUNGS);
      }
    });

    /** The viewer who opened a recording, rather than the one who watched it finish. */
    it('watches a ladder whose feeds had already finished when it was opened', async () => {
      const gateway = new FakeGateway();
      gateway.missingSlotStatus = 404;
      for (const topic of RUNGS) {
        gateway.publishFeedHead(topic, FINISHED_AT, manifest(2, true));
      }
      const { tracker, resumed } = makeWatchedTracker();
      const poller = watchingPoller(gateway, tracker);

      try {
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the recording to be read as ended');

        publishOnEveryRung(gateway, FINISHED_AT + 1, manifest(3));

        await waitFor(() => resumed.includes(groupHex), 'the broadcaster coming back to be announced');
        assert.equal(tracker.state(groupHex), FEED_STATE_LIVE);
      } finally {
        poller.unregister(RUNGS);
      }
    });

    /**
     * A finished playlist in the next slot is the broadcaster finishing again, not coming back. Taking
     * it for a return would restart a viewer into the finished recording from its first second.
     */
    it('steps past a second finished playlist rather than taking it for the broadcaster', async () => {
      const gateway = finishedLadder();
      const { tracker, resumed } = makeWatchedTracker();
      const poller = watchingPoller(gateway, tracker);

      try {
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the ladder to end');

        publishOnEveryRung(gateway, FINISHED_AT + 1, manifest(3, true));
        await waitFor(
          () => gateway.requests.includes(socPath(PLAYING, FINISHED_AT + 2)),
          'the watch to move past the second finished playlist',
        );
        assert.equal(tracker.state(groupHex), FEED_STATE_ENDED, 'a finished playlist was read as a return');
        assert.deepEqual(resumed, []);

        publishOnEveryRung(gateway, FINISHED_AT + 2, manifest(4));

        await waitFor(() => tracker.state(groupHex) === FEED_STATE_LIVE, 'the ladder to come back');
      } finally {
        poller.unregister(RUNGS);
      }
    });

    /**
     * Nothing changes for a broadcast that never comes back, and one watch asks for one slot only, on
     * the rung that was playing.
     */
    it('keeps a ladder that never comes back ended, asking only for the slot after its end', async () => {
      const gateway = finishedLadder();
      const { tracker, resumed } = makeWatchedTracker();
      const poller = watchingPoller(gateway, tracker);
      const slotsAfterTheEnd = new Set([socPath(PLAYING, FINISHED_AT + 1)]);
      const WATCHES = 3;

      try {
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the ladder to end');
        const endedAfter = gateway.requests.length;
        const watchesSinceTheEnd = () => gateway.requests.slice(endedAfter);

        await waitFor(
          () => watchesSinceTheEnd().filter((path) => slotsAfterTheEnd.has(path)).length >= WATCHES,
          'several watches on the playing rung',
        );

        assert.deepEqual(
          watchesSinceTheEnd().filter((path) => !slotsAfterTheEnd.has(path)),
          [],
          'the watch asked for something other than the slot after the end',
        );
        assert.equal(tracker.state(groupHex), FEED_STATE_ENDED);
        assert.deepEqual(resumed, []);
      } finally {
        poller.unregister(RUNGS);
      }
    });

    it('leaves nothing running once stopped during the watch', async () => {
      const gateway = finishedLadder();
      const { tracker, resumed } = makeWatchedTracker();
      const poller = watchingPoller(gateway, tracker);

      await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the ladder to end');
      poller.unregister(RUNGS);
      const stoppedAfter = gateway.requests.length;
      publishOnEveryRung(gateway, FINISHED_AT + 1, manifest(3));

      await sleep(WATCH_MS * 10);

      assert.equal(gateway.requests.length, stoppedAfter, 'a stopped ladder went on being watched');
      assert.deepEqual(resumed, [], 'a stopped watch reported the broadcaster back');
    });

    /**
     * Nothing cancels a read already in flight, so the answer to one that outlives the teardown is
     * dropped where it lands. Recorded, it would tell whichever session replaced this one that a
     * broadcaster it never watched had come back.
     */
    it('drops the answer to a watch read that lands after the teardown', async () => {
      const gateway = finishedLadder();
      const { tracker, resumed } = makeWatchedTracker();
      const rung = PLAYING;
      const heldSlot = socPath(rung, FINISHED_AT + 1);
      // Armed before the walk starts, since nothing but the watch ever asks for this slot.
      const release = gateway.hold(heldSlot);
      const poller = watchingPoller(gateway, tracker);

      await waitFor(() => gateway.requests.includes(heldSlot), 'a watch read pinned in flight');
      poller.unregister(RUNGS);
      gateway.publishSoc(rung, FINISHED_AT + 1, manifest(3));
      release();
      await sleep(WATCH_MS * 5);

      assert.deepEqual(resumed, [], 'an answer that outlived its watch was recorded');
      assert.equal(tracker.state(groupHex), FEED_STATE_ENDED);
    });
  });

  it('keeps retrying an index that has not been published yet', async () => {
    const topic = Topic.fromString('group-1-480p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));

    const poller = new FastPoller(state, gateway.reader, POLL_MS);
    follow(poller, OWNER, [topic]);

    try {
      await waitFor(() => gateway.requests.filter((p) => p.startsWith('soc/')).length >= 3, 'repeated attempts');
      assert.equal(segmentCount(state, topic), 1, 'a miss must not lose what is already there');

      // The uploader publishes the next index. The walk picks it up without being asked to.
      gateway.publishSoc(topic, 1, manifest(2));
      await waitFor(() => segmentCount(state, topic) === 2, 'the newly published index');
    } finally {
      poller.unregister([topic]);
    }
  });

  it('resolves ready() once a rung has a playlist, and on stop so nothing awaits forever', async () => {
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));

    const poller = new FastPoller(state, gateway.reader, POLL_MS);
    follow(poller, OWNER, [topic]);

    await poller.ready(topic.toString());
    assert.equal(segmentCount(state, topic), 1);

    const stalled = Topic.fromString('group-1-1080p');
    follow(poller, OWNER, [stalled]);
    const pending = poller.ready(stalled.toString());
    poller.unregister([stalled, topic]);

    await pending;
  });

  it('survives a throw that is not a failed fetch, rather than dying silently', async () => {
    // A gateway behind a proxy that strips Swarm-Feed-Index, or a truncated body, throws from
    // outside the fetch. Before this was handled, the walk's promise rejected, the rung stayed in
    // `polled` so nothing restarted it, and ready() never settled. The loader then awaited a
    // level that would never load or error.
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));
    gateway.stripFeedIndexHeader = true;

    const poller = new FastPoller(state, gateway.reader, POLL_MS);
    follow(poller, OWNER, [topic]);

    try {
      await waitFor(() => gateway.requests.length >= 3, 'the walk to keep retrying');

      gateway.stripFeedIndexHeader = false;
      gateway.publishSoc(topic, 1, manifest(2));
      await waitFor(() => segmentCount(state, topic) === 2, 'recovery once the gateway behaves');
    } finally {
      poller.unregister([topic]);
    }
  });

  it('does not write state from a response that lands after teardown', async () => {
    // The player stops the walk and clears the topic synchronously. A response still in flight
    // must not recreate that state: a resurrected index makes the next session skip bootstrap and
    // resume minutes behind live, replaying the previous session's segments.
    const topic = Topic.fromString('group-1-480p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));

    const poller = new FastPoller(state, gateway.reader, POLL_MS);
    follow(poller, OWNER, [topic]);

    await waitFor(() => state.getIndex(topic.toString()) !== null, 'bootstrap');

    // Arm the block before publishing, so the walk cannot consume index 1 before it is held,
    // otherwise there is nothing in flight at teardown and the test proves nothing.
    const held = socPath(topic, 1);
    const attemptsBeforeHold = gateway.requests.filter((p) => p === held).length;
    const release = gateway.hold(held);
    gateway.publishSoc(topic, 1, manifest(2));

    await waitFor(
      () => gateway.requests.filter((p) => p === held).length > attemptsBeforeHold,
      'a request pinned in flight',
    );

    poller.unregister([topic]);
    state.clear(topic.toString());

    release();
    await sleep(20);

    assert.equal(state.getIndex(topic.toString()), null, 'teardown must stay torn down');
    assert.equal(segmentCount(state, topic), 0);
  });

  it('reports a topic as unpolled once stopped, so the loader falls back to reading it itself', () => {
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    const poller = new FastPoller(state, gateway.reader, POLL_MS);

    assert.equal(poller.isRegistered(topic.toString()), false);

    follow(poller, OWNER, [topic]);
    assert.equal(poller.isRegistered(topic.toString()), true);

    poller.unregister([topic]);
    assert.equal(poller.isRegistered(topic.toString()), false);
  });
});

describe('LadderFeedPoller feed health', () => {
  let state: ManifestStateManager;

  beforeEach(() => {
    state = ManifestStateManager.getInstance();
    state.clear();
  });

  it('records a gateway failure and backs off when a rung read hits a real fault', async () => {
    const topic = Topic.fromString('group-1-720p');
    // Nothing published and no 404 status set, so every read throws a transport-style error: the
    // gateway is not answering, which is the outage the backoff exists for.
    const gateway = new FakeGateway();

    // Clock pinned so the backoff neither elapses nor is jittered away mid-assertion.
    const health = new FeedHealthTracker(() => 0);
    const backoffAsked: string[] = [];
    const backoffMs = (hexTopic: string): number => {
      backoffAsked.push(hexTopic);
      return health.backoffRemainingMs(hexTopic);
    };

    const poller = new FastPoller(state, gateway.reader, POLL_MS, health, backoffMs);
    follow(poller, OWNER, [topic]);

    try {
      await waitFor(
        () => health.state(topic.toString()) === FEED_STATE_RECONNECTING,
        'the rung to record its gateway down',
      );
      assert.ok(health.backoffRemainingMs(topic.toString()) > 0, 'a failing rung must earn a backoff');
      assert.ok(backoffAsked.includes(topic.toString()), 'the poller must consult the backoff before a pass');

      // The load half of the fix: a backed-off rung stops polling the dead gateway rather than
      // hammering it at the flat interval, which was around 160 requests per 30s across four rungs.
      const requestsWhileBackedOff = gateway.requests.length;
      await sleep(30);
      assert.equal(gateway.requests.length, requestsWhileBackedOff, 'a backed-off rung must stop asking');
    } finally {
      poller.unregister([topic]);
    }
  });

  it('reaches the overlay: a ladder outage a subscriber hears as reconnecting', async () => {
    const topic = Topic.fromString('group-1-1080p');
    const gateway = new FakeGateway();
    const health = new FeedHealthTracker(() => 0);

    const seen: FeedState[] = [];
    const unsubscribe = health.subscribe(topic.toString(), (feedState) => seen.push(feedState));

    // Backoff held at zero so the outage is reached quickly. This test is about the state reaching a
    // subscriber, not the pacing, which the test above covers.
    const poller = new FastPoller(state, gateway.reader, POLL_MS, health, () => 0);
    follow(poller, OWNER, [topic]);

    try {
      await waitFor(() => seen.includes(FEED_STATE_RECONNECTING), 'the overlay to hear reconnecting');
    } finally {
      poller.unregister([topic]);
      unsubscribe();
    }

    assert.equal(seen[0], FEED_STATE_LIVE, 'a fresh subscriber starts from live');
    assert.ok(seen.includes(FEED_STATE_RECONNECTING), 'a ladder outage must reach the overlay, not stay silent');
  });

  /**
   * ⭐ The measured defect. Three unrelated faults under a watching ladder viewer on 2026-08-29 each
   * froze the picture for 58.5 to 59.0 seconds, an eight second writer-bee pause included, because
   * every rung that had reached the cap was asleep on a committed timer and could not find out the
   * fault was over. The clock is frozen in both tests below, so nothing any rung is owed can elapse
   * on its own: every millisecond of recovery has to come from a sibling being served.
   */
  describe('coming back from a backoff a fault is already over', () => {
    /** Drives a rung to where the schedule flattens, the way an outage drives it. */
    function holdAtTheCap(health: FeedHealthTracker, hexTopic: string): number {
      const capMs = backoffDelayMs(SETTLED_SCHEDULE_ATTEMPT);
      while (health.backoffRemainingMs(hexTopic) < capMs) {
        health.recordGatewayFailure(hexTopic);
      }
      return capMs;
    }

    it('wakes a rung held at the cap as soon as a sibling rung is served', async () => {
      const served = Topic.fromString('group-1-360p');
      const held = Topic.fromString('group-1-1080p');
      const gateway = new FakeGateway();
      // Both rungs are serveable: the fault is over, which is the whole point. The follow-up 404 is
      // the ordinary case for a viewer who has caught up, and never a fault.
      gateway.missingSlotStatus = 404;
      gateway.publishFeedHead(served, 0, manifest(1));
      gateway.publishFeedHead(held, 0, manifest(1));

      const health = new FeedHealthTracker(() => 0);
      holdAtTheCap(health, held.toString());

      const poller = new FastPoller(state, gateway.reader, POLL_MS, health, (hexTopic) =>
        health.backoffRemainingMs(hexTopic),
      );
      follow(poller, OWNER, [served, held]);

      try {
        await waitFor(() => segmentCount(state, served) === 1, 'the sibling rung to be served');
        await waitFor(
          () => segmentCount(state, held) === 1,
          'the held rung to come back on the sibling evidence rather than on its own timer',
        );
      } finally {
        poller.unregister([served, held]);
      }
    });

    /**
     * ⛔ The trap in slicing a wait. What the poller is handed is not a deadline, it is a *fresh
     * draw*: `ManifestFetcher` wires it to `RequestJitter.spread`, which randomises a quarter off
     * the top on every call. A loop that re-reads it once per slice therefore re-rolls the dice
     * once per slice, and the separation between two viewers who lost the same gateway in the same
     * instant collapses from a quarter of the whole backoff to a quarter of one slice. That is the
     * decorrelation quietly going away while every test still passes.
     *
     * So the wait is drawn once and counted down locally, and the tracker is asked a different and
     * unjittered question each slice: not how long, but whether the hold still stands.
     */
    it('draws the spread once per backoff, not once per slice of one', async () => {
      const topic = Topic.fromString('group-1-720p');
      const gateway = new FakeGateway();
      gateway.missingSlotStatus = 404;
      gateway.publishFeedHead(topic, 0, manifest(1));

      // Frozen, so the hold stands for the whole of the wait below and nothing returns early. What
      // the poller is owed counts down separately, in real time from the poller's first ask, so both
      // shapes terminate and what separates them is how often the spread was drawn rather than
      // whether the loop ends. Counted from before the start instead, a machine slower than OWED_MS to
      // reach the first ask would owe nothing, and the spread would never be drawn.
      const health = new FeedHealthTracker(() => 0);
      health.recordGatewayFailure(topic.toString());

      let draws = 0;
      const jitter = new RequestJitter(0, () => {
        draws++;
        return 1;
      });
      const OWED_MS = 60;
      const SLICE_MS = 5;
      let startedAt: number | undefined;
      // Gated on the tracker exactly as production is, so that a hold which has been lifted owes
      // nothing and no second backoff starts. The countdown itself is independent of the tracker's
      // frozen clock, which is what lets the shape this guards against terminate and be counted
      // rather than hang.
      const owedMs = () => {
        startedAt ??= performance.now();
        return health.backoffRemainingMs(topic.toString()) === 0
          ? 0
          : Math.max(0, OWED_MS - (performance.now() - startedAt));
      };

      const poller = new FastPoller(state, gateway.reader, SLICE_MS, health, () => jitter.spread(owedMs()));
      follow(poller, OWNER, [topic]);

      try {
        await waitFor(() => segmentCount(state, topic) === 1, 'the rung to finish waiting and read');
        assert.equal(draws, 1, `the spread was drawn ${draws} times across one backoff`);
      } finally {
        poller.unregister([topic]);
      }
    });

    /**
     * The brake on the wake. Sibling evidence clears the wait but not the failure count, so a rung
     * with a fault of its own is asked again promptly and then no faster than the walk loop asks
     * anything: a rung that keeps failing beside one that keeps succeeding must cost the gateway
     * what one healthy rung costs it, not more.
     */
    it('does not ask a rung with a fault of its own more often than a healthy rung', async () => {
      const served = Topic.fromString('group-1-360p');
      const broken = Topic.fromString('group-1-1080p');
      const gateway = new FakeGateway();
      gateway.missingSlotStatus = 404;
      gateway.publishFeedHead(served, 0, manifest(1));
      gateway.publishFeedHead(broken, 0, manifest(1));
      gateway.unreachableHeads.add(feedHeadPath(broken));

      const health = new FeedHealthTracker(() => 0);
      holdAtTheCap(health, broken.toString());

      const poller = new FastPoller(state, gateway.reader, POLL_MS, health, (hexTopic) =>
        health.backoffRemainingMs(hexTopic),
      );
      follow(poller, OWNER, [served, broken]);

      try {
        await waitFor(() => segmentCount(state, served) === 1, 'the sibling rung to be served');
        const brokenAsks = () => gateway.requests.filter((path) => path === feedHeadPath(broken)).length;
        const healthyAsks = () => gateway.requests.filter((path) => path.startsWith('soc/')).length;

        // ⛔ Counted over the whole run rather than over a window opened after the first success,
        // and the reason is a property of the release rather than of the clock. Sibling evidence is
        // recorded on a served READ, and the only served read here is the head: everything after it
        // is a 404 for a slot the publisher has not written, which records nothing either way. So
        // the broken rung is released once, at that first success, and a window opened afterwards
        // can only catch it by luck. It was flaky three runs in eight measured that way.
        const WINDOW_HEALTHY_ASKS = 10;
        await waitFor(
          () => healthyAsks() >= WINDOW_HEALTHY_ASKS,
          `the healthy rung asked ${WINDOW_HEALTHY_ASKS} times`,
        );

        assert.ok(brokenAsks() > 0, 'a rung whose gateway is answering for its siblings was never re-asked');
        assert.ok(
          brokenAsks() <= healthyAsks() + 2,
          `the broken rung was asked ${brokenAsks()} times against ${healthyAsks()} for a healthy one`,
        );
      } finally {
        poller.unregister([served, broken]);
      }
    });
  });

  it('does not back off a rung that has merely caught up with the publisher', async () => {
    const topic = Topic.fromString('group-1-480p');
    const gateway = new FakeGateway();
    // The head answers, the next slot 404s: the publisher has not written it yet, the ordinary case
    // for a viewer at the live edge and never a gateway fault.
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const health = new FeedHealthTracker(() => 0);
    const poller = new FastPoller(state, gateway.reader, POLL_MS, health, () => 0);
    follow(poller, OWNER, [topic]);

    try {
      await waitFor(() => segmentCount(state, topic) === 1, 'the rung to bootstrap');
      await waitFor(() => gateway.requests.filter((p) => p.startsWith('soc/')).length >= 3, 'repeated caught-up polls');

      assert.equal(
        health.state(topic.toString()),
        FEED_STATE_LIVE,
        'a slot not written yet must not read as an outage',
      );
      assert.equal(
        health.backoffRemainingMs(topic.toString()),
        0,
        'a caught-up rung must keep polling at full cadence',
      );
    } finally {
      poller.unregister([topic]);
    }
  });
});

/**
 * ⛔ **The half of the overlay a ladder could not reach.** A viewer's gateway
 * was taken away, the picture froze for 26.6 seconds, and the client rendered nothing at all, which
 * is how it says the feed is live. The viewer was told everything was fine over a frozen frame.
 *
 * The tracker fold is tested in `feedState.test.ts`. This is the wiring, and it is the half that
 * actually failed: the fold is worth nothing unless the poller declares which rungs belong to the
 * group the overlay subscribes to.
 */
describe('LadderFeedPoller telling the viewer the gateway is gone', () => {
  const groupHex = Topic.fromString('group-1').toString();
  let state: ManifestStateManager;

  beforeEach(() => {
    state = new ManifestStateManager();
  });

  it('reports a dark gateway against the group, which is the topic the overlay watches', async () => {
    const topics = ['group-1-360p', 'group-1-720p'].map((t) => Topic.fromString(t));
    const gateway = new FakeGateway();
    const tracker = new FeedHealthTracker();
    const seen: FeedState[] = [];
    tracker.subscribe(groupHex, (feedState) => seen.push(feedState));

    const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
    follow(poller, OWNER, topics, groupHex);

    try {
      await waitFor(() => tracker.state(groupHex) === FEED_STATE_RECONNECTING, 'the group to go reconnecting');
      assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING]);
    } finally {
      poller.unregister(topics);
    }
  });

  /** A rung still being served is proof the gateway answers, so the overlay must stay down. */
  it('stays quiet while one rung is still being served', async () => {
    const served = Topic.fromString('group-1-360p');
    const dark = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    // An unwritten next slot is a 404 rather than a transport error, which is what "being served"
    // means for a viewer who has caught up with the publisher. Left as the default it would make
    // this rung a second dark one and the test would pass for the wrong reason.
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(served, 0, manifest(1));
    gateway.unreachableHeads.add(feedHeadPath(dark));

    const tracker = new FeedHealthTracker();
    const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
    follow(poller, OWNER, [served, dark], groupHex);

    try {
      await waitFor(() => tracker.state(dark.toString()) === FEED_STATE_RECONNECTING, 'the dark rung to notice');
      assert.equal(tracker.state(groupHex), FEED_STATE_LIVE);
    } finally {
      poller.unregister([served, dark]);
    }
  });

  /** A source torn down and rebuilt starts the new rungs before it stops the old ones. */
  it('keeps the membership while any rung of the group is still walking', async () => {
    const kept = Topic.fromString('group-1-360p');
    const dropped = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    const tracker = new FeedHealthTracker();

    const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
    follow(poller, OWNER, [kept, dropped], groupHex);
    poller.unregister([dropped]);

    try {
      await waitFor(() => tracker.state(groupHex) === FEED_STATE_RECONNECTING, 'the group to still be reporting');
    } finally {
      poller.unregister([kept]);
    }
  });
});

/**
 * ⛔⛔⛔ **`stalled` was dead code on every ladder broadcast.** `recordUnservedSlot` appeared zero
 * times in this file until 2026-08-29, so the counter the state reads was permanently zero and no
 * threshold could have made it fire. Sibling of the `reconnecting` fault in `feedState.test.ts`:
 * that one recorded the right thing under a name nobody read, this one never recorded it at all.
 *
 * The two are the whole difference between the faults measured live on 2026-08-29. When the
 * VIEWER's gateway dies the reads fail and the client says `reconnecting`. When the WRITER stops,
 * the viewer's gateway is healthy and simply has nothing new, which is this, and the client said
 * nothing at all for 52.9s, 53.9s and 53.8s across three separate faults.
 */
describe('LadderFeedPoller telling the viewer the publisher has gone quiet', () => {
  const groupHex = Topic.fromString('group-1').toString();
  let state: ManifestStateManager;

  beforeEach(() => {
    state = new ManifestStateManager();
  });

  it('counts a rung whose next slot is not written yet, so the state can be reached at all', async () => {
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const tracker = new FeedHealthTracker();
    const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
    follow(poller, OWNER, [topic], groupHex);

    try {
      await waitFor(() => tracker.unservedPollsRecorded(topic.toString()) > 0, 'the rung to record its unserved slot');
    } finally {
      poller.unregister([topic]);
    }
  });

  /** A 404 is the publisher being behind. It must never be counted as the gateway failing. */
  it('does not turn an unwritten slot into a gateway fault', async () => {
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const tracker = new FeedHealthTracker();
    const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
    follow(poller, OWNER, [topic], groupHex);

    try {
      await waitFor(() => tracker.unservedPollsRecorded(topic.toString()) > 2, 'a run of unserved polls to build up');
      assert.equal(tracker.state(groupHex), FEED_STATE_LIVE, 'a caught-up viewer was told something was wrong');
      assert.equal(tracker.backoffRemainingMs(topic.toString()), 0, 'a caught-up rung was backed off');
    } finally {
      poller.unregister([topic]);
    }
  });

  it('ends the run when the rung is served again', async () => {
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const tracker = new FeedHealthTracker();
    const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
    follow(poller, OWNER, [topic], groupHex);

    // A long run before the slot lands, and a generous drop after it. At this poll interval the
    // walk is back on the NEXT unwritten slot within milliseconds, so watching for the count to
    // reach exactly zero is watching for a window that closes before it can be observed.
    const LONG_RUN = 20;

    try {
      await waitFor(() => tracker.unservedPollsRecorded(topic.toString()) > LONG_RUN, 'a long run to build up');
      gateway.publishSoc(topic, 1, manifest(2));
      await waitFor(
        () => tracker.unservedPollsRecorded(topic.toString()) < LONG_RUN / 2,
        'the served slot to end the unserved run',
      );
    } finally {
      poller.unregister([topic]);
    }
  });
});

/**
 * The playing rung is judged by its own progress. Unserved for the stall threshold, the next lower
 * rung is walked as a candidate, and a new index there is what calls the playing rung dead. The
 * cases for each turn of that are in `test/oneQualityFollow.test.ts`, Q3.
 */
describe('LadderFeedPoller telling the player a rung has stopped being produced', () => {
  let state: ManifestStateManager;

  beforeEach(() => {
    state = ManifestStateManager.getInstance();
    state.clear();
  });

  const GROUP = Topic.fromString('the-broadcast-a-viewer-linked-to').toString();
  const LOWER = Topic.fromString('group-1-360p');
  const PLAYING = Topic.fromString('group-1-480p');
  const BOTH = [LOWER, PLAYING];

  function makeLadder(gateway: FakeGateway) {
    let clockMs = 0;
    const clock = { now: () => clockMs, advance: (by: number) => void (clockMs += by) };
    const feedHealth = new FeedHealthTracker(clock.now);
    const stopped: string[] = [];
    feedHealth.onRungStopped((rung) => stopped.push(rung));
    const poller = new FastPoller(state, gateway.reader, POLL_MS, feedHealth, undefined, undefined, {
      now: clock.now,
      progressBoundMs: 2_000,
    });
    poller.register(
      OWNER,
      [
        { topic: LOWER, bandwidth: 1 },
        { topic: PLAYING, bandwidth: 2 },
      ],
      GROUP,
    );
    poller.activate(PLAYING.toString());
    return { clock, feedHealth, stopped, poller };
  }

  it('announces the playing rung once it stalls while the lower rung shows a new index', async () => {
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(PLAYING, 0, manifest(1));
    gateway.publishFeedHead(LOWER, 0, manifest(1));
    const { clock, feedHealth, stopped, poller } = makeLadder(gateway);

    try {
      await waitFor(() => feedHealth.unservedPollsRecorded(PLAYING.toString()) > 0, 'the playing rung to go quiet');
      clock.advance(UNSERVED_SLOT_STALL_MS);
      await waitFor(() => poller.isActive(LOWER.toString()), 'the lower rung to be tried');
      gateway.publishSoc(LOWER, 1, manifest(2));

      await waitFor(() => stopped.length > 0, 'the playing rung to be announced');
      assert.deepEqual(stopped, [PLAYING.toString()]);
    } finally {
      poller.unregister(BOTH);
    }
  });

  /** The control: a playing rung that keeps being produced is never judged, and no sibling is read. */
  it('says nothing, and reads no sibling, while the playing rung is still being produced', async () => {
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(PLAYING, 0, manifest(1));
    gateway.publishFeedHead(LOWER, 0, manifest(1));
    const { clock, stopped, poller } = makeLadder(gateway);

    try {
      for (let index = 1; index <= 5; index++) {
        gateway.publishSoc(PLAYING, index, manifest(index + 1));
        await waitFor(() => segmentCount(state, PLAYING) === index + 1, `the playing rung at index ${index}`);
        clock.advance(UNSERVED_SLOT_STALL_MS / 2);
      }

      assert.deepEqual(stopped, [], 'a healthy rung was called dead');
      assert.ok(!gateway.requests.includes(feedHeadPath(LOWER)), 'a sibling was read while nothing was wrong');
    } finally {
      poller.unregister(BOTH);
    }
  });
});

/**
 * ⛔⛔⛔ **A rung pays for a refusal it believes with the rung itself.**
 *
 * The single-rendition walk has asked what is behind a refused slot since 2026-08-06, because on
 * this deployment a 404 usually is not the publisher's head: seventy-four of seventy-six refused
 * slots already had a served slot behind them, seventy-three of those at +1. A rung walk that never
 * asked would sit unserved on the hole until the stall rule tried a sibling and failed the rung over,
 * which has no undo inside the session. An outside reviewer watched 720p leave a ladder that way with
 * all of its media on Swarm.
 */
describe('LadderFeedPoller asking what is behind a slot the gateway refuses', () => {
  let state: ManifestStateManager;

  beforeEach(() => {
    state = new ManifestStateManager();
  });

  const GROUP = Topic.fromString('the-broadcast-a-viewer-linked-to').toString();
  const HOLED = Topic.fromString('group-1-720p');
  const LOWER = Topic.fromString('group-1-480p');
  const BOTH = [LOWER, HOLED];

  /** The one index of the holed rung the gateway will not serve, although the publisher wrote it. */
  const HOLE_AT = 1;

  /** Comfortably past the hole. */
  const PUBLISHED_THROUGH = HOLE_AT + 9;

  function makeLadder(gateway: FakeGateway) {
    let clockMs = 0;
    const clock = { now: () => clockMs, advance: (by: number) => void (clockMs += by) };
    const feedHealth = new FeedHealthTracker(clock.now);
    const stopped: string[] = [];
    feedHealth.onRungStopped((rung) => stopped.push(rung));
    const poller = new FastPoller(state, gateway.reader, POLL_MS, feedHealth, undefined, undefined, {
      now: clock.now,
      progressBoundMs: 2_000,
    });
    poller.register(
      OWNER,
      [
        { topic: LOWER, bandwidth: 1 },
        { topic: HOLED, bandwidth: 2 },
      ],
      GROUP,
    );
    poller.activate(HOLED.toString());
    return { clock, feedHealth, stopped, poller };
  }

  function ladderAt404(): FakeGateway {
    const gateway = new FakeGateway();
    // A slot the publisher has not written yet rather than a transport error, which is a gateway
    // fault and a different thing entirely.
    gateway.missingSlotStatus = 404;
    for (const topic of BOTH) {
      gateway.publishFeedHead(topic, 0, manifest(1));
    }
    return gateway;
  }

  /**
   * The measured shape, and the one the reviewer saw live: the slot is refused and the rung's own
   * media is sitting at +1 the whole time.
   */
  it('steps onto the slot behind the refusal instead of waiting on one the gateway will not serve', async () => {
    const gateway = ladderAt404();
    const { stopped, poller } = makeLadder(gateway);

    try {
      for (let index = HOLE_AT + 1; index <= PUBLISHED_THROUGH; index++) {
        gateway.publishSoc(HOLED, index, manifest(index + 1));
      }
      await waitFor(() => segmentCount(state, HOLED) === PUBLISHED_THROUGH + 1, 'the rung to walk past the hole');

      assert.ok(
        gateway.requests.includes(socPath(HOLED, HOLE_AT + 1)),
        'the rung never asked what was behind the slot it was refused',
      );
      assert.deepEqual(stopped, [], 'a rung one request away from its own media was dropped from the ladder');
    } finally {
      poller.unregister(BOTH);
    }
  });

  /**
   * The control the case above needs. Asking is a bet that a refusal is a hole, and a rung that
   * really has stopped loses the bet on every distance, so it still stalls, and is failed over once
   * its sibling moves, having asked first.
   */
  it('still fails over a rung there is genuinely nothing behind, having asked first', async () => {
    const gateway = ladderAt404();
    const { clock, feedHealth, stopped, poller } = makeLadder(gateway);

    try {
      await waitFor(
        () => gateway.requests.includes(socPath(HOLED, HOLE_AT + 1)),
        'the rung to ask what was behind its refusal',
      );
      assert.ok(feedHealth.unservedPollsRecorded(HOLED.toString()) > 0);
      clock.advance(UNSERVED_SLOT_STALL_MS);
      await waitFor(() => poller.isActive(LOWER.toString()), 'the lower rung to be tried');
      gateway.publishSoc(LOWER, 1, manifest(2));

      await waitFor(() => stopped.length > 0, 'the dead rung to be failed over');
      assert.deepEqual(stopped, [HOLED.toString()]);
    } finally {
      poller.unregister(BOTH);
    }
  });

  /**
   * The bet costs one read a turn and no more. A slot that stays missing is asked for on the follower's
   * backoff, and each turn looks past it by one slot only: of seventy-four refused slots with something
   * behind them, seventy-three had it at +1, so a wider look costs reads on a gateway that is already
   * the reason the slot is missing.
   */
  it('looks past a slot that stays missing by one slot, at most once for each ask of it', async () => {
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const tracker = new FeedHealthTracker();
    const poller = new FastPoller(state, gateway.reader, POLL_MS, tracker);
    follow(poller, OWNER, [topic]);

    const looksPast = () => gateway.requests.filter((path) => path === socPath(topic, HOLE_AT + 1)).length;
    const asksForTheSlotItNeeds = () => gateway.requests.filter((path) => path === socPath(topic, HOLE_AT)).length;
    const further = [2, 4, 8].map((distance) => socPath(topic, HOLE_AT + distance));

    try {
      await waitFor(() => asksForTheSlotItNeeds() >= 12, 'a dozen asks for the missing slot');

      assert.ok(looksPast() > 0, 'nothing looked past the refusal at all');
      assert.ok(
        looksPast() <= asksForTheSlotItNeeds(),
        `${looksPast()} looks past for ${asksForTheSlotItNeeds()} asks`,
      );
      assert.deepEqual(
        gateway.requests.filter((path) => further.includes(path)),
        [],
        'it looked further than one slot past',
      );
    } finally {
      poller.unregister([topic]);
    }
  });

  /**
   * The cost side, and the reason the wait before asking is not zero. A rung that is being served
   * must add no request at all: it is refused on plenty of polls simply because it has caught up
   * with the publisher, and asking on each of those would cost every viewer four requests a poll to
   * find nothing.
   */
  it('asks for nothing past the slot it needs while the rung is being served', async () => {
    const topic = Topic.fromString('group-1-1080p');
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const BACKLOG = 20;
    for (let index = 1; index <= BACKLOG; index++) {
      gateway.publishSoc(topic, index, manifest(index + 1));
    }

    // A poll interval the test cannot outlive, so the whole backlog is consumed without the run of
    // refusals ever reaching the length a probe needs. What is asserted is then the client's rule
    // rather than how fast the machine happened to be.
    const poller = new FastPoller(state, gateway.reader, 10_000);
    follow(poller, OWNER, [topic]);

    try {
      await waitFor(() => segmentCount(state, topic) === BACKLOG + 1, 'the whole backlog');

      const contiguous = new Set(Array.from({ length: BACKLOG + 1 }, (_, step) => socPath(topic, step + 1)));
      const beyond = gateway.requests.filter((path) => path.startsWith('soc/') && !contiguous.has(path));
      assert.deepEqual(beyond, [], 'a rung that was being served went looking past the publisher');
    } finally {
      poller.unregister([topic]);
    }
  });
});
