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
const RENDITIONS = [
  { name: '720p', width: 1280, height: 720, topic: `${TOPIC}-720p`, bandwidth: 3_000_000, avgBandwidth: 2_500_000 },
];

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
    /** When the list's next slot was asked, on the test's clock. */
    listReadsAtMs: [] as number[],
    /** The renditions each mounted player was handed. */
    playerRenditions: [] as unknown[],
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
    /** One read of the list feed's next slot, never the one after it. */
    async readNextSlot() {
      state.listReadsAtMs.push(Date.now());
      const answer = await state.gateway.reader.readFeedEntry(state.gateway.owner, LIST_TOPIC, state.heldSlot + 1);
      if (answer.kind !== 'content') {
        return { gateway: 'fake', streams: null, slot: null };
      }
      state.heldSlot += 1;
      return { gateway: 'fake', streams: JSON.parse(new TextDecoder().decode(answer.bytes)) as unknown, slot: null };
    },
    apply(read: { streams: unknown }) {
      if (Array.isArray(read.streams)) {
        state.streamList = read.streams;
        listeners.forEach((listener) => listener());
      }
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
      fetchAppState: () => app.readNextSlot(),
      setNewStreamList: app.apply,
      readNextStreamListSlot: () => void app.readNextSlot().then(app.apply),
    };
  },
}));
vi.mock('../src/components/SwarmHlsPlayer/SwarmHlsPlayer', () => ({
  SwarmHlsPlayer: (props: { renditions?: unknown }) => {
    app.state.playerRenditions.push(props.renditions);
    return createElement('video', { 'data-testid': 'player' });
  },
}));

function entry(state: string, extra: Record<string, unknown> = {}) {
  return { owner: OWNER, topic: TOPIC, title: 'A talk', timestamp: 1, mediatype: 'video', state, ...extra };
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

async function advanceTo(atMs: number): Promise<void> {
  await advance(Math.max(0, atMs - Date.now()));
}

/** Opens the watch page on an announced entry, one second into a marker period, with Bee's skip rule on. */
function openWaitingPage(): FakeLadderGateway {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 8, 12, 0, 1) });
  const gateway = new FakeLadderGateway(OWNER);
  Object.assign(app.state, { gateway, heldSlot: 0, listReadsAtMs: [], playerRenditions: [] });
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
  return gateway;
}

/** The uploader's marker for `period`, written 250 ms into it. */
function writeMarker(gateway: FakeLadderGateway, period: number): void {
  const marker = {
    v: 2,
    period,
    writtenAt: markerPeriodStartMs(period) + 250,
    rungs: { ['b'.repeat(64)]: 0 },
    segmentMs: 2_000,
  };
  gateway.publishMarker(Topic.fromString(TOPIC), period, JSON.stringify(marker));
}

/** Writes every period's marker from `firstPeriod` on, until the page plays. When it started playing, or null. */
async function broadcastUntilPlaying(gateway: FakeLadderGateway, firstPeriod: number, periods: number) {
  for (let period = firstPeriod; period < firstPeriod + periods; period++) {
    await advanceTo(markerPeriodStartMs(period) + 250);
    writeMarker(gateway, period);
    while (Date.now() < markerPeriodStartMs(period + 1) + 250) {
      await advance(250);
      if (isPlaying()) {
        return Date.now();
      }
    }
  }
  return null;
}

function markerReads(gateway: FakeLadderGateway): string[] {
  return gateway.requests.filter((request) => request.kind === 'other').map((request) => request.path);
}

function gapsBetween(times: readonly number[]): number[] {
  return times.slice(1).map((atMs, i) => atMs - times[i]);
}

describe('a watch page waiting on an announced stream', () => {
  it('asks the list at most once a minute while waiting, and plays with the renditions soon after the first marker', async () => {
    const gateway = openWaitingPage();
    expect(isPlaying()).toBe(false);

    await advance(130_000);
    const readsBeforeLive = [...app.state.listReadsAtMs];
    expect(readsBeforeLive.length, 'the page stopped watching the list for a cancellation').toBeGreaterThan(0);
    for (const gap of gapsBetween(readsBeforeLive)) {
      expect(gap, 'the list was asked more than once a minute while waiting').toBeGreaterThanOrEqual(60_000);
    }

    // The admin writes the live entry when the first quality reports, before that quality's first
    // segment and so before the ladder's first marker.
    const liveAtMs = Date.now();
    gateway.publishSlot(LIST_TOPIC, 1, JSON.stringify([entry('live', { renditions: RENDITIONS })]));
    const wentLiveAtMs = await broadcastUntilPlaying(gateway, markerPeriodAt(liveAtMs) + 1, 3);

    expect(wentLiveAtMs, 'the page never left "starts soon"').not.toBeNull();
    expect(wentLiveAtMs! - liveAtMs).toBeLessThanOrEqual(MARKER_PERIOD_MS + 5_000);
    expect(app.state.playerRenditions.at(-1)).toEqual(RENDITIONS);

    await advance(60_000);
    const reads = markerReads(gateway);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads).size, 'a marker address was asked twice').toBe(reads.length);
  });

  it('reads the list again only at the next marker when the first read after a marker is too early', async () => {
    const gateway = openWaitingPage();
    await advance(22_000);
    const firstPeriod = markerPeriodAt(Date.now()) + 1;
    const readsBeforeMarkers = app.state.listReadsAtMs.length;

    // A marker before the live entry: the read it prompts finds nothing new.
    await advanceTo(markerPeriodStartMs(firstPeriod) + 250);
    writeMarker(gateway, firstPeriod);
    await advanceTo(markerPeriodStartMs(firstPeriod) + 8_000);
    expect(isPlaying()).toBe(false);
    gateway.publishSlot(LIST_TOPIC, 1, JSON.stringify([entry('live', { renditions: RENDITIONS })]));

    const wentLiveAtMs = await broadcastUntilPlaying(gateway, firstPeriod + 1, 2);

    expect(wentLiveAtMs, 'the page never left "starts soon"').not.toBeNull();
    const readsAfterMarkers = app.state.listReadsAtMs.slice(readsBeforeMarkers);
    expect(readsAfterMarkers, 'one list read per marker, none on a timer of its own').toEqual([
      markerPeriodStartMs(firstPeriod) + 4_000,
      markerPeriodStartMs(firstPeriod + 1) + 4_000,
    ]);
    expect(app.state.playerRenditions.at(-1)).toEqual(RENDITIONS);
  });
});
