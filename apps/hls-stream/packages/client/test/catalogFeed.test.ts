import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath, nextFeedRequest, resolvedFeedIndex } from '@swarm-hls-stream/shared';
import { describe, expect, it } from 'vitest';

import type { SwarmAnswer } from '@/swarm/answers';
import type { SwarmReader } from '@/swarm/client';
import { CatalogFeedReader } from '@/utils/catalogFeed';
import { FetchTimeoutError } from '@/utils/fetchTimeoutError';

import type { PathResponse } from './helpers/playerReader';

/**
 * That the catalog is followed by walking rather than by resolving its head on every poll.
 *
 * The catalog is polled for as long as a page is open, gains a slot per broadcast lifecycle event, and
 * is never reset. Resolving the head each time costs a lookup that grows with the feed: measured at
 * about 1s on a one slot feed and 5s at a thousand, against 4ms for a slot read by address.
 *
 * These drive the reader against a stubbed fetcher and assert on the URLs it asks for, because the
 * whole change is *which request is made*, and a test that only checked the returned body would pass
 * against the version that never stopped resolving the head.
 */

const OWNER = '1f6e0f8a9b7c3d5e2a4b6c8d0e1f2a3b4c5d6e7f';
const TOPIC = Topic.fromString('catalog-test');

function respond(overrides: Partial<PathResponse> = {}): PathResponse {
  return { ok: true, status: 200, headers: new Headers(), text: '[]', ...overrides };
}

/**
 * A stub that records every URL and answers from a queue, so ordering is assertable.
 *
 * A queued `Error` is thrown rather than returned, which is how a transport failure or a timeout
 * reaches the reader. That is a different path from `ok: false`, and only the latter was ever driven.
 */
function stubFetcher(replies: (PathResponse | Error)[]) {
  const urls: string[] = [];
  const fetcher = async (url: string): Promise<PathResponse> => {
    urls.push(url);
    const reply = replies.shift();
    if (!reply) {
      throw new Error(`unexpected request to ${url}`);
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  return { urls, fetcher };
}

/** Every request is held until the test answers it, so two reads can be in flight at once. */
function deferredFetcher() {
  const pending: { url: string; answer: (response: PathResponse) => void }[] = [];
  const fetcher = (url: string) =>
    new Promise<PathResponse>((resolve) => {
      pending.push({ url, answer: resolve });
    });
  return { pending, fetcher };
}

type Fetcher = (url: string) => Promise<PathResponse>;

/** A stub's reply as the Swarm client answers it: a thrown timeout ran out the window, any other throw got no answer. */
async function answerOf(fetcher: Fetcher, url: string): Promise<SwarmAnswer> {
  let response: PathResponse;
  try {
    response = await fetcher(url);
  } catch (error) {
    return error instanceof FetchTimeoutError
      ? { kind: 'unavailable', cause: { kind: 'timeout', timeoutMs: error.timeoutMs } }
      : { kind: 'unavailable', cause: { kind: 'network', error } };
  }
  if (response.status === 404) {
    return { kind: 'not-found', serverTimeMs: null };
  }
  if (!response.ok) {
    return { kind: 'unavailable', cause: { kind: 'status', status: response.status } };
  }
  return {
    kind: 'content',
    bytes: new TextEncoder().encode(response.text),
    feedIndex: resolvedFeedIndex(response.headers),
    serverTimeMs: null,
  };
}

/**
 * The stream list's reads of the gateway at `base`, each answered by the stub at the URL the Bee
 * provider would ask, so the tests below still read which request was made.
 */
function via(fetcher: Fetcher, base: string): Pick<SwarmReader, 'readFeedHead' | 'readFeedEntry'> {
  return {
    readFeedHead: (owner, topic) => answerOf(fetcher, `${base}/${nextFeedRequest(owner, topic, null).path}`),
    readFeedEntry: (owner, topic, index) =>
      answerOf(fetcher, `${base}/${feedSlotPath(owner, topic, FeedIndex.fromBigInt(BigInt(index)))}`),
  };
}

function headerFor(index: number): Headers {
  // Hexadecimal and zero padded, which is how a gateway sends it. Decimal here would pass for every
  // index under sixteen and diverge silently after.
  return new Headers({ 'swarm-feed-index': index.toString(16).padStart(16, '0') });
}

describe('CatalogFeedReader', () => {
  it('resolves the head once and then never again', async () => {
    const { urls, fetcher } = stubFetcher([
      respond({ headers: headerFor(41), text: '[{"a":1}]' }),
      respond({ ok: false, status: 404 }),
      respond({ ok: false, status: 404 }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await reader.read(via(fetcher, 'http://gw'));
    await reader.read(via(fetcher, 'http://gw'));
    await reader.read(via(fetcher, 'http://gw'));

    expect(urls.filter((url) => url.includes('/feeds/'))).toHaveLength(1);
    expect(urls[0]).toContain(`/feeds/${OWNER}/`);
    expect(urls[1]).toContain(`/soc/${OWNER}/`);
    expect(urls[2]).toContain(`/soc/${OWNER}/`);
  });

  it('takes its position from the header rather than from counting', async () => {
    // 0x22 is 34. A reader that parsed this as decimal would walk from 23 and ask for slots that were
    // written long ago, which reads as a catalog frozen eleven broadcasts in the past.
    const { fetcher } = stubFetcher([respond({ headers: new Headers({ 'swarm-feed-index': '0000000000000022' }) })]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    const read = await reader.read(via(fetcher, 'http://gw'));

    expect(reader.getIndex()?.toBigInt()).toBe(34n);
    expect(read?.slot).toBe(34n);
  });

  it('reports nothing new as null rather than repeating the last body', async () => {
    const { fetcher } = stubFetcher([
      respond({ headers: headerFor(3), text: '[{"live":true}]' }),
      respond({ ok: false, status: 404 }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    expect(await reader.read(via(fetcher, 'http://gw'))).toEqual({ body: '[{"live":true}]', slot: 3n });
    expect(await reader.read(via(fetcher, 'http://gw'))).toBeNull();
  });

  /**
   * The property that stops a follower falling permanently behind.
   *
   * Advancing one slot per poll gives a catch-up rate equal to the poll rate, so a reader that drops
   * behind never recovers. This is the same shape that made the bench unable to measure a quarter
   * second GOP, found the expensive way on 2026-08-05.
   */
  it('walks past several new slots in one read, so it can catch up', async () => {
    const { urls, fetcher } = stubFetcher([
      respond({ headers: headerFor(0), text: '[0]' }),
      respond({ text: '[1]' }),
      respond({ text: '[2]' }),
      respond({ text: '[3]' }),
      respond({ ok: false, status: 404 }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await reader.read(via(fetcher, 'http://gw'));
    const caughtUp = await reader.read(via(fetcher, 'http://gw'));

    expect(caughtUp).toEqual({ body: '[3]', slot: 3n });
    expect(reader.getIndex()?.toBigInt()).toBe(3n);
    expect(urls).toHaveLength(5);
  });

  /**
   * For a page that knows the next slot is written and must not ask the one after it before it is:
   * Bee hides an address asked early for a minute.
   */
  it('asks only the next slot when the read is limited to one', async () => {
    const { urls, fetcher } = stubFetcher([respond({ headers: headerFor(7) }), respond({ text: '[{"live":true}]' })]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);
    await reader.read(via(fetcher, 'http://gw'));

    expect(await reader.read(via(fetcher, 'http://gw'), undefined, 1)).toEqual({ body: '[{"live":true}]', slot: 8n });
    expect(urls).toHaveLength(2);
  });

  it('stops walking at the bound rather than holding the page open', async () => {
    const replies = [respond({ headers: headerFor(0) })];
    for (let i = 0; i < 100; i++) {
      replies.push(respond({ text: `[${i}]` }));
    }
    const { urls, fetcher } = stubFetcher(replies);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await reader.read(via(fetcher, 'http://gw'));
    await reader.read(via(fetcher, 'http://gw'));

    // One head plus the walk bound, and it resumes from there on the next poll rather than looping.
    expect(urls).toHaveLength(33);
  });

  it('keeps the body when the header is unreadable, and resolves the head again next time', async () => {
    const { urls, fetcher } = stubFetcher([
      respond({ headers: new Headers(), text: '[{"a":1}]' }),
      respond({ headers: headerFor(7), text: '[{"a":2}]' }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    expect(await reader.read(via(fetcher, 'http://gw'))).toEqual({ body: '[{"a":1}]', slot: null });
    expect(reader.getIndex()).toBeNull();
    await reader.read(via(fetcher, 'http://gw'));

    expect(urls[1]).toContain('/feeds/');
  });

  it('forgets its position on reset, since another gateway has its own view of the feed', async () => {
    const { urls, fetcher } = stubFetcher([respond({ headers: headerFor(5) }), respond({ headers: headerFor(9) })]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await reader.read(via(fetcher, 'http://gw-a'));
    reader.reset();
    await reader.read(via(fetcher, 'http://gw-b'));

    expect(urls[1]).toContain('/feeds/');
    expect(reader.getIndex()?.toBigInt()).toBe(9n);
  });

  it('treats a head lookup the gateway has nothing for as an empty catalog rather than a position', async () => {
    const { fetcher } = stubFetcher([respond({ ok: false, status: 404 })]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    expect(await reader.read(via(fetcher, 'http://gw'))).toBeNull();
    expect(reader.getIndex()).toBeNull();
  });

  /**
   * ⛔ The distinction this whole group exists for, and the one status was collapsing.
   *
   * A 404 is the ordinary answer on a catalog nobody has broadcast to yet, so it has to stay quiet.
   * Every other status is the gateway failing, and returning null for those made a failing gateway
   * indistinguishable from an idle one: the browse page reads SWR's `error` to choose between
   * "Could not reach this gateway" and "No streams here yet", and without a throw it always picked
   * the second. `catalogView.ts` was written to remove exactly that confusion.
   *
   * `ManifestFetcher` already draws this line, naming 404 `SLOT_NOT_WRITTEN_YET` and failing on
   * anything else. This is the same rule in the other feed reader.
   */
  it('raises on a head lookup the gateway refused, so a broken gateway is not shown as an empty catalog', async () => {
    const { fetcher } = stubFetcher([respond({ ok: false, status: 500 })]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await expect(reader.read(via(fetcher, 'http://gw'))).rejects.toThrow('500');
    expect(reader.getIndex()).toBeNull();
  });

  /**
   * ⛔ Once the head has answered, a slot read the gateway refuses or lets time out is "nothing new
   * yet". Raising it put the browse page's poll into SWR's error state, which skips the regular reads
   * and backs off instead, so one slow or refused miss held an open page behind until a reload.
   */
  it.each([
    ['is refused with a server error', respond({ ok: false, status: 502 })],
    ['times out', new FetchTimeoutError('http://gw/soc', 10_000)],
  ])(
    'reads as nothing new when the first step of a walk %s, and asks for the same slot next time',
    async (_, failure) => {
      const { urls, fetcher } = stubFetcher([
        respond({ headers: headerFor(7) }),
        failure,
        respond({ ok: false, status: 404 }),
      ]);
      const reader = new CatalogFeedReader(OWNER, TOPIC);

      await reader.read(via(fetcher, 'http://gw'));

      expect(await reader.read(via(fetcher, 'http://gw'))).toBeNull();
      // The walk read nothing, so the position it starts from next time is the one it already held.
      expect(reader.getIndex()?.toBigInt()).toBe(7n);
      await reader.read(via(fetcher, 'http://gw'));
      expect(urls[2]).toBe(urls[1]);
    },
  );

  // Same salvage rule the throw path already has: what a walk fetched is not thrown away because a
  // later step of it failed, since each slot carries the whole catalog rather than a delta.
  it('keeps the slot it already read when a later step of the same walk is refused with a server error', async () => {
    const { fetcher } = stubFetcher([
      respond({ headers: headerFor(7) }),
      respond({ text: '[{"live":true}]' }),
      respond({ ok: false, status: 503 }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await reader.read(via(fetcher, 'http://gw'));

    expect(await reader.read(via(fetcher, 'http://gw'))).toEqual({ body: '[{"live":true}]', slot: 8n });
    expect(reader.getIndex()?.toBigInt()).toBe(8n);
  });

  /**
   * A throw is a different shape from a refusal, and only the refusal was handled. `this.index` is
   * committed per slot inside the walk while the body is returned after it, so a rejection used to
   * drop a snapshot that had already been fetched and keep the index that consumed it. Each slot
   * carries the whole catalog rather than a delta, so the broadcast announced in the dropped slot was
   * never offered to this reader again.
   *
   * A read that got no answer at all is the ordinary shape of a gateway going away mid-walk.
   */
  it('keeps the slot it already read when a later step of the same walk throws', async () => {
    const { fetcher } = stubFetcher([
      respond({ headers: headerFor(7) }),
      respond({ text: '[{"live":true}]' }),
      // Deliberately not `ok: false`. The refusal path was always handled, and a test that used one
      // here would pass against the version this covers.
      new Error('socket hang up') as never,
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await reader.read(via(fetcher, 'http://gw'));

    // The position and the body have to agree: index 8 is the slot the returned body came from.
    expect(await reader.read(via(fetcher, 'http://gw'))).toEqual({ body: '[{"live":true}]', slot: 8n });
    expect(reader.getIndex()?.toBigInt()).toBe(8n);
  });

  /**
   * ⛔ The position used to move before anyone parsed the body. The reader committed the slot as soon
   * as the gateway answered, and the caller parsed it afterwards, so a body that arrived cut short
   * failed the poll and was never asked for again: the next poll read the slot after it. Each slot
   * carries the whole catalog, so a change announced only in that slot never reached the page.
   */
  it('keeps its position when a slot body does not parse, and reads that slot again next time', async () => {
    const { urls, fetcher } = stubFetcher([
      respond({ headers: headerFor(7), text: '[]' }),
      respond({ text: '[{"live":tr' }),
      respond({ text: '[{"live":true}]' }),
      respond({ ok: false, status: 404 }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await reader.read(via(fetcher, 'http://gw'));

    expect(await reader.read(via(fetcher, 'http://gw'))).toBeNull();
    expect(reader.getIndex()?.toBigInt()).toBe(7n);
    expect(await reader.read(via(fetcher, 'http://gw'))).toEqual({ body: '[{"live":true}]', slot: 8n });
    expect(urls[2]).toBe(urls[1]);
  });

  it('still raises when the first step of a walk throws, so a dead gateway is not read as an idle catalog', async () => {
    const { fetcher } = stubFetcher([respond({ headers: headerFor(7) }), new Error('socket hang up') as never]);
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    await reader.read(via(fetcher, 'http://gw'));

    await expect(reader.read(via(fetcher, 'http://gw'))).rejects.toThrow('socket hang up');
    expect(reader.getIndex()?.toBigInt()).toBe(7n);
  });
});

/**
 * ⛔ A gateway switch resets this reader, and a poll in flight when it lands used to undo the reset.
 *
 * The position is written after an await, so the read against the node the viewer just left finished
 * and wrote that node's slot number back. Every poll after it asked the new node for the slot after
 * one it does not hold, the walk broke with nothing read, and the browse page kept the previous
 * gateway's streams for the life of the tab. Reloading the page was the only way out, and nothing on
 * it said so.
 *
 * The reads here are overlapped by hand rather than awaited in turn, because a reset between two
 * awaited reads is the case that already worked and is covered above.
 */
describe('CatalogFeedReader when a gateway switch lands mid-read', () => {
  it('keeps the position the new gateway resolved when the old gateway answers after the switch', async () => {
    const { pending, fetcher } = deferredFetcher();
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    const beforeSwitch = reader.read(via(fetcher, 'http://gw-old'));
    reader.reset();
    const afterSwitch = reader.read(via(fetcher, 'http://gw-new'));

    pending[1].answer(respond({ headers: headerFor(7), text: '[{"new":true}]' }));
    await afterSwitch;
    pending[0].answer(respond({ headers: headerFor(40), text: '[{"old":true}]' }));
    await beforeSwitch;

    expect(pending[0].url).toContain('gw-old');
    expect(pending[1].url).toContain('gw-new');
    expect(reader.getIndex()?.toBigInt()).toBe(7n);
  });

  it('writes no position at all from a walk the switch interrupted, so the next poll resolves the head', async () => {
    const { pending, fetcher } = deferredFetcher();
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    const head = reader.read(via(fetcher, 'http://gw-old'));
    pending[0].answer(respond({ headers: headerFor(5), text: '[{"old":true}]' }));
    await head;

    const walk = reader.read(via(fetcher, 'http://gw-old'));
    reader.reset();
    pending[1].answer(respond({ text: '[{"old":true,"more":true}]' }));
    await walk;

    expect(reader.getIndex()).toBeNull();
    // The walk stopped at the slot that was already in flight rather than asking the node the viewer
    // has left for another one.
    expect(pending).toHaveLength(2);
  });

  /**
   * The slot describes the body, not this reader, so it survives the refusal to keep a position. A
   * viewer who switches away and straight back is handed this body for the gateway they returned to,
   * and the stream list needs its slot to know whether it is older than what is on screen.
   */
  it('still names the slot of a head the old gateway resolved, though it keeps no position from it', async () => {
    const { pending, fetcher } = deferredFetcher();
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    const beforeSwitch = reader.read(via(fetcher, 'http://gw-old'));
    reader.reset();
    pending[0].answer(respond({ headers: headerFor(40), text: '[{"old":true}]' }));

    expect(await beforeSwitch).toEqual({ body: '[{"old":true}]', slot: 40n });
    expect(reader.getIndex()).toBeNull();
  });
});

/**
 * ⛔ Two reads can be in flight on one gateway at once, and the one that lands last is not always the
 * newer.
 *
 * The app's first read runs beside the browse page's first poll, both start with no position, and
 * each resolves the head on its own, so either can land last. The reader's own position is whichever
 * of them wrote it last. Only the slot each body arrived with says which of the two is newer, which
 * is what lets the stream list refuse the older one instead of putting it back on screen.
 */
describe('CatalogFeedReader when two reads overlap on one gateway', () => {
  it('hands back each body with the slot it was read from, the older one landing last', async () => {
    const { pending, fetcher } = deferredFetcher();
    const reader = new CatalogFeedReader(OWNER, TOPIC);

    const first = reader.read(via(fetcher, 'http://gw'));
    const second = reader.read(via(fetcher, 'http://gw'));
    pending[1].answer(respond({ headers: headerFor(8), text: '[8]' }));
    const newer = await second;
    pending[0].answer(respond({ headers: headerFor(7), text: '[7]' }));
    const older = await first;

    expect(newer).toEqual({ body: '[8]', slot: 8n });
    expect(older).toEqual({ body: '[7]', slot: 7n });
  });
});
