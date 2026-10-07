// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import assert from 'node:assert/strict';
import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { nextFeedRequest } from '@swarm-hls-stream/shared';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { AppContextProvider, useAppContext } from '../src/providers/App';
import { CATALOG_POLL_INTERVAL_MS } from '../src/providers/catalogPoll';
import { useCatalogPoll } from '../src/providers/useCatalogPoll';
import { Stream, STREAM_STATUS_LIVE, STREAM_STATUS_SCHEDULED } from '../src/types/stream';
import { config } from '../src/utils/config';
import { DEFAULT_READ_TIMEOUT_MS } from '../src/swarm/provider';

import type { PathResponse } from './helpers/playerReader';

/**
 * ⛔ The browse page's catalog poll over time, through the real provider, SWR and catalog reader.
 *
 * The client promises to read the catalog again every five seconds, so a stream published, gone live
 * or unpublished shows on an open page without a reload. QA saw the opposite: changes reached an open
 * page only after a reload. One failed read was enough. SWR stops its refresh timer while its cache
 * holds an error and leaves the next read to `onErrorRetry`, whose default backs off exponentially,
 * and the catalog reader turned a slot read that timed out or was refused into exactly that error.
 * Every further failure doubled the wait, so a gateway with a slow tail kept an open page minutes
 * behind.
 *
 * Only the gateway is faked, at the global `fetch` the Swarm client's Bee provider reads through,
 * which is the reader's one way out. Everything between that and the list on screen is the code that
 * ships, the provider's own bounded window included.
 *
 * SWR's backoff has a random factor. It is pinned at the top of its range so that what these tests
 * measure does not depend on a coin toss: with it, the first retry after one failure comes two poll
 * intervals later rather than one, and each further failure doubles that.
 */

/** What the fake gateway answers a URL with, set by each test. */
const fakes: { answer: (url: string, signal: AbortSignal | undefined) => Promise<PathResponse> } = {
  answer: () => Promise.reject(new Error('no gateway set up')),
};

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** The browser's fetch over the fake gateway, as the Bee provider calls it. */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const answer = await fakes.answer(String(input), init?.signal ?? undefined);
  return new Response(answer.text, { status: answer.status, headers: answer.headers });
}) as typeof fetch;

// The provider hands the player's manifest fetcher the Swarm client's reader, and nothing here plays anything.
vi.mock('../src/components/SwarmHlsPlayer/CustomManifestLoader', () => ({
  manifestFetcher: { useSwarm: () => {} },
}));

const TOPIC = Topic.fromString(config.rawAppTopic);
const HEAD_SLOT = 7;

const scheduled: Stream = {
  owner: '0xabc',
  topic: 'announced-topic',
  title: 'announced',
  mediatype: 'video',
  timestamp: 100,
  state: STREAM_STATUS_SCHEDULED,
};
const wentLive: Stream = { ...scheduled, state: STREAM_STATUS_LIVE, timestamp: 200 };

/** The path the reader asks for when it holds `held` and wants the slot after it. */
function pathOfSlotAfter(held: number): string {
  return nextFeedRequest(config.appOwner, TOPIC, FeedIndex.fromBigInt(BigInt(held))).path;
}

function answered(status: number, streams: Stream[] | null, headers = new Headers()): PathResponse {
  return { ok: status >= 200 && status < 300, status, headers, text: streams === null ? '' : JSON.stringify(streams) };
}

const NOT_WRITTEN_YET = answered(404, null);

/** How a failed read reaches the reader: a status, or the provider giving up after its window. */
type Failure = 'refused' | 'timed out';

/**
 * A gateway holding the catalog at {@link HEAD_SLOT}, with the next slot already written as the
 * stream gone live, that fails a given number of requests before it answers them.
 *
 * `failingHeads` fails the head lookups, `failingSlots` the reads of the slot after the head. Each
 * failure is stamped with the fake clock when it lands, so a test can measure from the last one.
 */
function gateway({
  failingHeads = 0,
  failingSlots = 0,
  failure,
}: {
  failingHeads?: number;
  failingSlots?: number;
  failure: Failure;
}) {
  const state = { failingHeads, failingSlots, lastFailureAt: -1 };
  const nextSlot = pathOfSlotAfter(HEAD_SLOT);
  const afterNext = pathOfSlotAfter(HEAD_SLOT + 1);

  // A timed out read is one the gateway never answers, which the provider's own window ends.
  const fail = (signal: AbortSignal | undefined): Promise<PathResponse> => {
    if (failure === 'refused') {
      state.lastFailureAt = Date.now();
      return Promise.resolve(answered(500, null));
    }
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        state.lastFailureAt = Date.now();
        reject(abortError());
      });
    });
  };

  fakes.answer = async (url, signal) => {
    if (url.includes('/feeds/')) {
      if (state.failingHeads > 0) {
        state.failingHeads--;
        return fail(signal);
      }
      const header = new Headers({ 'swarm-feed-index': HEAD_SLOT.toString(16).padStart(16, '0') });
      return answered(200, [scheduled], header);
    }
    if (url.endsWith(nextSlot)) {
      if (state.failingSlots > 0) {
        state.failingSlots--;
        return fail(signal);
      }
      return answered(200, [wentLive]);
    }
    if (url.endsWith(afterNext)) {
      return NOT_WRITTEN_YET;
    }
    throw new Error(`the reader asked for a slot this feed does not hold: ${url}`);
  };
  return state;
}

/** The browse page's use of the poll, reduced to what this checks: the list and the poll. */
function Browser() {
  const { streamList } = useAppContext();
  useCatalogPoll(CATALOG_POLL_INTERVAL_MS);
  return createElement(
    'ul',
    null,
    ...streamList.map((entry) => createElement('li', { key: entry.topic }, entry.state)),
  );
}

let container: HTMLDivElement;
let root: Root;

function mount() {
  act(() => {
    root.render(
      createElement(
        SWRConfig,
        // A fresh cache per test, so no answer carries over from the one before.
        { value: { provider: () => new Map() } },
        createElement(AppContextProvider, null, createElement(Browser)),
      ),
    );
  });
}

function shown(): string {
  return container.textContent ?? '';
}

/** Steps the fake clock in small increments until `predicate` holds, and says when it first did. */
async function advanceUntil(predicate: () => boolean, limitMs: number): Promise<number | null> {
  const step = 100;
  for (let waited = 0; waited <= limitMs; waited += step) {
    if (predicate()) {
      return Date.now();
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
  }
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  // Before the app mounts, because the Bee provider keeps the fetch it was made with.
  vi.stubGlobal('fetch', fakeFetch);
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  // The provider reports a first read that failed, which some of these cases make on purpose.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The next regular poll after the failure, with half an interval of slack. The poll reads every
 * interval, so a page that keeps its cadence shows the new slot one interval after the failure lands.
 * SWR's default backoff, pinned as above, needs two at least.
 */
const NEXT_POLL_MS = CATALOG_POLL_INTERVAL_MS * 1.5;

describe('when a catalog read fails on an open page', () => {
  it.each<Failure>(['timed out', 'refused'])(
    'shows the next slot on the next regular poll after a slot read that %s',
    async (failure) => {
      const bee = gateway({ failingSlots: 1, failure });
      mount();

      assert.ok(await advanceUntil(() => shown() === STREAM_STATUS_SCHEDULED, 1_000), 'the head never showed');
      await advanceUntil(() => bee.lastFailureAt >= 0, 2 * CATALOG_POLL_INTERVAL_MS + DEFAULT_READ_TIMEOUT_MS + 1_000);
      assert.ok(bee.lastFailureAt >= 0, 'the slot read never failed');

      const shownAt = await advanceUntil(() => shown() === STREAM_STATUS_LIVE, 120_000);

      assert.notEqual(shownAt, null, 'the stream gone live never reached the page');
      const late = (shownAt ?? 0) - bee.lastFailureAt;
      assert.ok(late <= NEXT_POLL_MS, `the page showed the next slot ${late}ms after the failure`);
    },
  );

  /**
   * A head lookup that fails still fails, since it is how the browse page tells a gateway it cannot
   * reach from one with nothing on it. What follows it must still be a poll at the regular cadence,
   * however many fail in a row, rather than a wait that doubles with each.
   */
  it('keeps reading at the regular cadence while head lookups keep failing, and shows the catalog once one answers', async () => {
    const bee = gateway({ failingHeads: 4, failure: 'refused' });
    mount();

    const shownAt = await advanceUntil(() => shown().length > 0, 300_000);

    assert.notEqual(shownAt, null, 'the catalog never reached the page');
    const late = (shownAt ?? 0) - bee.lastFailureAt;
    assert.ok(late <= NEXT_POLL_MS, `the page showed the catalog ${late}ms after the last failure`);
  });
});
