import { Bytes, ChunkBuilder, FeedIndex, PrivateKey, Span, Topic } from '@ethersphere/bee-js';
import { feedSlotPath, makeFeedIdentifier, nextFeedRequest } from '@swarm-hls-stream/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SwarmAnswer } from '../../src/swarm/answers';
import { BeeHttpProvider, LONGEST_RETRY_AFTER_MS } from '../../src/swarm/providers/bee-http/beeHttpProvider';
import { singleOwnerChunkAddress } from '../../src/swarm/singleOwnerChunk';
import {
  answeringFetch,
  type AskedLog,
  beeNotFound,
  FAKE_CHUNK,
  FAKE_DATE_MS,
  FAKE_GATEWAY,
  FAKE_HEAD_INDEX,
  FAKE_OWNER,
  FAKE_REFERENCE,
  FAKE_SOC_IDENTIFIER,
  FAKE_TOPIC,
  fakeBeeFetch,
  fakeBody,
  fakeEntryIdentifier,
  faultyFetch,
  silentFetch,
} from '../helpers/fakeBeeGateway';
import { type ContractHarness, describeProviderContract } from './providerContract';

const RETRY_AFTER_SECONDS = 3;

const PAGE_ORIGIN = 'http://viewer.example';

/** Obviously made up, so nothing a test names as absent can be stored anywhere. */
const ABSENT_ADDRESS = 'ab'.repeat(32);
const ABSENT_REFERENCE = 'cd'.repeat(32);

const FEED_ENTRY_INDEX = 2;

function beeHarness(): ContractHarness {
  return {
    world: {
      feedHead: {
        owner: FAKE_OWNER,
        topic: FAKE_TOPIC,
        index: FAKE_HEAD_INDEX,
        bytes: fakeBody(nextFeedRequest(FAKE_OWNER, FAKE_TOPIC, null).path),
        serverTimeMs: FAKE_DATE_MS,
      },
      feedEntry: {
        owner: FAKE_OWNER,
        topic: FAKE_TOPIC,
        index: FEED_ENTRY_INDEX,
        bytes: fakeBody(feedSlotPath(FAKE_OWNER, FAKE_TOPIC, FeedIndex.fromBigInt(BigInt(FEED_ENTRY_INDEX)))),
      },
      soc: {
        owner: FAKE_OWNER,
        identifier: FAKE_SOC_IDENTIFIER,
        bytes: fakeBody(`soc/${FAKE_OWNER}/${FAKE_SOC_IDENTIFIER}`),
      },
      chunk: { address: FAKE_CHUNK, bytes: fakeBody(`chunks/${FAKE_CHUNK}`) },
      bytes: { reference: FAKE_REFERENCE, bytes: fakeBody(`bytes/${FAKE_REFERENCE}`) },
      absent: {
        owner: FAKE_OWNER,
        topic: Topic.fromString('nothing-was-published-here'),
        index: 7,
        identifier: ABSENT_REFERENCE,
        address: ABSENT_ADDRESS,
        reference: ABSENT_REFERENCE,
      },
    },
    retryAfterMs: RETRY_AFTER_SECONDS * 1000,
    provider: (behaviour) => {
      const fetcher = {
        served: () => fakeBeeFetch(),
        silent: () => silentFetch(),
        faulty: () => faultyFetch(),
        'rate-limited': () => answeringFetch(429, { 'retry-after': String(RETRY_AFTER_SECONDS) }),
      }[behaviour]();
      return new BeeHttpProvider({ baseUrl: FAKE_GATEWAY, fetcher, pageOrigin: PAGE_ORIGIN });
    },
  };
}

describeProviderContract('Bee over HTTP', beeHarness);

function provider(fetcher: typeof fetch, baseUrl = FAKE_GATEWAY): BeeHttpProvider {
  return new BeeHttpProvider({ baseUrl, fetcher, pageOrigin: PAGE_ORIGIN });
}

const urlOf = (path: string) => `${FAKE_GATEWAY}/${path}`;

describe('the Bee HTTP provider', () => {
  it('asks the same paths the player and the stream list have always asked', async () => {
    const log: AskedLog = { urls: [] };
    const bee = provider(fakeBeeFetch(log));

    await bee.readFeedHead(FAKE_OWNER, FAKE_TOPIC);
    await bee.readFeedEntry(FAKE_OWNER, FAKE_TOPIC, 3);
    await bee.readSoc(FAKE_OWNER, FAKE_SOC_IDENTIFIER);
    await bee.readChunk(FAKE_CHUNK);
    await bee.readBytes(FAKE_REFERENCE);

    expect(log.urls).toEqual([
      urlOf(nextFeedRequest(FAKE_OWNER, FAKE_TOPIC, null).path),
      urlOf(feedSlotPath(FAKE_OWNER, FAKE_TOPIC, FeedIndex.fromBigInt(3n))),
      urlOf(`soc/${FAKE_OWNER}/${FAKE_SOC_IDENTIFIER}`),
      urlOf(`chunks/${FAKE_CHUNK}`),
      urlOf(`bytes/${FAKE_REFERENCE}`),
    ]);
  });

  it('reads a feed entry as the single-owner chunk its owner wrote under the topic and index', async () => {
    const log: AskedLog = { urls: [] };

    await provider(fakeBeeFetch(log)).readFeedEntry(FAKE_OWNER, FAKE_TOPIC, 1);

    expect(log.urls).toEqual([urlOf(`soc/${FAKE_OWNER}/${fakeEntryIdentifier(1)}`)]);
  });

  it('reads a gateway on this site, such as /bee, as a path on the page', async () => {
    const log: AskedLog = { urls: [] };

    await provider(fakeBeeFetch(log), '/bee').readBytes(FAKE_REFERENCE);

    expect(log.urls).toEqual([`/bee/bytes/${FAKE_REFERENCE}`]);
  });

  it('answers not found for a chunk Bee answers 500 for, as it does for a chunk never written', async () => {
    const answer = await provider(answeringFetch(500, {}, '{"code":500,"message":"read chunk failed"}')).readChunk(
      FAKE_CHUNK,
    );

    expect(answer).toEqual({ kind: 'not-found', serverTimeMs: null });
  });

  it('takes a 500 for a feed, a single-owner chunk or bytes as a fault of the node', async () => {
    const bee = provider(answeringFetch(500));
    const reads = [
      bee.readFeedHead(FAKE_OWNER, FAKE_TOPIC),
      bee.readFeedEntry(FAKE_OWNER, FAKE_TOPIC, 0),
      bee.readSoc(FAKE_OWNER, FAKE_SOC_IDENTIFIER),
      bee.readBytes(FAKE_REFERENCE),
    ];

    for (const answer of await Promise.all(reads)) {
      expect(answer).toEqual({ kind: 'unavailable', cause: { kind: 'status', status: 500 } });
    }
  });

  it("reads a Retry-After given as a date against the answer's own clock", async () => {
    const date = new Date(FAKE_DATE_MS).toUTCString();
    const later = new Date(FAKE_DATE_MS + 7_000).toUTCString();

    const answer = await provider(answeringFetch(429, { date, 'retry-after': later })).readBytes(FAKE_REFERENCE);

    expect(answer).toEqual({ kind: 'rate-limited', retryAfterMs: 7_000, serverTimeMs: FAKE_DATE_MS });
  });

  it('answers rate limited with no wait when Retry-After is missing or unreadable', async () => {
    for (const headers of [{}, { 'retry-after': 'soon' }]) {
      const answer = await provider(answeringFetch(429, headers)).readBytes(FAKE_REFERENCE);

      expect(answer).toMatchObject({ kind: 'rate-limited', retryAfterMs: null });
    }
  });

  it('answers unsupported for a feed index that is not a whole number from zero up, and asks nothing', async () => {
    const log: AskedLog = { urls: [] };
    const bee = provider(fakeBeeFetch(log));

    for (const index of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await bee.readFeedEntry(FAKE_OWNER, FAKE_TOPIC, index)).toEqual({ kind: 'unsupported' });
    }
    expect(log.urls).toEqual([]);
  });

  it('caps the wait Retry-After asks for, so one answer cannot stall a feed for an hour', async () => {
    const answer = await provider(answeringFetch(429, { 'retry-after': '3600' })).readBytes(FAKE_REFERENCE);

    expect(answer).toMatchObject({ kind: 'rate-limited', retryAfterMs: LONGEST_RETRY_AFTER_MS });
  });

  it('answers rate limited with no wait when Retry-After is too large to be a number or is negative', async () => {
    const date = new Date(FAKE_DATE_MS).toUTCString();
    for (const retryAfter of ['9'.repeat(400), '-5']) {
      const answer = await provider(answeringFetch(429, { date, 'retry-after': retryAfter })).readBytes(FAKE_REFERENCE);

      expect(answer).toMatchObject({ kind: 'rate-limited', retryAfterMs: null });
    }
  });

  it('gives a feed index only when the answer carries one', async () => {
    const answer = await provider(fakeBeeFetch()).readBytes(FAKE_REFERENCE);

    expect(answer).toMatchObject({ kind: 'content', feedIndex: null });
  });

  it('gives segment URLs as absolute addresses under /bytes, as the playlist lines carry them', () => {
    const bee = provider(fakeBeeFetch(), '/bee/');

    expect(bee.urlFor(FAKE_REFERENCE, 'segment')).toBe(`${PAGE_ORIGIN}/bee/bytes/${FAKE_REFERENCE}`);
    expect(bee.urlFor(FAKE_REFERENCE, 'preview-segment')).toBe(`${PAGE_ORIGIN}/bee/bytes/${FAKE_REFERENCE}`);
  });

  it('gives an absolute gateway its own segment URLs, with any run of trailing slashes dropped', () => {
    // A rooted path resolved against the playlist's own swarm:// URL would keep the owner as a host,
    // and a doubled slash before bytes would read as a host called bytes.
    expect(provider(fakeBeeFetch(), 'https://gateway.example//').urlFor(FAKE_REFERENCE, 'segment')).toBe(
      `https://gateway.example/bytes/${FAKE_REFERENCE}`,
    );
    expect(provider(fakeBeeFetch(), '/bee///').urlFor(FAKE_REFERENCE, 'segment')).toBe(
      `${PAGE_ORIGIN}/bee/bytes/${FAKE_REFERENCE}`,
    );
  });

  it('gives a picture URL under /bzz with the reference encoded and the trailing slash', () => {
    const bee = provider(fakeBeeFetch(), '/bee');

    expect(bee.urlFor(` ${FAKE_REFERENCE} `, 'thumbnail')).toBe(`/bee/bzz/${FAKE_REFERENCE}/`);
    expect(bee.urlFor('../x?y', 'thumbnail')).toBe('/bee/bzz/..%2Fx%3Fy/');
  });

  it('can make every read, gives URLs and runs no node in the tab', () => {
    expect(provider(fakeBeeFetch()).capabilities).toEqual({
      feedHead: true,
      feedEntry: true,
      soc: true,
      chunk: true,
      bytes: true,
      urls: true,
      inTab: false,
    });
  });

  it('is ready from the start, and starting and stopping it changes nothing', async () => {
    const bee = provider(fakeBeeFetch());

    expect(bee.status()).toEqual({ state: 'ready' });
    await bee.start();
    await bee.stop();
    expect(bee.status()).toEqual({ state: 'ready' });
  });

  describe('with no fetcher injected', () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('reads through the global fetch, called bare as the browser requires', async () => {
      const global = vi.fn(function (this: unknown) {
        expect(this).toBeUndefined();
        return Promise.resolve(new Response(new Uint8Array([9])));
      });
      globalThis.fetch = global as unknown as typeof fetch;

      const answer = await new BeeHttpProvider({ baseUrl: '/bee', pageOrigin: PAGE_ORIGIN }).readBytes(FAKE_REFERENCE);

      expect(global).toHaveBeenCalledTimes(1);
      expect(answer).toMatchObject({ kind: 'content', bytes: new Uint8Array([9]) });
    });
  });

  describe('probing the node', () => {
    it('is ok when /health answers as Bee does', async () => {
      const log: AskedLog = { urls: [] };
      const fetcher = (async (input: RequestInfo | URL) => {
        log.urls.push(String(input));
        return new Response('{"status":"ok","version":"2.8.2"}');
      }) as typeof fetch;

      expect(await provider(fetcher).probe()).toMatchObject({ kind: 'ok' });
      expect(log.urls).toEqual([`${FAKE_GATEWAY}/health`, `${FAKE_GATEWAY}/readiness`, `${FAKE_GATEWAY}/peers`]);
    });

    it('tells a refusal, something that is not Bee, silence and no answer apart', async () => {
      expect(await provider(answeringFetch(403)).probe()).toEqual({ kind: 'rejected', status: 403 });
      expect(await provider(answeringFetch(200, {}, '<html>')).probe()).toEqual({ kind: 'not-swarm' });
      expect(await provider(silentFetch()).probe({ timeoutMs: 20 })).toEqual({ kind: 'timed-out' });
      expect(await provider(faultyFetch()).probe()).toEqual({ kind: 'unreachable' });
    });
  });
});

/**
 * Chrome lets an https page reach a plain http node on the local network only when the request says it
 * is meant for the local network, and fails one whose mark does not match where the address is.
 */
describe('a Bee node on the local network over plain http', () => {
  function initsSentBy(baseUrl: string) {
    const inits: (RequestInit | undefined)[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init);
      return new Response('{"status":"ok","version":"2.8.2"}');
    }) as typeof fetch;
    return { inits, provider: new BeeHttpProvider({ baseUrl, fetcher, pageOrigin: PAGE_ORIGIN }) };
  }

  it('marks every read and the probe as meant for the local network', async () => {
    const { inits, provider } = initsSentBy('http://192.168.1.20:1633');

    await provider.probe();
    await provider.readChunk(ABSENT_ADDRESS);

    // The probe's health, readiness and peers, then the chunk.
    expect(inits).toHaveLength(4);
    for (const init of inits) {
      expect(init).toMatchObject({ targetAddressSpace: 'local' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('marks nothing for a node on this computer, over https, or on this site', async () => {
    for (const baseUrl of ['http://localhost:1633', 'https://192.168.1.20:1633', 'https://bee.example.com', '/bee']) {
      const { inits, provider } = initsSentBy(baseUrl);
      await provider.probe();
      expect(inits[0]).not.toHaveProperty('targetAddressSpace');
    }
  });
});

/** A throwaway key that signs only these test chunks. */
const ENTRY_KEY = new PrivateKey('b2'.repeat(32));
const ENTRY_OWNER = ENTRY_KEY.publicKey().address().toHex();
const ENTRY_TOPIC = Topic.fromString('a-rung-of-a-recording');
const ENTRY_ID = makeFeedIdentifier(ENTRY_TOPIC, FeedIndex.fromBigInt(5n));
const ENTRY_ADDRESS = singleOwnerChunkAddress(ENTRY_ID, ENTRY_OWNER);
const ENTRY_PATH = `soc/${ENTRY_OWNER}/${ENTRY_ID.toHex()}`;
const PLAYLIST_TEXT = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n';
const PUBLIC_GATEWAY = 'https://gateway.example.com';
const NOT_FOUND_ANSWER: SwarmAnswer = { kind: 'not-found', serverTimeMs: null };

function wrappedChunk(payload: Uint8Array, span: bigint): ChunkBuilder {
  const wrapped = new ChunkBuilder(span);
  wrapped.writer.buffer.set(payload);
  return wrapped;
}

/** The single-owner chunk an owner writes, whole, as Bee's `/chunks` serves it. */
function signedChunk(payload: Uint8Array, span = BigInt(payload.length), key = ENTRY_KEY): Uint8Array {
  const signature = key.sign(Bytes.concat(ENTRY_ID.toUint8Array(), wrappedChunk(payload, span).hash().toUint8Array()));
  return Bytes.concat(ENTRY_ID.toUint8Array(), signature.toUint8Array(), Span.fromBigInt(span).toUint8Array(), payload);
}

/** The front door of a public gateway, which refuses `/soc` with plain text before Bee sees it. */
const refusedRoute = () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
const servedBytes = (bytes: Uint8Array) => () => new Response(bytes.slice());

/** Answers each path it is given, `/soc` with a front door's refusal unless given, and Bee's 404 for the rest. */
function publicGateway(served: Record<string, () => Response>, log: AskedLog = { urls: [] }): BeeHttpProvider {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    log.urls.push(url);
    const path = url.slice(PUBLIC_GATEWAY.length + 1);
    const answer = served[path];
    if (answer) {
      return answer();
    }
    return path.startsWith('soc/') ? refusedRoute() : beeNotFound();
  }) as typeof fetch;
  return provider(fetcher, PUBLIC_GATEWAY);
}

/** A gateway serving the entry's chunk with a tree's root payload, and `body` at that root's address. */
function treeGateway(stored: bigint, body: Uint8Array): BeeHttpProvider {
  const root = new Uint8Array(64).fill(7);
  return publicGateway({
    [`chunks/${ENTRY_ADDRESS}`]: servedBytes(signedChunk(root, stored)),
    [`bytes/${wrappedChunk(root, stored).hash().toHex()}`]: servedBytes(body),
  });
}

const textOf = (answer: SwarmAnswer) => (answer.kind === 'content' ? new TextDecoder().decode(answer.bytes) : answer);

describe('a gateway whose front door refuses the /soc route', () => {
  it('reads a feed entry by its chunk address, and goes there first from then on', async () => {
    const log: AskedLog = { urls: [] };
    const payload = new TextEncoder().encode(PLAYLIST_TEXT);
    const gateway = publicGateway({ [`chunks/${ENTRY_ADDRESS}`]: servedBytes(signedChunk(payload)) }, log);

    expect(textOf(await gateway.readFeedEntry(ENTRY_OWNER, ENTRY_TOPIC, 5))).toBe(PLAYLIST_TEXT);
    expect(textOf(await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex()))).toBe(PLAYLIST_TEXT);
    expect(log.urls).toEqual([
      `${PUBLIC_GATEWAY}/${ENTRY_PATH}`,
      `${PUBLIC_GATEWAY}/chunks/${ENTRY_ADDRESS}`,
      `${PUBLIC_GATEWAY}/chunks/${ENTRY_ADDRESS}`,
    ]);
  });

  it.each([
    ['an empty body', ''],
    ['JSON of another shape than Bee errors in', '{"error":"not found"}'],
  ])('takes a 404 on /soc with %s as the route refused', async (_, body) => {
    const log: AskedLog = { urls: [] };
    const payload = new TextEncoder().encode(PLAYLIST_TEXT);
    const gateway = publicGateway(
      {
        [ENTRY_PATH]: () => new Response(body, { status: 404 }),
        [`chunks/${ENTRY_ADDRESS}`]: servedBytes(signedChunk(payload)),
      },
      log,
    );

    expect(textOf(await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex()))).toBe(PLAYLIST_TEXT);
    expect(log.urls).toEqual([`${PUBLIC_GATEWAY}/${ENTRY_PATH}`, `${PUBLIC_GATEWAY}/chunks/${ENTRY_ADDRESS}`]);
  });

  it('reads at /soc again once a source that refused it serves it, after its chunk address is refused too', async () => {
    const log: AskedLog = { urls: [] };
    const payload = new TextEncoder().encode(PLAYLIST_TEXT);
    const served: Record<string, () => Response> = { [`chunks/${ENTRY_ADDRESS}`]: servedBytes(signedChunk(payload)) };
    const gateway = publicGateway(served, log);

    expect(textOf(await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex()))).toBe(PLAYLIST_TEXT);
    served[`chunks/${ENTRY_ADDRESS}`] = refusedRoute;
    served[ENTRY_PATH] = servedBytes(payload);
    expect((await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex())).kind).toBe('unavailable');
    expect(textOf(await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex()))).toBe(PLAYLIST_TEXT);
    expect(log.urls).toEqual([
      `${PUBLIC_GATEWAY}/${ENTRY_PATH}`,
      `${PUBLIC_GATEWAY}/chunks/${ENTRY_ADDRESS}`,
      `${PUBLIC_GATEWAY}/chunks/${ENTRY_ADDRESS}`,
      `${PUBLIC_GATEWAY}/${ENTRY_PATH}`,
    ]);
  });

  it('answers not found for an entry nobody wrote, read by its chunk address', async () => {
    expect(await publicGateway({}).readFeedEntry(ENTRY_OWNER, ENTRY_TOPIC, 5)).toEqual(NOT_FOUND_ANSWER);
  });

  it("takes Bee's own JSON 404 as not found and asks nothing more, so a gateway serving /soc pays no extra read", async () => {
    const log: AskedLog = { urls: [] };
    const gateway = publicGateway({ [ENTRY_PATH]: beeNotFound }, log);

    expect(await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex())).toEqual(NOT_FOUND_ANSWER);
    expect(await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex())).toEqual(NOT_FOUND_ANSWER);
    expect(log.urls).toEqual([`${PUBLIC_GATEWAY}/${ENTRY_PATH}`, `${PUBLIC_GATEWAY}/${ENTRY_PATH}`]);
  });

  it('joins a body longer than one chunk from the bytes at its root address, as /soc does', async () => {
    const body = new Uint8Array(5000).fill(3);

    expect(await treeGateway(BigInt(body.length), body).readSoc(ENTRY_OWNER, ENTRY_ID.toHex())).toMatchObject({
      kind: 'content',
      bytes: body,
    });
  });

  it("joins an erasure-coded body, its root's address hashed over the span as stored", async () => {
    const body = new Uint8Array(4567).fill(4);
    const stored = BigInt(body.length) | (0x81n << 56n);

    expect(await treeGateway(stored, body).readSoc(ENTRY_OWNER, ENTRY_ID.toHex())).toMatchObject({
      kind: 'content',
      bytes: body,
    });
  });

  it('refuses a joined body of another length than the span names', async () => {
    const answer = await treeGateway(5000n, new Uint8Array(4999)).readSoc(ENTRY_OWNER, ENTRY_ID.toHex());

    expect(answer.kind).toBe('unavailable');
  });

  it("refuses a chunk that is not the owner's, signed by another key", async () => {
    const forged = signedChunk(new TextEncoder().encode(PLAYLIST_TEXT), undefined, new PrivateKey('c3'.repeat(32)));
    const gateway = publicGateway({ [`chunks/${ENTRY_ADDRESS}`]: servedBytes(forged) });

    expect(await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex())).toMatchObject({
      kind: 'unavailable',
      cause: { kind: 'network' },
    });
  });

  it('says what failed when the bytes served cannot be checked at all, such as too few for a chunk', async () => {
    const gateway = publicGateway({ [`chunks/${ENTRY_ADDRESS}`]: servedBytes(new Uint8Array(40)) });
    const answer = await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex());

    expect(answer.kind === 'unavailable' && answer.cause.kind === 'network' && String(answer.cause.error)).toMatch(
      /could not be checked as .*, since a single-owner chunk is at least 105 bytes/,
    );
  });

  it('is a fault when both routes are refused, and asks /soc first again on the next read', async () => {
    const log: AskedLog = { urls: [] };
    const gateway = publicGateway({ [`chunks/${ENTRY_ADDRESS}`]: refusedRoute }, log);

    expect(await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex())).toEqual({
      kind: 'unavailable',
      cause: { kind: 'status', status: 404 },
    });
    await gateway.readSoc(ENTRY_OWNER, ENTRY_ID.toHex());
    expect(log.urls).toEqual([
      `${PUBLIC_GATEWAY}/${ENTRY_PATH}`,
      `${PUBLIC_GATEWAY}/chunks/${ENTRY_ADDRESS}`,
      `${PUBLIC_GATEWAY}/${ENTRY_PATH}`,
      `${PUBLIC_GATEWAY}/chunks/${ENTRY_ADDRESS}`,
    ]);
  });
});
