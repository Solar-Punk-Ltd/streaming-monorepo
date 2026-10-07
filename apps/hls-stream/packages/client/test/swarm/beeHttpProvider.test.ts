import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath, nextFeedRequest } from '@swarm-hls-stream/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BeeHttpProvider, LONGEST_RETRY_AFTER_MS } from '../../src/swarm/providers/bee-http/beeHttpProvider';
import {
  answeringFetch,
  type AskedLog,
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
      expect(log.urls).toEqual([`${FAKE_GATEWAY}/health`]);
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

    expect(inits.length).toBeGreaterThanOrEqual(2);
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
