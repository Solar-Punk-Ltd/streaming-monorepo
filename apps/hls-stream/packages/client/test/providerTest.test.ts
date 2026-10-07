import { FeedIndex, Topic } from '@ethersphere/bee-js';
import {
  encodeLadderMarker,
  feedSlotPath,
  ladderMarkerIdentifier,
  markerPeriodAt,
  nextFeedRequest,
} from '@swarm-hls-stream/shared';
import { describe, expect, it } from 'vitest';

import {
  COULD_NOT_REACH,
  MIXED_CONTENT,
  NOT_A_SWARM_GATEWAY,
  SKIPPED,
} from '../src/components/DomainSelector/checkSentences';
import { CHECKS, type CheckResult, testProvider } from '../src/components/DomainSelector/providerTest';
import { loadUrl } from '../src/swarm/client';
import { createSwarmClient } from '../src/swarm/createSwarmClient';
import type { Stream } from '../src/types/stream';

const GW = 'https://gateway.example.com';
const OWNER = 'a1'.repeat(20);
const CATALOG = { owner: 'c2'.repeat(20), topic: 'test-catalog' };
const CATALOG_INDEX = 7;
const SEGMENT = 'ef'.repeat(32);
const PICTURE = 'cd'.repeat(32);
const PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.0,', SEGMENT, '#EXT-X-ENDLIST'].join('\n');

/** A finished single-rendition stream, its final playlist at a slot the entry names. */
const RECORDED: Stream = {
  owner: OWNER,
  topic: 'test-recording',
  title: 'Recorded talk',
  timestamp: Date.UTC(2026, 9, 1),
  mediatype: 'video',
  state: 'vod',
  index: 3,
  thumbnail: PICTURE,
};

const slot = (owner: string, topic: string, index: number) =>
  `${GW}/${feedSlotPath(owner, Topic.fromString(topic), FeedIndex.fromBigInt(BigInt(index)))}`;

/** What one request is answered with: a response, a refusal as a browser reports one, or nothing. */
type Answer = Response | 'refuse';

/** A gateway holding the stream list and the recording, with any URL the test names answered its own way. */
function gateway(override: (url: string) => Answer | undefined = () => undefined, streams = [RECORDED]): typeof fetch {
  const held = new Map<string, () => Response>([
    [`${GW}/health`, () => Response.json({ status: 'ok', version: '2.8.2' })],
    [
      `${GW}/${nextFeedRequest(CATALOG.owner, Topic.fromString(CATALOG.topic), null).path}`,
      () =>
        new Response(JSON.stringify(streams), {
          headers: { 'swarm-feed-index': CATALOG_INDEX.toString(16).padStart(16, '0') },
        }),
    ],
    [slot(OWNER, RECORDED.topic, 3), () => new Response(PLAYLIST)],
    [`${GW}/bytes/${SEGMENT}`, () => new Response(new Uint8Array([0x47]))],
    [`${GW}/bzz/${PICTURE}/`, () => new Response(new Uint8Array([0x89]))],
  ]);
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const answer = override(url) ?? held.get(url)?.();
    if (answer === 'refuse') {
      throw new TypeError('Failed to fetch');
    }
    return answer ?? new Response('', { status: 404 });
  }) as typeof fetch;
}

interface Run {
  readonly fetcher: typeof fetch;
  readonly knownStreams?: readonly Stream[];
  readonly address?: string;
  readonly pageProtocol?: string;
  readonly now?: () => number;
}

async function run({
  fetcher,
  knownStreams = [],
  address = GW,
  pageProtocol = 'https:',
  now,
}: Run): Promise<Record<string, CheckResult>> {
  const client = createSwarmClient(
    {
      gateways: [{ id: 'tested', kind: 'bee-http', url: address }],
      defaultId: 'tested',
      fallbackId: null,
      kinds: ['bee-http'],
    },
    { environment: { fetcher } },
  );
  const results = await testProvider({
    client,
    address,
    catalog: CATALOG,
    knownStreams,
    pageProtocol,
    now,
    loadUrl: (url, options) => loadUrl(url, { ...options, fetcher }),
  });
  expect(results.map(({ check }) => check)).toEqual([...CHECKS]);
  return Object.fromEntries(results.map((result) => [result.check, result]));
}

const TITLE = '“Recorded talk”';

describe("the node picker's Test", () => {
  it('checks the connection, the stream list, the video, the previews and the pictures, and no chat', () => {
    expect(CHECKS).toEqual(['connection', 'stream-list', 'player', 'previews', 'thumbnails']);
  });

  it('passes every feature the gateway holds, and says what each loaded', async () => {
    const results = await run({ fetcher: gateway() });

    expect(results.connection).toEqual({
      check: 'connection',
      outcome: 'passed',
      sentence: expect.stringMatching(/^The gateway answered in \d+ ms\.$/),
    });
    expect(results['stream-list']).toEqual({
      check: 'stream-list',
      outcome: 'passed',
      sentence: 'The stream list loaded: 1 stream, entry 7.',
    });
    expect(results.player).toEqual({
      check: 'player',
      outcome: 'passed',
      sentence: `The video loaded: a playlist of ${TITLE} and one segment.`,
    });
    expect(results.previews).toEqual({
      check: 'previews',
      outcome: 'passed',
      sentence: `Previews loaded: the preview playlist of ${TITLE}.`,
    });
    expect(results.thumbnails).toEqual({
      check: 'thumbnails',
      outcome: 'passed',
      sentence: `Pictures loaded: the picture of ${TITLE}.`,
    });
  });

  it('says a gateway that cannot be reached may be refusing this site, on every check', async () => {
    const results = await run({ fetcher: gateway(() => 'refuse'), knownStreams: [RECORDED] });

    for (const check of CHECKS) {
      expect(results[check], check).toEqual({ check, outcome: 'failed', sentence: COULD_NOT_REACH });
    }
  });

  it('tests the other features on the list the page already shows when this gateway cannot read it', async () => {
    const results = await run({
      fetcher: gateway((url) => (url.includes('/feeds/') ? new Response('', { status: 404 }) : undefined)),
      knownStreams: [RECORDED],
    });

    expect(results['stream-list']).toEqual({
      check: 'stream-list',
      outcome: 'failed',
      sentence:
        'This gateway answered that the stream list is not there. It may not have found it on the network yet. Test again in a minute, or pick another gateway.',
    });
    expect(results.player.outcome).toBe('passed');
    expect(results.thumbnails.outcome).toBe('passed');
  });

  it('says an address that answers with a web page is not a Swarm gateway', async () => {
    const page = () => new Response('<!doctype html><title>Some site</title>', { status: 200 });
    const results = await run({ fetcher: gateway(page), knownStreams: [RECORDED] });

    expect(results.connection.sentence).toBe(NOT_A_SWARM_GATEWAY);
    expect(results['stream-list'].sentence).toBe(NOT_A_SWARM_GATEWAY);
    expect(results.player.sentence).toBe(NOT_A_SWARM_GATEWAY);
  });

  it('names the status a failing gateway answered, and what to do', async () => {
    const results = await run({
      fetcher: gateway((url) => (url.includes('/bytes/') ? new Response('', { status: 502 }) : undefined)),
    });

    expect(results.player).toEqual({
      check: 'player',
      outcome: 'failed',
      sentence: 'The gateway answered with an error (HTTP 502). Test again in a minute, or pick another gateway.',
    });
    expect(results['stream-list'].outcome).toBe('passed');
  });

  it('says a gateway asked to be asked less often', async () => {
    const results = await run({
      fetcher: gateway((url) => (url.includes('/bzz/') ? new Response('', { status: 429 }) : undefined)),
    });

    expect(results.thumbnails).toEqual({
      check: 'thumbnails',
      outcome: 'failed',
      sentence: 'This gateway asked to be asked less often. Wait a minute, then test again.',
    });
  });

  it('skips every stream check on an empty list', async () => {
    const results = await run({ fetcher: gateway(undefined, []) });

    expect(results['stream-list'].outcome).toBe('passed');
    for (const check of ['player', 'previews', 'thumbnails'] as const) {
      expect(results[check]).toEqual({ check, outcome: 'skipped', sentence: SKIPPED.noStreams });
    }
  });

  it('refuses before asking anything when the browser would block a plain http gateway', async () => {
    const asked: string[] = [];
    const results = await run({
      fetcher: (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response('');
      }) as typeof fetch,
      address: 'http://192.0.2.10:1633',
      pageProtocol: 'https:',
    });

    expect(Object.values(results).map(({ sentence }) => sentence)).toEqual(CHECKS.map(() => MIXED_CONTENT));
    expect(asked).toEqual([]);
  });
});

describe("the node picker's Test, on a live ladder", () => {
  const GROUP = 'test-ladder-master';
  const RUNG = 'test-ladder-240p';
  const NOW = Date.UTC(2026, 10, 2, 10, 0, 5);
  const PERIOD = markerPeriodAt(NOW) - 1;
  const LIVE: Stream = {
    owner: OWNER,
    topic: GROUP,
    title: 'Main stage',
    timestamp: NOW - 60_000,
    mediatype: 'video',
    state: 'live',
    renditions: [{ name: '240p', topic: RUNG, width: 426, height: 240, bandwidth: 400_000, avgBandwidth: 350_000 }],
  };
  const markerUrl = `${GW}/soc/${OWNER}/${ladderMarkerIdentifier(Topic.fromString(GROUP), PERIOD).toHex()}`;
  const marker = new TextDecoder().decode(
    encodeLadderMarker({
      v: 1,
      period: PERIOD,
      writtenAt: PERIOD * 10_000 + 250,
      rungs: { [Topic.fromString(RUNG).toHex()]: 42 },
    }),
  );

  it("reads the video through the ladder's time marker, as the player starts", async () => {
    const results = await run({
      fetcher: gateway(
        (url) => {
          if (url === markerUrl) {
            return new Response(marker);
          }
          return url === slot(OWNER, RUNG, 42) ? new Response(PLAYLIST) : undefined;
        },
        [LIVE],
      ),
      now: () => NOW,
    });

    expect(results.player).toEqual({
      check: 'player',
      outcome: 'passed',
      sentence: 'The video loaded: the time marker of “Main stage”, a playlist and one segment.',
    });
  });
});
