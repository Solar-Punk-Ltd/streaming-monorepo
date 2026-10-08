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
  value: { streamList: [] as unknown[], isStreamListLoaded: true },
}));
const seen = vi.hoisted(() => ({
  pollMs: [] as (number | null)[],
  player: null as null | { renditions?: { name: string }[]; onLadderIncomplete?: (incomplete: boolean) => void },
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
 * a viewer who joined then is handed one rendition. The player says the ladder's marker names more,
 * the page reads the stream list again, and the fuller entry reaches the player.
 */
describe('the watch page with a ladder the player found short', () => {
  it('reads the stream list again while the player says its entry was short, until the entry names every rung', () => {
    const rung = (name: string) => ({
      name,
      width: 1,
      height: 1,
      topic: `rung-${name}`,
      bandwidth: 1,
      avgBandwidth: 1,
    });
    listing({ state: 'live', renditions: [rung('360p')] });
    renderWatchPage();
    expect(seen.pollMs.at(-1)).toBeNull();

    act(() => seen.player?.onLadderIncomplete?.(true));
    expect(seen.pollMs.at(-1)).toBe(5_000);

    listing({ state: 'live', renditions: ['360p', '480p', '720p', '1080p'].map(rung) });
    renderWatchPage();
    expect(seen.player?.renditions?.map((r) => r.name)).toEqual(['360p', '480p', '720p', '1080p']);

    act(() => seen.player?.onLadderIncomplete?.(false));
    expect(seen.pollMs.at(-1)).toBeNull();
  });
});
