import { FeedIndex, Topic } from '@ethersphere/bee-js';
import {
  encodeLadderMarker,
  feedSlotPath,
  ladderMarkerIdentifier,
  markerPeriodAt,
  nextFeedRequest,
} from '@swarm-hls-stream/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_BY_CONTENT,
  COULD_NOT_REACH,
  MIXED_CONTENT,
  NO_SEGMENT,
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

/** Where the player opens a stream the list names no renditions for: its feed head. */
const RECORDED_HEAD = `${GW}/${nextFeedRequest(OWNER, Topic.fromString(RECORDED.topic), null).path}`;

const slot = (owner: string, topic: string, index: number) =>
  `${GW}/${feedSlotPath(owner, Topic.fromString(topic), FeedIndex.fromBigInt(BigInt(index)))}`;

/** What one request is answered with: a response, a refusal as a browser reports one, or nothing. */
type Answer = Response | 'refuse' | 'hang';

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
    [RECORDED_HEAD, () => new Response(PLAYLIST, { headers: { 'swarm-feed-index': '0000000000000003' } })],
    [`${GW}/bytes/${SEGMENT}`, () => new Response(new Uint8Array([0x47]))],
    [`${GW}/bzz/${PICTURE}/`, () => new Response(new Uint8Array([0x89]))],
  ]);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const answer = override(url) ?? held.get(url)?.();
    if (answer === 'refuse') {
      throw new TypeError('Failed to fetch');
    }
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
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
  /** Whether the gateway is the viewer's own node rather than one the build offers. Own by default. */
  readonly isOwnNode?: boolean;
}

async function run({
  fetcher,
  knownStreams = [],
  address = GW,
  pageProtocol = 'https:',
  now,
  isOwnNode = true,
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
    isOwnNode,
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
      fetcher: gateway((url) => (url === CATALOG_HEAD ? new Response('', { status: 404 }) : undefined)),
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

describe("the node picker's Test, on masters that name masters", () => {
  it('follows them at most three levels deep', async () => {
    const LOOP = 'test-loop-master';
    const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=400000', `swarm://${OWNER}/${LOOP}`].join('\n');
    // The player opens a stream with no renditions in the list by its feed head, and follows a master's variants.
    const headOfLoop = `${GW}/${nextFeedRequest(OWNER, Topic.fromString(LOOP), null).path}`;
    let masterReads = 0;
    const stream: Stream = {
      owner: OWNER,
      topic: LOOP,
      title: 'Loop',
      timestamp: Date.UTC(2026, 9, 1),
      mediatype: 'video',
      state: 'vod',
    };
    const fetcher = gateway(
      (url) => {
        // Answers a few dozen times only, so a reader with no limit ends rather than running forever.
        if ((url === slot(OWNER, LOOP, 0) || url === headOfLoop) && masterReads < 30) {
          masterReads += 1;
          return new Response(master);
        }
        return undefined;
      },
      [stream],
    );

    const results = await run({ fetcher });

    // Four by the video check, the head and three masters it follows, and two by the previews check, which follows one.
    expect(masterReads).toBe(6);
    expect(results.player).toEqual({ check: 'player', outcome: 'failed', sentence: NO_SEGMENT('Loop') });
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

/** Answers the URLs `delayOf` names that many milliseconds late, by the test's clock, unless the read is stopped first. */
function slowed(fetcher: typeof fetch, delayOf: (url: string) => number | undefined): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const delayMs = delayOf(String(input));
    if (delayMs === undefined) {
      return fetcher(input, init);
    }
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(fetcher(input, init)), delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  }) as typeof fetch;
}

/** The Test on a clock the test moves, so a read of seconds takes none. */
async function runOnTestClock(args: Run): Promise<Record<string, CheckResult>> {
  vi.useFakeTimers();
  const pending = run(args);
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

const CATALOG_HEAD = `${GW}/${nextFeedRequest(CATALOG.owner, Topic.fromString(CATALOG.topic), null).path}`;

describe('the window the Test gives each read', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for each read as long as the viewer waits for it, so a 6 s stream list passes', async () => {
    const results = await runOnTestClock({
      fetcher: slowed(gateway(), (url) => (url === CATALOG_HEAD ? 6_000 : undefined)),
    });

    expect(results['stream-list']).toEqual({
      check: 'stream-list',
      outcome: 'passed',
      sentence: 'The stream list loaded: 1 stream, entry 7.',
    });
  });

  it('fails a read that has not answered once the 10 s the viewer would wait are up', async () => {
    const results = await runOnTestClock({
      fetcher: gateway((url) => (url === CATALOG_HEAD ? 'hang' : undefined)),
      knownStreams: [RECORDED],
    });

    expect(results['stream-list']).toEqual({
      check: 'stream-list',
      outcome: 'failed',
      sentence:
        'The gateway did not answer in 10 s. It may be busy or still starting. Test again in a minute, or pick another gateway.',
    });
  });

  it("asks the viewer's own node for its health for 5 s, as the picker does", async () => {
    const results = await runOnTestClock({ fetcher: gateway((url) => (url === `${GW}/health` ? 'hang' : undefined)) });

    expect(results.connection).toEqual({
      check: 'connection',
      outcome: 'failed',
      sentence:
        'The gateway did not answer in 5 s. It may be busy or still starting. Test again in a minute, or pick another gateway.',
    });
  });
});

/**
 * A gateway the build offers, as the event gateway behaves: it serves stream paths only, so `/health` is refused with
 * no CORS header, which a browser reports as no answer, and a head lookup on a long feed takes 6 s.
 */
function eventGateway(
  asked: string[] = [],
  override: (url: string) => Answer | undefined = () => undefined,
): typeof fetch {
  return slowed(
    gateway((url) => {
      asked.push(url);
      return url === `${GW}/health` ? 'refuse' : override(url);
    }),
    (url) => (url === CATALOG_HEAD ? 6_000 : undefined),
  );
}

describe("the node picker's Test, on a gateway the build offers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the connection by the content it served, and never asks for its health', async () => {
    const asked: string[] = [];
    const results = await runOnTestClock({ fetcher: eventGateway(asked), isOwnNode: false });

    expect(results.connection).toEqual({ check: 'connection', outcome: 'passed', sentence: CONNECTED_BY_CONTENT });
    expect(results['stream-list'].outcome).toBe('passed');
    expect(asked).not.toContain(`${GW}/health`);
  });

  it('says it could not be reached when no read got an answer', async () => {
    const results = await run({ fetcher: gateway(() => 'refuse'), knownStreams: [RECORDED], isOwnNode: false });

    expect(results.connection).toEqual({ check: 'connection', outcome: 'failed', sentence: COULD_NOT_REACH });
  });

  it('says it did not answer in time when its reads ran out of time', async () => {
    const results = await runOnTestClock({
      fetcher: gateway(() => 'hang'),
      knownStreams: [RECORDED],
      isOwnNode: false,
    });

    expect(results.connection).toEqual({
      check: 'connection',
      outcome: 'failed',
      sentence:
        'The gateway did not answer in 10 s. It may be busy or still starting. Test again in a minute, or pick another gateway.',
    });
  });

  it('says an address that answers with a web page is not a Swarm gateway', async () => {
    const page = () => new Response('<!doctype html><title>Some site</title>', { status: 200 });
    const results = await run({ fetcher: gateway(page), knownStreams: [RECORDED], isOwnNode: false });

    expect(results.connection).toEqual({ check: 'connection', outcome: 'failed', sentence: NOT_A_SWARM_GATEWAY });
  });
});

describe("the node picker's Test, on a recording", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads it as the player opens it, by its feed head, and waits the 6 s that head takes', async () => {
    const asked: string[] = [];
    const results = await runOnTestClock({
      fetcher: slowed(
        gateway((url) => {
          asked.push(url);
          return url === slot(OWNER, RECORDED.topic, 3) ? new Response('', { status: 404 }) : undefined;
        }),
        (url) => (url === RECORDED_HEAD ? 6_000 : undefined),
      ),
      isOwnNode: false,
    });

    expect(results.player).toEqual({
      check: 'player',
      outcome: 'passed',
      sentence: `The video loaded: a playlist of ${TITLE} and one segment.`,
    });
    expect(asked.filter((url) => url === RECORDED_HEAD)).toHaveLength(1);
  });
});
