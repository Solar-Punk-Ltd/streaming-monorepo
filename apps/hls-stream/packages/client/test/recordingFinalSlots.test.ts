import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath } from '@swarm-hls-stream/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FEED_STATE_ENDED, FeedHealthTracker } from '../src/components/SwarmHlsPlayer/feedState';
import {
  ManifestFetcher,
  ManifestStateManager,
  RungRefusedError,
} from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { parseManifest } from '../src/components/SwarmHlsPlayer/playlist';
import type { Rendition } from '../src/types/stream';
import { RequestJitter } from '../src/utils/requestJitter';

import { LADDER_EPOCH_MS, ladderPlaylist } from './helpers/fakeLadderGateway';
import { swarmOverGlobalFetch } from './helpers/playerReader';
import { waitFor } from './helpers/waiting';

/**
 * A recording whose stage stamps ran out: only the archive's copy is left on Swarm. Each quality feed
 * holds its final playlist, an EVENT playlist closed with ENDLIST that lists every segment, at the slot
 * the stream list's entry names in `renditions[i].index`, and nothing else. Every earlier slot, every
 * feed head lookup and the ladder's time markers answer 404.
 */

const OWNER = '00000000000000000000000000000000000ab1e5';
const GROUP = 'recording-final-slots-group';
const SOURCE_URL = `swarm://${OWNER}/${GROUP}`;

interface RungFixture {
  readonly name: string;
  readonly bandwidth: number;
  readonly finalIndex: number;
}

/** Final slots as a four-quality recording's entry names them, the top one a few slots short. */
const RUNGS: readonly RungFixture[] = [
  { name: '360p', bandwidth: 1_000_000, finalIndex: 337 },
  { name: '480p', bandwidth: 1_500_000, finalIndex: 337 },
  { name: '720p', bandwidth: 3_000_000, finalIndex: 337 },
  { name: '1080p', bandwidth: 5_000_000, finalIndex: 332 },
];

/** Every segment the recording holds, so the final playlist is the whole of it. */
const RECORDED_SEGMENTS = 40;

/** Short, so a bounded retry of a missing final slot runs in milliseconds here. */
const POLL_MS = 5;
/** Short, so the watch for a broadcast that comes back asks within a test. */
const RETURN_WATCH_MS = 40;
/**
 * Caps every wait the fetcher is handed, so a level request that would wait its 20 s deadline for a
 * rung with no playlist fails within a test instead.
 */
const LONGEST_WAIT_MS = 3_000;
/** How long a test waits for a watch that runs on its own timer, generous for a slow runner. */
const WATCH_WAIT_MS = 10_000;

const NO_JITTER = new RequestJitter(0, () => 0);
const manager = ManifestStateManager.getInstance();
const realFetch = globalThis.fetch;

const topicOf = (name: string): Topic => Topic.fromString(`${GROUP}-${name}`);
const hexOf = (name: string): string => topicOf(name).toString();
const rungUrl = (name: string): string => `swarm://${OWNER}/${GROUP}-${name}`;
const fixtureOf = (name: string): RungFixture => RUNGS.find((rung) => rung.name === name)!;

function finalPlaylist(name: string): string {
  return ladderPlaylist({
    name,
    firstSequence: 0,
    count: RECORDED_SEGMENTS,
    startMs: LADDER_EPOCH_MS,
    finalized: true,
  });
}

function renditionsOf(rungs: readonly RungFixture[]): Rendition[] {
  return rungs.map((rung) => ({
    name: rung.name,
    width: 0,
    height: Number.parseInt(rung.name, 10),
    topic: `${GROUP}-${rung.name}`,
    bandwidth: rung.bandwidth,
    avgBandwidth: rung.bandwidth,
    index: rung.finalIndex,
  }));
}

/** A read the player made: the feed slot it named, or the kind of read it was when it named no slot. */
interface Read {
  readonly hex: string | null;
  readonly index: number | null;
  readonly kind: 'slot' | 'head' | 'other';
}

/**
 * The gateway, by path: a slot is served when it was published and 404 otherwise, and every head
 * lookup is 404, as a recording's group feed head lookup answers once only the archive's copy is left.
 */
class ArchiveGateway {
  readonly reads: Read[] = [];
  private readonly slots = new Map<string, { hex: string; index: number; body: string | null }>();

  /**
   * Names a feed's slots around `index`, and those a search from nothing reads, so an ask for one that
   * was never written still says which feed and slot it was.
   */
  watch(topic: Topic, index: number): void {
    for (const at of new Set([0, 1, 2, 3, 15, 63, 255, 1023, index - 1, index, index + 1, index + 2])) {
      const path = feedSlotPath(OWNER, topic, FeedIndex.fromBigInt(BigInt(at)));
      if (at >= 0 && !this.slots.has(path)) {
        this.slots.set(path, { hex: topic.toString(), index: at, body: null });
      }
    }
  }

  publish(topic: Topic, index: number, body: string): void {
    this.watch(topic, index);
    this.slots.set(feedSlotPath(OWNER, topic, FeedIndex.fromBigInt(BigInt(index))), {
      hex: topic.toString(),
      index,
      body,
    });
  }

  heads(): Read[] {
    return this.reads.filter((read) => read.kind === 'head');
  }

  slotsReadOf(topicHex: string): number[] {
    return this.reads.filter((read) => read.hex === topicHex).map((read) => read.index ?? -1);
  }

  readonly fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.slice(1);
    if (path.startsWith('feeds/')) {
      this.reads.push({ hex: path.split('/')[2] ?? null, index: null, kind: 'head' });
      return new Response('no update found', { status: 404 });
    }
    const slot = this.slots.get(path);
    this.reads.push({ hex: slot?.hex ?? null, index: slot?.index ?? null, kind: slot ? 'slot' : 'other' });
    if (slot?.body) {
      return new Response(slot.body, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function segmentsIn(playlist: string): number {
  return parseManifest(playlist).segments.length;
}

describe('a recording plays from the final slots its stream-list entry names', () => {
  let gateway: ArchiveGateway;
  let health: FeedHealthTracker;
  let fetcher: ManifestFetcher;
  let stopped: { hex: string; failoverTo: string | null }[];
  let stopListening: () => void;

  beforeEach(() => {
    manager.clear();
    gateway = new ArchiveGateway();
    for (const rung of RUNGS) {
      gateway.watch(topicOf(rung.name), rung.finalIndex);
    }
    globalThis.fetch = gateway.fetch;
    health = new FeedHealthTracker();
    stopped = [];
    stopListening = health.onRungStopped((hex, detail) => stopped.push({ hex, failoverTo: detail.failoverTo }));
    fetcher = new ManifestFetcher(
      manager,
      health,
      (ms) => sleep(Math.min(ms, LONGEST_WAIT_MS)),
      NO_JITTER,
      POLL_MS,
      RETURN_WATCH_MS,
    );
    fetcher.useSwarm(swarmOverGlobalFetch('http://gateway.test'));
  });

  afterEach(async () => {
    stopListening();
    fetcher.unregisterLadder(SOURCE_URL);
    await fetcher.settled();
    manager.clear();
    globalThis.fetch = realFetch;
  });

  /** Publishes the archive's copy of every rung named, and nothing else. */
  function archive(rungs: readonly RungFixture[] = RUNGS): void {
    for (const rung of rungs) {
      gateway.publish(topicOf(rung.name), rung.finalIndex, finalPlaylist(rung.name));
    }
  }

  /** Registers the ladder as the watch page hands it over for an entry in state VOD. */
  function registerRecordedLadder(rungs: readonly RungFixture[] = RUNGS): void {
    fetcher.registerLadder(SOURCE_URL, () => ({ owner: OWNER, renditions: renditionsOf(rungs), recorded: true }));
  }

  it('starts a quality at the final slot the entry names, in one read, with no search', async () => {
    archive();
    registerRecordedLadder();

    const playlist = await fetcher.fetch(rungUrl('720p'));

    expect(segmentsIn(playlist)).toBe(RECORDED_SEGMENTS);
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(gateway.slotsReadOf(hexOf('720p'))).toEqual([337]);
    expect(gateway.heads()).toEqual([]);
  });

  it('reads the other quality’s final slot at a switch, and nothing older', async () => {
    archive();
    registerRecordedLadder();
    await fetcher.fetch(rungUrl('720p'));

    const switched = await fetcher.fetch(rungUrl('1080p'));

    expect(segmentsIn(switched)).toBe(RECORDED_SEGMENTS);
    expect(gateway.slotsReadOf(hexOf('1080p'))).toEqual([332]);
    expect(gateway.heads()).toEqual([]);
  });

  it('checks the end on the sibling’s final slot, so the recording ends, and watches the slot after', async () => {
    archive();
    registerRecordedLadder();
    const group = Topic.fromString(GROUP).toString();

    await fetcher.fetch(rungUrl('720p'));

    await waitFor(() => health.state(group) === FEED_STATE_ENDED, 'the recording to end', WATCH_WAIT_MS);
    // The next lower quality is the sibling an end is checked on.
    expect(gateway.slotsReadOf(hexOf('480p'))).toEqual([337]);

    // A broadcaster who comes back writes the slot after the final one, which the watch keeps asking.
    await waitFor(
      () => gateway.slotsReadOf(hexOf('720p')).includes(338),
      'the watch to ask the slot after the final one',
      WATCH_WAIT_MS,
    );
    const resumed: string[] = [];
    const stopResumed = health.onFeedResumed((topicId) => resumed.push(topicId));
    try {
      gateway.publish(
        topicOf('720p'),
        338,
        ladderPlaylist({ name: '720p', firstSequence: 40, count: 1, startMs: LADDER_EPOCH_MS + 3_600_000 }),
      );
      await waitFor(() => resumed.includes(group), 'the broadcast that came back to be announced', WATCH_WAIT_MS);
    } finally {
      stopResumed();
    }
  });

  it('drops a quality whose final slot cannot be read, and the rest plays', async () => {
    // The archive never copied 1080p, and its stage stamp ran out.
    archive(RUNGS.filter((rung) => rung.name !== '1080p'));
    registerRecordedLadder();

    await expect(fetcher.fetch(rungUrl('1080p'))).rejects.toBeInstanceOf(RungRefusedError);

    expect(stopped).toEqual([{ hex: hexOf('1080p'), failoverTo: hexOf('720p') }]);
    const missed = gateway.slotsReadOf(hexOf('1080p'));
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.length).toBeLessThanOrEqual(3);
    expect(new Set(missed)).toEqual(new Set([332]));

    const remaining = await fetcher.fetch(rungUrl('720p'));
    expect(segmentsIn(remaining)).toBe(RECORDED_SEGMENTS);

    // Dropped for the session: asked again, it reads nothing more.
    await expect(fetcher.fetch(rungUrl('1080p'))).rejects.toBeInstanceOf(RungRefusedError);
    expect(gateway.slotsReadOf(hexOf('1080p'))).toEqual(missed);
  });

  it('keeps the last quality left and reads only its final slot again, never slot 0', async () => {
    // A one-rung ladder whose only quality was not archived: there is nothing to move the viewer to.
    registerRecordedLadder([fixtureOf('360p')]);

    const level = fetcher.fetch(rungUrl('360p')).catch((error: unknown) => error);
    // A round of reads, the walk's pause, and a second round.
    await waitFor(() => gateway.slotsReadOf(hexOf('360p')).length > 3, 'a second round of reads', WATCH_WAIT_MS);
    fetcher.unregisterLadder(SOURCE_URL);
    await level;

    expect(stopped).toEqual([]);
    expect(new Set(gateway.slotsReadOf(hexOf('360p')))).toEqual(new Set([337]));
  });

  it('reads a one-quality recording at the entry’s own index', async () => {
    const topic = Topic.fromString(GROUP);
    gateway.publish(topic, 41, finalPlaylist('single'));
    fetcher.registerRecording(SOURCE_URL, 41);

    const playlist = await fetcher.fetchSource(SOURCE_URL);

    expect(segmentsIn(playlist)).toBe(RECORDED_SEGMENTS);
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(gateway.heads()).toEqual([]);
    expect(gateway.slotsReadOf(topic.toString())).toEqual([41]);
  });

  it('still searches a live entry, whatever index its renditions carry', async () => {
    // A live quality whose rendition carries an index: slots 0 to 10 are written, and 10 is the newest.
    const live = fixtureOf('720p');
    for (let index = 0; index <= 10; index++) {
      gateway.publish(
        topicOf(live.name),
        index,
        ladderPlaylist({ name: live.name, firstSequence: index, count: 1, startMs: LADDER_EPOCH_MS + index * 2_000 }),
      );
    }
    fetcher.registerLadder(SOURCE_URL, () => ({
      owner: OWNER,
      renditions: renditionsOf([{ ...live, finalIndex: 3 }]),
    }));

    await fetcher.fetch(rungUrl(live.name));

    const read = gateway.slotsReadOf(hexOf(live.name));
    expect(read).toContain(0);
    expect(manager.getIndex(hexOf(live.name))?.toBigInt()).toBe(10n);
  });
});
