// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Stream } from '../src/types/stream';
import { StreamWatcher } from '../src/pages/StreamWatcher/StreamWatcher';

const OWNER = 'a'.repeat(40);
const TOPIC = 'stream-one';

const appContext = vi.hoisted(() => ({
  value: { streamList: [] as unknown[], isStreamListLoaded: true, readNextStreamListSlot: () => {} },
}));
const seen = vi.hoisted(() => ({
  pollMs: [] as (number | null)[],
  player: null as null | { renditions?: { name: string }[]; onLadderShort?: () => void },
}));

vi.mock('../src/providers/App', () => ({ useAppContext: () => appContext.value }));
vi.mock('../src/providers/useCatalogPoll', () => ({
  useCatalogPoll: (pollMs: number | null) => {
    seen.pollMs.push(pollMs);
  },
}));
vi.mock('../src/components/SwarmHlsPlayer/SwarmHlsPlayer', () => ({
  SwarmHlsPlayer: (props: NonNullable<typeof seen.player>) => {
    seen.player = props;
    return createElement('video', { 'data-testid': 'player' });
  },
}));

let container: HTMLDivElement;
let root: Root;

function listing(entry: Partial<Stream> & Record<string, unknown>) {
  appContext.value = {
    ...appContext.value,
    streamList: [{ owner: OWNER, topic: TOPIC, title: 'A talk', timestamp: 1, mediatype: 'video', ...entry }],
  };
}

function renderWatchPage() {
  act(() =>
    root.render(
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
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  seen.pollMs.length = 0;
  seen.player = null;
  act(() => root.unmount());
  container.remove();
});

/**
 * Architecture review 2026-10-08, P2 #7. The entry turns live once the first quality has reported, and
 * a viewer who joined then is handed one rendition. When the player says a ladder marker names a rung
 * the entry lacks, the page reads the list's next slot once, and the fuller entry reaches the player.
 * It never polls for it: a slot asked before it is written stays hidden for a minute.
 */
describe('the watch page with a ladder the player found short', () => {
  it('reads the stream list once each time the player says its entry is short, and never polls for it', () => {
    const rung = (name: string) => ({
      name,
      width: 1,
      height: 1,
      topic: `rung-${name}`,
      bandwidth: 1,
      avgBandwidth: 1,
    });
    const readNextStreamListSlot = vi.fn();
    appContext.value = { ...appContext.value, readNextStreamListSlot };
    listing({ state: 'live', renditions: [rung('360p')] });
    renderWatchPage();

    act(() => seen.player?.onLadderShort?.());

    expect(readNextStreamListSlot).toHaveBeenCalledTimes(1);
    expect(seen.pollMs.every((pollMs) => pollMs === null)).toBe(true);

    listing({ state: 'live', renditions: ['360p', '480p', '720p', '1080p'].map(rung) });
    renderWatchPage();
    expect(seen.player?.renditions?.map((r) => r.name)).toEqual(['360p', '480p', '720p', '1080p']);
    expect(seen.pollMs.every((pollMs) => pollMs === null)).toBe(true);
  });
});
