import { FeedIndex, type Topic } from '@ethersphere/bee-js';
import { feedSlotPath, nextFeedRequest, resolvedFeedIndex } from '@swarm-hls-stream/shared';

import type { SegmentUrl } from '../../src/components/SwarmHlsPlayer/ManifestManagement';
import type { PlayerReader } from '../../src/components/SwarmHlsPlayer/playerReads';
import { ManifestFetchError } from '../../src/components/SwarmHlsPlayer/refusedSlot';
import type { SwarmAnswer } from '../../src/swarm/answers';
import { SwarmClient, type SwarmReader } from '../../src/swarm/client';
import { BeeHttpProvider } from '../../src/swarm/providers/bee-http/beeHttpProvider';

/** What a fake gateway answers a path with: its status and headers, and the body as text. */
export interface PathResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text: string;
}

/** A fake gateway that answers the player's Bee paths, as the fakes built before the Swarm client do. */
type PathGateway = (path: string) => Promise<PathResponse>;

const UTF8 = new TextEncoder();

async function answerOf(gateway: PathGateway, path: string): Promise<SwarmAnswer> {
  let response: PathResponse;
  try {
    response = await gateway(path);
  } catch (error) {
    if (error instanceof ManifestFetchError) {
      return error.status === 404
        ? { kind: 'not-found', serverTimeMs: null }
        : { kind: 'unavailable', cause: { kind: 'status', status: error.status } };
    }
    return { kind: 'unavailable', cause: { kind: 'network', error } };
  }
  if (response.status === 404) {
    return { kind: 'not-found', serverTimeMs: null };
  }
  if (!response.ok) {
    return { kind: 'unavailable', cause: { kind: 'status', status: response.status } };
  }
  return {
    kind: 'content',
    bytes: UTF8.encode(response.text),
    feedIndex: resolvedFeedIndex(response.headers),
    serverTimeMs: null,
  };
}

/**
 * The player's reads over a fake that answers by path, asking each read at the path the Bee provider
 * asks it at, so a fake's log of paths still says what the player read.
 */
export function readerOverPaths(gateway: PathGateway): PlayerReader {
  return {
    readFeedHead: (owner: string, topic: Topic) => answerOf(gateway, nextFeedRequest(owner, topic, null).path),
    readFeedEntry: (owner: string, topic: Topic, index: number) =>
      answerOf(gateway, feedSlotPath(owner, topic, FeedIndex.fromBigInt(BigInt(index)))),
    readSoc: (owner: string, identifier: string) => answerOf(gateway, `soc/${owner}/${identifier}`),
  };
}

/**
 * The player's reader of a Swarm client on one Bee gateway at `baseUrl`, reached through whatever
 * `globalThis.fetch` is when each read is made, so a test that swaps the global fetch drives it.
 */
export function swarmOverGlobalFetch(baseUrl: string): SwarmReader {
  const provider = new BeeHttpProvider({
    baseUrl,
    fetcher: (input, init) => globalThis.fetch(input, init),
    pageOrigin: 'http://localhost',
  });
  return new SwarmClient({ chosen: { id: 'gateway', provider } }).reader('player');
}

const segmentUrls = new Map<string, SegmentUrl>();

/**
 * Segment lines under one bytes base, as the Bee provider writes them: `<base>/<reference>`. One
 * function per base, because the playlist cache tells gateways apart by the function it was built with.
 */
export function segmentsUnder(bytesBase: string): SegmentUrl {
  let segmentUrl = segmentUrls.get(bytesBase);
  if (segmentUrl === undefined) {
    segmentUrl = (reference) => `${bytesBase}/${reference}`;
    segmentUrls.set(bytesBase, segmentUrl);
  }
  return segmentUrl;
}
