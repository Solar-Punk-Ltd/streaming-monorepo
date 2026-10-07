import { Topic } from '@ethersphere/bee-js';
import { ladderMarkerIdentifier, markerPeriodAt } from '@swarm-hls-stream/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { FeedHealthTracker } from '../src/components/SwarmHlsPlayer/feedState';
import { ManifestFetcher, ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { MarkerFinder } from '../src/components/SwarmHlsPlayer/markerFinder';
import type { PlayerReader } from '../src/components/SwarmHlsPlayer/playerReads';
import { buildSwarmUri } from '../src/components/SwarmHlsPlayer/playlist';
import { RequestJitter } from '../src/utils/requestJitter';
import type { SwarmAnswer } from '../src/swarm/answers';
import { SwarmClient } from '../src/swarm/client';
import { ScriptedProvider } from './helpers/scriptedProvider';

const OWNER = '3'.repeat(40);
const TOPIC = 'through-the-client';
const hexTopic = Topic.fromString(TOPIC).toString();
const SOURCE_URL = buildSwarmUri(OWNER, TOPIC);
const SEGMENT_REF = 'ab'.repeat(32);
const NO_JITTER = new RequestJitter(0, () => 0);

const PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.0,', SEGMENT_REF].join('\n');

function served(text: string, feedIndex: number | null): SwarmAnswer {
  return { kind: 'content', bytes: new TextEncoder().encode(text), feedIndex, serverTimeMs: null };
}

const manager = ManifestStateManager.getInstance();

function fetcherOn(client: SwarmClient, health = new FeedHealthTracker()): ManifestFetcher {
  const fetcher = new ManifestFetcher(manager, health, async () => {}, NO_JITTER);
  fetcher.useSwarm(client.reader('player'));
  return fetcher;
}

describe('the player reads through the Swarm client', () => {
  afterEach(() => {
    manager.clear(hexTopic);
  });

  it("reads a stream's feed head through the player's reader, and names segments by the client's URLs", async () => {
    const provider = new ScriptedProvider('event');
    provider.answer = served(PLAYLIST, 3);
    const client = new SwarmClient({ chosen: { id: 'event', provider } });

    const manifest = await fetcherOn(client).fetchSource(SOURCE_URL);

    expect(provider.asked).toEqual(['feed-head']);
    expect(client.counts()).toEqual([
      { feature: 'player', read: 'feed-head', provider: 'event', answer: 'content', count: 1 },
    ]);
    expect(manifest.split('\n')).toContain(`event:segment:${SEGMENT_REF}`);
  });

  it('names the segments of a playlist it already holds by the provider that serves the player now', async () => {
    const event = new ScriptedProvider('event');
    const backup = new ScriptedProvider('backup');
    event.answer = served(PLAYLIST, 3);
    backup.answer = served(PLAYLIST, 3);
    let nowMs = 0;
    const client = new SwarmClient({
      chosen: { id: 'event', provider: event },
      fallback: { id: 'backup', provider: backup },
      pausePolicy: { faultsBeforePause: 1, firstPauseMs: 1_000, longestPauseMs: 1_000 },
      now: () => nowMs,
    });
    const fetcher = fetcherOn(client);
    const segmentLines = async () =>
      (await fetcher.fetchSource(SOURCE_URL)).split('\n').filter((line) => line.endsWith(SEGMENT_REF));

    expect(await segmentLines()).toEqual([`event:segment:${SEGMENT_REF}`]);

    event.answer = { kind: 'unavailable', cause: { kind: 'status', status: 502 } };
    await client.reader('player').readBytes(SEGMENT_REF);
    expect(await segmentLines()).toEqual([`backup:segment:${SEGMENT_REF}`]);

    nowMs += 1_000;
    event.answer = served(PLAYLIST, 3);
    expect(await segmentLines()).toEqual([`event:segment:${SEGMENT_REF}`]);
  });

  it('takes a node that answered not found at the head as a failure, as a missing head always was', async () => {
    const provider = new ScriptedProvider('event');
    provider.answer = { kind: 'not-found', serverTimeMs: null };
    const health = new FeedHealthTracker();

    await expect(
      fetcherOn(new SwarmClient({ chosen: { id: 'event', provider } }), health).fetchSource(SOURCE_URL),
    ).rejects.toThrow();
    expect(health.backoffRemainingMs(hexTopic)).toBeGreaterThan(0);
  });

  it('waits at least as long as a rate limit asked before asking that feed again', async () => {
    const provider = new ScriptedProvider('event');
    provider.answer = { kind: 'rate-limited', retryAfterMs: 60_000, serverTimeMs: null };
    const health = new FeedHealthTracker();

    await expect(
      fetcherOn(new SwarmClient({ chosen: { id: 'event', provider } }), health).fetchSource(SOURCE_URL),
    ).rejects.toThrow();

    expect(health.backoffRemainingMs(hexTopic)).toBeGreaterThan(50_000);
  });

  it("reads a ladder's time marker as a single-owner chunk by its owner and identifier", async () => {
    const group = Topic.fromString('a-ladder');
    const asked: [string, string][] = [];
    const notFound = async (): Promise<SwarmAnswer> => ({ kind: 'not-found', serverTimeMs: null });
    const reader: PlayerReader = {
      readFeedHead: notFound,
      readFeedEntry: notFound,
      readSoc: async (owner, identifier) => {
        asked.push([owner, identifier]);
        return { kind: 'not-found', serverTimeMs: null };
      },
    };
    const now = Date.UTC(2026, 9, 7, 12, 0, 5);
    const clock = { now: () => now, sleep: async () => {} };
    const finder = new MarkerFinder(reader, clock, () => 0, { findNewest: async () => null });

    await finder.findNewest({ owner: OWNER, topic: Topic.fromString('rung'), group: group.toHex() }, null);

    const period = markerPeriodAt(now);
    expect(asked).toEqual([
      [OWNER, ladderMarkerIdentifier(group, period - 1).toHex()],
      [OWNER, ladderMarkerIdentifier(group, period - 2).toHex()],
    ]);
  });
});
