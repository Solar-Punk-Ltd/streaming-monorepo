// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import assert from 'node:assert/strict';
import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { nextFeedRequest } from '@swarm-hls-stream/shared';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { StreamWatcher } from '../src/pages/StreamWatcher/StreamWatcher';
import { AppContextProvider } from '../src/providers/App';
import { CATALOG_POLL_INTERVAL_MS } from '../src/providers/catalogPoll';
import { DEFAULT_READ_TIMEOUT_MS } from '../src/swarm/provider';
import { type Rendition, type Stream, STREAM_STATUS_VOD } from '../src/types/stream';
import { config } from '../src/utils/config';

import type { PathResponse } from './helpers/playerReader';

/**
 * ⛔ The watch page while the stream list it holds has no entry for its stream, through the real
 * provider, SWR and catalog reader.
 *
 * The app marks the list loaded even when its first read fails, so that a deep link still plays, and the
 * watch page then mounts the player with no entry and so with no ladder. A recording kept only by its
 * archive has nothing to play from without one: the master feed has no update, and the page stayed on
 * "Reconnecting to the stream" until a reload, because the watch page never read the list again.
 *
 * Only the gateway is faked, at the global `fetch` the Swarm client's Bee provider reads through, and
 * only the player is replaced, by one that records the renditions it is handed.
 */

/** What the fake gateway answers a URL with, set by each test. */
const fakes: { answer: (url: string, signal: AbortSignal | undefined) => Promise<PathResponse> } = {
  answer: () => Promise.reject(new Error('no gateway set up')),
};

/** The renditions handed to the player on each render, undefined for a render without a ladder. */
const players = vi.hoisted(() => ({ renditions: [] as (unknown[] | undefined)[] }));

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const answer = await fakes.answer(String(input), init?.signal ?? undefined);
  return new Response(answer.text, { status: answer.status, headers: answer.headers });
}) as typeof fetch;

vi.mock('../src/components/SwarmHlsPlayer/CustomManifestLoader', () => ({
  manifestFetcher: { useSwarm: () => {} },
}));
vi.mock('../src/components/SwarmHlsPlayer/SwarmHlsPlayer', () => ({
  SwarmHlsPlayer: (props: { renditions?: unknown[] }) => {
    players.renditions.push(props.renditions);
    return createElement('video', { 'data-testid': 'player' });
  },
}));

const LIST_TOPIC = Topic.fromString(config.rawAppTopic);
const HEAD_SLOT = 7;
const OWNER = 'a'.repeat(40);
const TOPIC = 'archived-recording';

const rung = (name: string, index: number): Rendition => ({
  name,
  width: 1,
  height: 1,
  topic: `${TOPIC}-${name}`,
  bandwidth: 1,
  avgBandwidth: 1,
  index,
});

/** A recording the list names with its ladder, which is all the player has to play it from. */
const recording: Stream = {
  owner: OWNER,
  topic: TOPIC,
  title: 'A recording',
  mediatype: 'video',
  timestamp: 100,
  state: STREAM_STATUS_VOD,
  renditions: [rung('360p', 54), rung('480p', 54)],
};
const another: Stream = { ...recording, topic: 'another-stream', title: 'Another', renditions: undefined };

function answered(status: number, streams: Stream[] | null, headers = new Headers()): PathResponse {
  return { ok: status >= 200 && status < 300, status, headers, text: streams === null ? '' : JSON.stringify(streams) };
}

const NOT_WRITTEN_YET: PathResponse = {
  ...answered(404, null),
  text: JSON.stringify({ code: 404, message: 'Not Found' }),
};

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** The path the reader asks for when it holds `held` and wants the slot after it. */
function pathOfSlotAfter(held: number): string {
  return nextFeedRequest(config.appOwner, LIST_TOPIC, FeedIndex.fromBigInt(BigInt(held))).path;
}

type Failure = 'refused' | 'timed out';

/**
 * A gateway holding the stream list at {@link HEAD_SLOT} as `head`, with `next` in the slot after it
 * when given and nothing written there otherwise. The first `failingHeads` head lookups fail.
 */
function gateway({
  head,
  next = null,
  failingHeads = 0,
  failure = 'refused',
}: {
  head: Stream[];
  next?: Stream[] | null;
  failingHeads?: number;
  failure?: Failure;
}) {
  const state = { failingHeads, next, lastFailureAt: -1, listAsksAt: [] as number[], nextSlotAsksAt: [] as number[] };
  const nextSlot = pathOfSlotAfter(HEAD_SLOT);
  const afterNext = pathOfSlotAfter(HEAD_SLOT + 1);

  const fail = (signal: AbortSignal | undefined): Promise<PathResponse> => {
    if (failure === 'refused') {
      state.lastFailureAt = Date.now();
      return Promise.resolve(answered(500, null));
    }
    // A read the gateway never answers, which the provider's own window ends.
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        state.lastFailureAt = Date.now();
        reject(abortError());
      });
    });
  };

  fakes.answer = async (url, signal) => {
    if (url.includes('/feeds/')) {
      state.listAsksAt.push(Date.now());
      if (state.failingHeads > 0) {
        state.failingHeads--;
        return fail(signal);
      }
      return answered(200, head, new Headers({ 'swarm-feed-index': HEAD_SLOT.toString(16).padStart(16, '0') }));
    }
    if (url.endsWith(nextSlot)) {
      state.listAsksAt.push(Date.now());
      state.nextSlotAsksAt.push(Date.now());
      return state.next === null ? NOT_WRITTEN_YET : answered(200, state.next);
    }
    if (url.endsWith(afterNext)) {
      state.listAsksAt.push(Date.now());
      return NOT_WRITTEN_YET;
    }
    return NOT_WRITTEN_YET;
  };
  return state;
}

let container: HTMLDivElement;
let root: Root;

function openWatchPage() {
  act(() => {
    root.render(
      createElement(
        SWRConfig,
        // A fresh cache per test, so no answer carries over from the one before.
        { value: { provider: () => new Map() } },
        createElement(
          AppContextProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [`/watch/video/${OWNER}/${TOPIC}`] },
            createElement(
              Routes,
              null,
              createElement(Route, { path: '/watch/:mediatype/:owner/:topic', element: createElement(StreamWatcher) }),
            ),
          ),
        ),
      ),
    );
  });
}

function isPlaying(): boolean {
  return container.querySelector('[data-testid="player"]') !== null;
}

/** The rung names the player was last handed, or null when it was handed none. */
function playerLadder(): string[] | null {
  const last = players.renditions.at(-1);
  return last ? (last as Rendition[]).map((rendition) => rendition.name) : null;
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

function gapsBetween(times: readonly number[]): number[] {
  return times.slice(1).map((atMs, i) => atMs - times[i]);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  // Before the app mounts, because the Bee provider keeps the fetch it was made with.
  vi.stubGlobal('fetch', fakeFetch);
  // The provider reports a first read that failed, which some of these cases make on purpose.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  players.renditions.length = 0;
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

/** One poll interval after the failure, with half an interval of slack. */
const NEXT_POLL_MS = CATALOG_POLL_INTERVAL_MS * 1.5;

describe('a watch page whose first stream list read fails', () => {
  it.each<Failure>(['timed out', 'refused'])(
    'mounts the player, reads the list again after a read that %s, and hands the player the ladder of the entry',
    async (failure) => {
      const bee = gateway({ head: [recording], failingHeads: 1, failure });
      openWatchPage();

      assert.ok(
        await advanceUntil(() => bee.lastFailureAt >= 0, DEFAULT_READ_TIMEOUT_MS + 1_000),
        'the first read never failed',
      );
      assert.ok(await advanceUntil(isPlaying, 1_000), 'the player was not mounted after the failed read');

      const laddersAt = await advanceUntil(() => playerLadder() !== null, 2 * CATALOG_POLL_INTERVAL_MS);

      assert.notEqual(laddersAt, null, 'the page never read the list again, so the player never got its ladder');
      const late = (laddersAt ?? 0) - bee.lastFailureAt;
      assert.ok(late <= NEXT_POLL_MS, `the player got its ladder ${late}ms after the failed read`);
      assert.deepEqual(playerLadder(), ['360p', '480p']);
    },
  );

  it('reads the list no more once the entry has arrived', async () => {
    const bee = gateway({ head: [recording], failingHeads: 1 });
    openWatchPage();
    assert.ok(await advanceUntil(() => playerLadder() !== null, 2 * CATALOG_POLL_INTERVAL_MS), 'no ladder arrived');
    const asksBefore = bee.listAsksAt.length;

    await advanceUntil(() => false, 4 * CATALOG_POLL_INTERVAL_MS);

    assert.equal(bee.listAsksAt.length, asksBefore, 'a page holding its entry kept reading the list');
    assert.ok(isPlaying(), 'the player went away');
  });
});

describe('a watch page that holds the entry for its stream', () => {
  it('reads the list no more than the app does at load', async () => {
    const bee = gateway({ head: [recording] });
    openWatchPage();
    assert.ok(await advanceUntil(() => playerLadder() !== null, 1_000), 'the entry never reached the player');
    const asksBefore = bee.listAsksAt.length;

    await advanceUntil(() => false, 4 * CATALOG_POLL_INTERVAL_MS);

    assert.equal(bee.listAsksAt.length, asksBefore, 'a page holding its entry read the list again');
  });
});

describe('a deep link to a stream the list does not have', () => {
  /**
   * Nothing here knows whether a topic the list lacks is a real stream, so the player is mounted at
   * once. The list is read again at the catalog poll's pace, never faster: every read asks the slot
   * after the newest, which is not written until the list changes, and Bee skips each peer asked that
   * early for a minute.
   */
  it('plays at once, reads the list once a minute at most, and plays the entry the list gains', async () => {
    const bee = gateway({ head: [another] });
    openWatchPage();
    assert.ok(await advanceUntil(isPlaying, 1_000), 'the player was not mounted for a stream the list lacks');
    assert.equal(playerLadder(), null);

    await advanceUntil(() => false, 3 * CATALOG_POLL_INTERVAL_MS);
    const unwrittenAsks = bee.nextSlotAsksAt;
    assert.ok(unwrittenAsks.length >= 2, 'a page without its entry stopped reading the list');
    for (const gap of gapsBetween(unwrittenAsks)) {
      assert.ok(gap >= CATALOG_POLL_INTERVAL_MS, `the list was read again after ${gap}ms`);
    }

    bee.next = [another, recording];
    assert.ok(
      await advanceUntil(() => playerLadder() !== null, NEXT_POLL_MS),
      'the entry the list gained never reached the player',
    );
    assert.deepEqual(playerLadder(), ['360p', '480p']);
  });
});
