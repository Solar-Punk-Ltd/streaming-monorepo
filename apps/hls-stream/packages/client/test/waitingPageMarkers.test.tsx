// @vitest-environment jsdom
import { Topic } from '@ethersphere/bee-js';
import { act, createElement, type ReactNode, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { markerPeriodAt, markerPeriodStartMs } from '@swarm-hls-stream/shared';
import { StreamWatcher } from '../src/pages/StreamWatcher/StreamWatcher';
import { FakeLadderGateway } from './helpers/fakeLadderGateway';

const OWNER = 'a'.repeat(40);
const TOPIC = 'stream-one';
/** The stream list's own feed, on the same fake gateway as the markers so one skip model covers both. */
const LIST_TOPIC = Topic.fromString('stream-list');
/** Bee's skip rule as `oneQualityFollow.test.ts` models it: four peers, each skipped for a minute. */
const PEERS = 4;
const SKIP_MS = 60_000;
const MARKER_PERIOD_MS = markerPeriodStartMs(1);

/**
 * The app's stream list, held where both the mocked context and the test can reach it. The poll itself
 * is the page's real one: `fetchAppState` asks the list feed's next slot, as the catalog reader does.
 */
const app = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    gateway: null as unknown as import('./helpers/fakeLadderGateway').FakeLadderGateway,
    streamList: [] as unknown[],
    heldSlot: 0,
  };
  return {
    state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setStreamList(streams: unknown[]) {
      state.streamList = streams;
      listeners.forEach((listener) => listener());
    },
  };
});

vi.mock('../src/providers/App', () => ({
  useAppContext: () => {
    const streamList = useSyncExternalStore(app.subscribe, () => app.state.streamList);
    const { gateway } = app.state;
    return {
      streamList,
      isStreamListLoaded: true,
      chat: null,
      streamListSourceId: 'waiting-page-markers',
      swarm: { reader: () => gateway.reader, clockOffsetMs: () => 0 },
      fetchAppState: async () => {
        const answer = await gateway.reader.readFeedEntry(gateway.owner, LIST_TOPIC, app.state.heldSlot + 1);
        if (answer.kind !== 'content') {
          return { gateway: 'fake', streams: null, slot: null };
        }
        app.state.heldSlot += 1;
        return { gateway: 'fake', streams: JSON.parse(new TextDecoder().decode(answer.bytes)), slot: null };
      },
      setNewStreamList: (read: { streams: unknown }) => {
        if (Array.isArray(read.streams)) {
          app.setStreamList(read.streams);
        }
      },
    };
  },
}));
vi.mock('../src/components/SwarmHlsPlayer/SwarmHlsPlayer', () => ({
  SwarmHlsPlayer: () => createElement('video', { 'data-testid': 'player' }),
}));

function entry(state: string) {
  return { owner: OWNER, topic: TOPIC, title: 'A talk', timestamp: 1, mediatype: 'video', state };
}

// React only runs effects inside act() when told it is in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: Root | null = null;

function mount(node: ReactNode): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return root;
}

afterEach(() => {
  const root = mounted;
  act(() => root?.unmount());
  mounted = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function isPlaying(): boolean {
  return document.querySelector('[data-testid="player"]') !== null;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('a watch page waiting on an announced stream', () => {
  it('goes live from the ladder marker while the list slot that says live is still skipped, asking each marker once', async () => {
    // One second into a marker period, so the first marker read falls three seconds after the page opens.
    const openedAtMs = Date.UTC(2026, 9, 8, 12, 0, 1);
    vi.useFakeTimers({ now: openedAtMs });
    const gateway = new FakeLadderGateway(OWNER);
    app.state.gateway = gateway;
    app.state.heldSlot = 0;
    gateway.publishSlot(LIST_TOPIC, 0, JSON.stringify([entry('scheduled')]));
    gateway.modelSkipList(PEERS, SKIP_MS, Date.now);
    app.setStreamList([entry('scheduled')]);

    mounted = mount(
      createElement(
        MemoryRouter,
        { initialEntries: [`/watch/video/${OWNER}/${TOPIC}`] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/watch/:mediatype/:owner/:topic', element: createElement(StreamWatcher) }),
        ),
      ),
    );
    expect(isPlaying()).toBe(false);

    // The list's next slot has been asked every five seconds since the page opened, so by now every
    // peer is skipped for it and the slot that says live cannot be read for most of a minute.
    await advance(22_000);
    const listAsks = gateway.requests.filter((request) => request.kind === 'slot').length;
    expect(listAsks, 'the page did not poll the list').toBeGreaterThanOrEqual(PEERS);
    const liveAtMs = Date.now();
    gateway.publishSlot(LIST_TOPIC, 1, JSON.stringify([entry('live')]));
    const group = Topic.fromString(TOPIC);
    const firstMarkerPeriod = markerPeriodAt(liveAtMs) + 1;
    const writeMarker = (period: number) =>
      gateway.publishMarker(
        group,
        period,
        JSON.stringify({ v: 1, period, writtenAt: markerPeriodStartMs(period) + 250, rungs: { ['b'.repeat(64)]: 0 } }),
      );

    let wentLiveAtMs: number | null = null;
    for (let period = firstMarkerPeriod; wentLiveAtMs === null && period < firstMarkerPeriod + 3; period++) {
      await advance(markerPeriodStartMs(period) + 250 - Date.now());
      writeMarker(period);
      while (wentLiveAtMs === null && Date.now() < markerPeriodStartMs(period + 1) + 250) {
        await advance(250);
        if (isPlaying()) {
          wentLiveAtMs = Date.now();
        }
      }
    }

    expect(wentLiveAtMs, 'the page never left "starts soon"').not.toBeNull();
    expect(wentLiveAtMs! - liveAtMs).toBeLessThanOrEqual(MARKER_PERIOD_MS + 4_000 + 1_000);
    expect(app.state.heldSlot, 'the list, not the marker, said live').toBe(0);

    await advance(60_000);
    const markerReads = gateway.requests.filter((request) => request.kind === 'other').map((request) => request.path);
    expect(markerReads.length).toBeGreaterThan(0);
    expect(new Set(markerReads).size, 'a marker address was asked twice').toBe(markerReads.length);
  });
});
