import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath, ladderMarkerIdentifier, markerPeriodStartMs, nextFeedRequest } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'vitest';

import type { FollowClock } from '../src/components/SwarmHlsPlayer/following/feedReader';

import { CatalogFeedReader } from '../src/utils/catalogFeed';
import { LadderMarkerReads } from '../src/components/SwarmHlsPlayer/ladderMarkerReads';
import {
  LADDER_COMPLETION_WATCH_MS,
  watchLadderCompletion,
} from '../src/components/SwarmHlsPlayer/ladderCompletionWatch';
import { ManifestFetchError } from '../src/components/SwarmHlsPlayer/refusedSlot';

import { type PathResponse, readerOverPaths } from './helpers/playerReader';

/**
 * Architecture review 2026-10-08, P2 #7, with the coordinator's correction of the same day. A stream
 * turns live once its first quality has reported, and at that moment its time marker often names only
 * that quality too. The watch reads one marker per 10 s period after join, for a bounded time, and only
 * when a marker names a quality the entry lacks does the page read the stream list's next slot. A
 * quality reports to the admin before its first segment, so by then that slot is written and the read
 * is not early. Bee answers an address asked before it is written by skipping the peer it asked for a
 * minute, so an early ask on the list slot would hide the fuller entry for that minute.
 */

const OWNER = '3333333333333333333333333333333333333333';
const GROUP = Topic.fromString('ladder-group');
const LIST = Topic.fromString('stream-list');

/**
 * A clock that moves only when the watch sleeps, by exactly what it asked for. Each sleep first lets a
 * real timer pass, so a list read the watch started settles before the watch reads its next marker, as
 * it does in the ten seconds between two markers.
 */
function virtualClock(): FollowClock {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      await sleep(1);
      nowMs += ms;
    },
  };
}

/** Lets the watch run to its end, which a virtual clock reaches in a few hundred real milliseconds. */
async function runOut(): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    await sleep(2);
  }
}
const SKIP_MS = 60_000;
const QUALITIES = ['360p', '480p', '720p', '1080p'].map((name) => ({
  name,
  hex: Topic.fromString(`rung-${name}`).toString(),
}));

/** When the other three qualities report to the admin, which writes the fuller entry into the list's slot 1. */
const OTHERS_REPORT_MS = 12_000;
/** And when their first segments are published, so the next marker names them. */
const OTHERS_PUBLISH_MS = 14_000;

interface Written {
  writtenAtMs: number;
  body: string;
  index?: number;
}

/**
 * A Bee gateway on a timeline, holding the stream list and the ladder's markers. An address asked
 * before it is written puts its one peer on a skip list for a minute, and a skipped address answers
 * not found whether written or not, which is Bee 2.8.2's rule with one peer.
 */
interface Timeline {
  /** The stream list's slots in order, each written at its moment, naming that many qualities. */
  entries: { writtenAtMs: number; qualities: number }[];
  /** How many qualities a marker written at this moment names, zero for none written. */
  markerNames: (writtenAtMs: number) => number;
}

/** One quality at the start, the other three reporting at 12 s and publishing at 14 s. */
const ONE_THEN_FOUR: Timeline = {
  entries: [
    { writtenAtMs: 0, qualities: 1 },
    { writtenAtMs: OTHERS_REPORT_MS, qualities: 4 },
  ],
  markerNames: (writtenAtMs) => (writtenAtMs >= OTHERS_PUBLISH_MS ? 4 : 1),
};

function timelineGateway(now: () => number, timeline: Timeline = ONE_THEN_FOUR) {
  const written = new Map<string, Written>();
  const asks: { path: string; atMs: number; early: boolean }[] = [];
  const skippedUntil = new Map<string, number>();

  const entry = (qualities: typeof QUALITIES) =>
    JSON.stringify([
      {
        owner: OWNER,
        topic: 'a-talk',
        state: 'live',
        renditions: qualities.map((q) => ({ name: q.name, topic: `rung-${q.name}` })),
      },
    ]);
  const listSlot = (index: number) => feedSlotPath(OWNER, LIST, FeedIndex.fromBigInt(BigInt(index)));
  timeline.entries.forEach(({ writtenAtMs, qualities }, index) =>
    written.set(listSlot(index), { writtenAtMs, body: entry(QUALITIES.slice(0, qualities)), index }),
  );
  for (let period = 0; period < 20; period++) {
    const writtenAtMs = markerPeriodStartMs(period) + 250;
    const named = QUALITIES.slice(0, timeline.markerNames(writtenAtMs));
    if (named.length === 0) {
      continue;
    }
    const marker = {
      v: 2,
      period,
      segmentMs: 2_000,
      writtenAt: writtenAtMs,
      rungs: Object.fromEntries(named.map((q) => [q.hex, 3])),
    };
    written.set(`soc/${OWNER}/${ladderMarkerIdentifier(GROUP, period).toHex()}`, {
      writtenAtMs,
      body: JSON.stringify(marker),
    });
  }

  const headPath = nextFeedRequest(OWNER, LIST, null).path;
  const answer = async (path: string): Promise<PathResponse> => {
    const atMs = now();
    if (path === headPath) {
      const newest = [...written.values()].filter((w) => w.index !== undefined && w.writtenAtMs <= atMs).at(-1)!;
      const headers = new Headers({ 'Swarm-Feed-Index': newest.index!.toString(16).padStart(16, '0') });
      return { ok: true, status: 200, headers, text: newest.body };
    }
    const slot = written.get(path);
    const isWritten = slot !== undefined && slot.writtenAtMs <= atMs;
    asks.push({ path, atMs, early: !isWritten });
    if ((skippedUntil.get(path) ?? -Infinity) > atMs) {
      throw new ManifestFetchError(path, 404);
    }
    if (!isWritten) {
      skippedUntil.set(path, atMs + SKIP_MS);
      throw new ManifestFetchError(path, 404);
    }
    return { ok: true, status: 200, headers: new Headers(), text: slot.body };
  };

  return {
    reader: readerOverPaths(answer),
    asks,
    isListSlot: (path: string) => [0, 1, 2, 3].some((index) => listSlot(index) === path),
    isMarker: (path: string) => path.startsWith('soc/') && ![0, 1, 2, 3].some((index) => listSlot(index) === path),
  };
}

describe('the watch for qualities that report after the viewer joined', () => {
  /** A viewer joining at 0 with the list's first slot, the page reading one slot each time it is told. */
  async function joinAndWatch(timeline: Timeline) {
    const clock = virtualClock();
    const gateway = timelineGateway(clock.now, timeline);
    const list = new CatalogFeedReader(OWNER, LIST);
    let listed: string[] = [];
    const readList = async () => {
      const snapshot = await list.read(gateway.reader, undefined, 1);
      if (snapshot) {
        const [stream] = JSON.parse(snapshot.body) as { renditions: { topic: string }[] }[];
        listed = stream.renditions.map((r) => Topic.fromString(r.topic).toString());
      }
    };
    await readList();
    let shortSaid = 0;

    const stop = watchLadderCompletion({
      reads: new LadderMarkerReads(gateway.reader),
      clock,
      clockOffsetMs: () => 0,
      owner: OWNER,
      group: GROUP,
      listedTopics: () => listed,
      onShort: () => {
        shortSaid++;
        void readList();
      },
    });
    await runOut();
    stop();
    return { clock, gateway, listed, shortSaid };
  }

  /** Every check the coordinator named, for a watch that should end with all four qualities. */
  function assertEndsWithFour({ clock, gateway, listed }: Awaited<ReturnType<typeof joinAndWatch>>) {
    assert.deepEqual([...listed].sort(), QUALITIES.map((q) => q.hex).sort(), 'the viewer did not end with four');
    const earlyListAsks = gateway.asks.filter((ask) => gateway.isListSlot(ask.path) && ask.early);
    assert.deepEqual(earlyListAsks, [], 'a list slot was asked before it was written');
    const markerPaths = gateway.asks.filter((ask) => gateway.isMarker(ask.path)).map((ask) => ask.path);
    assert.equal(new Set(markerPaths).size, markerPaths.length, 'a marker address was asked twice');
    assert.ok(markerPaths.length >= 5, `only ${markerPaths.length} markers were read in the minute`);
    const late = gateway.asks.filter((ask) => ask.atMs > LADDER_COMPLETION_WATCH_MS);
    assert.deepEqual(late, [], 'something was asked after the bound');
    assert.ok(clock.now() <= LADDER_COMPLETION_WATCH_MS, `the watch was still waiting at ${clock.now()} ms`);
  }

  it('brings a viewer who joined with one quality, and a marker naming one, to all four', async () => {
    const run = await joinAndWatch(ONE_THEN_FOUR);

    assertEndsWithFour(run);
    assert.equal(run.shortSaid, 1, `the page was told ${run.shortSaid} times that the entry was short`);
  });

  /**
   * A page may start the player on the stream's first marker, before the list names any rendition or
   * while it still says scheduled. The entry is short in the same way, and the marker that names the
   * first quality is what has the page read the list.
   */
  it('brings a viewer who joined on an entry naming no rendition to all four', async () => {
    const run = await joinAndWatch({
      entries: [
        { writtenAtMs: 0, qualities: 0 },
        { writtenAtMs: 1_000, qualities: 1 },
        { writtenAtMs: OTHERS_REPORT_MS, qualities: 4 },
      ],
      markerNames: (writtenAtMs) => (writtenAtMs >= OTHERS_PUBLISH_MS ? 4 : writtenAtMs >= 2_000 ? 1 : 0),
    });

    assertEndsWithFour(run);
    assert.equal(run.shortSaid, 2, `the page was told ${run.shortSaid} times that the entry was short`);
  });

  /**
   * The start check and the first period's marker can land back to back. A second call then would have
   * the page ask the list's slot after the one its first read is fetching, which is not written yet.
   */
  it('says the entry is short at most once per marker period, the start check included', async () => {
    const clock = virtualClock();
    const gateway = timelineGateway(clock.now, { entries: [{ writtenAtMs: 0, qualities: 1 }], markerNames: () => 4 });
    const saidAtMs: number[] = [];

    const stop = watchLadderCompletion({
      reads: new LadderMarkerReads(gateway.reader),
      clock,
      clockOffsetMs: () => 0,
      owner: OWNER,
      group: GROUP,
      listedTopics: () => [QUALITIES[0].hex],
      onShort: () => saidAtMs.push(clock.now()),
      startNames: async () => QUALITIES.map((q) => q.hex),
    });
    await runOut();
    stop();

    assert.deepEqual(saidAtMs, [0, 14_000, 24_000, 34_000, 44_000, 54_000]);
  });

  it('asks the list nothing while every marker agrees with the entry', async () => {
    const clock = virtualClock();
    const gateway = timelineGateway(clock.now);
    let shortSaid = 0;

    const stop = watchLadderCompletion({
      reads: new LadderMarkerReads(gateway.reader),
      clock,
      clockOffsetMs: () => 0,
      owner: OWNER,
      group: GROUP,
      listedTopics: () => QUALITIES.map((q) => q.hex),
      onShort: () => shortSaid++,
    });
    await runOut();
    stop();

    assert.equal(shortSaid, 0);
    assert.deepEqual(
      gateway.asks.filter((ask) => !gateway.isMarker(ask.path)),
      [],
    );
  });

  it('asks nothing once stopped, as a torn down player is', async () => {
    const clock = virtualClock();
    const gateway = timelineGateway(clock.now);

    const stop = watchLadderCompletion({
      reads: new LadderMarkerReads(gateway.reader),
      clock,
      clockOffsetMs: () => 0,
      owner: OWNER,
      group: GROUP,
      listedTopics: () => [],
      onShort: () => {},
    });
    stop();
    await runOut();

    assert.deepEqual(gateway.asks, []);
  });
});

describe('the ladder marker reads shared by the player', () => {
  it('asks a marker address once, found or missing, and asks again only after a gateway fault', async () => {
    const paths: string[] = [];
    let fault = true;
    const markerPath = `soc/${OWNER}/${ladderMarkerIdentifier(GROUP, 7).toHex()}`;
    const reads = new LadderMarkerReads(
      readerOverPaths(async (path) => {
        paths.push(path);
        if (path === markerPath && fault) {
          fault = false;
          throw new TypeError('Failed to fetch');
        }
        if (path === markerPath) {
          const writtenAt = markerPeriodStartMs(7) + 250;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: JSON.stringify({ v: 2, period: 7, writtenAt, rungs: { [QUALITIES[0].hex]: 3 }, segmentMs: 2_000 }),
          };
        }
        throw new ManifestFetchError(path, 404);
      }),
    );

    await assert.rejects(reads.read(OWNER, GROUP, 7));
    assert.ok(await reads.read(OWNER, GROUP, 7));
    assert.ok(await reads.read(OWNER, GROUP, 7));
    assert.equal(await reads.read(OWNER, GROUP, 8), null);
    assert.equal(await reads.read(OWNER, GROUP, 8), null);

    assert.equal(paths.filter((path) => path === markerPath).length, 2, 'a found marker was asked again');
    assert.equal(paths.length, 3, 'a missing marker was asked again');
  });
});
