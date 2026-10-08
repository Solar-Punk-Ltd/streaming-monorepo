// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import assert from 'node:assert/strict';
import { Topic } from '@ethersphere/bee-js';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { FEED_STATE_STALLED, type FeedState } from '../src/components/SwarmHlsPlayer/feedState';
import { SwarmHlsPlayer, type HlsPlayerProps } from '../src/components/SwarmHlsPlayer/SwarmHlsPlayer';
import { MEDIA_TYPE_VIDEO, type Rendition } from '../src/types/stream';

/**
 * The player's two wirings that outlive, or end with, one hls.js instance, checked by mounting the
 * player rather than by reading its source. jsdom has no MediaSource, so hls.js reports itself
 * unsupported and the player runs without it, which both wirings do: neither depends on hls.js.
 */
const fakes = vi.hoisted(() => {
  const subscriptions: Array<{ topic: string; listener: (state: FeedState) => void }> = [];
  const unsubscribed: string[] = [];
  const detachStallReporter = vi.fn();
  return {
    rungsMissingFromLadder: vi.fn(async (_sourceUrl: string): Promise<string[]> => []),
    registerLadder: vi.fn(),
    subscriptions,
    unsubscribed,
    detachStallReporter,
    attachStallReporter: vi.fn((_media: HTMLMediaElement, _onStall: () => void) => detachStallReporter),
    feedHealth: {
      subscribe: vi.fn((topic: string, listener: (state: FeedState) => void) => {
        subscriptions.push({ topic, listener });
        return () => {
          unsubscribed.push(topic);
        };
      }),
      recordPlaybackStall: vi.fn(),
    },
  };
});

vi.mock('../src/components/SwarmHlsPlayer/CustomManifestLoader', () => ({
  CustomManifestLoader: class {},
  CustomFragmentLoader: class {},
  manifestFetcher: {
    feedHealth: fakes.feedHealth,
    registerLadder: fakes.registerLadder,
    unregisterLadder: vi.fn(),
    rungsMissingFromLadder: fakes.rungsMissingFromLadder,
  },
}));

vi.mock('../src/components/SwarmHlsPlayer/playbackHealth', () => ({
  attachPlaybackStallReporter: fakes.attachStallReporter,
}));

const OWNER = '0000000000000000000000000000000000000000';
const hexOf = (topicString: string) => Topic.fromString(topicString).toString();

let container: HTMLDivElement;
let root: Root;

function mount(props: Partial<HlsPlayerProps> & { topicString: string }) {
  act(() => {
    root.render(createElement(SwarmHlsPlayer, { owner: OWNER, mediaType: MEDIA_TYPE_VIDEO, ...props }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The player says once per mount that this browser has no hls.js, which is true of jsdom.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fakes.subscriptions.length = 0;
  fakes.unsubscribed.length = 0;
  fakes.feedHealth.subscribe.mockClear();
  fakes.feedHealth.recordPlaybackStall.mockClear();
  fakes.attachStallReporter.mockClear();
  fakes.registerLadder.mockClear();
  fakes.rungsMissingFromLadder.mockReset();
  fakes.rungsMissingFromLadder.mockResolvedValue([]);
  fakes.detachStallReporter.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('the player component is wired to the feed state tracker', () => {
  /**
   * The root cause, guarded at the one place a test cannot otherwise reach. A subscription inside
   * the player effect is torn down and rebuilt on every restart, and a fatal network error is what
   * causes a restart, so it would be dropped exactly when the outage it describes is under way.
   */
  it('subscribes on the topic alone, not on anything a restart changes', () => {
    mount({ topicString: 'stream-a' });
    assert.deepEqual(
      fakes.subscriptions.map(({ topic }) => topic),
      [hexOf('stream-a')],
    );

    // Each of these rebuilds the player, which the stall reporter being attached again shows.
    mount({ topicString: 'stream-a', level: '720p' });
    mount({ topicString: 'stream-a', level: '720p', autoPlay: false });
    assert.equal(fakes.attachStallReporter.mock.calls.length, 3, 'the player was rebuilt twice');
    assert.equal(fakes.subscriptions.length, 1, 'and the subscription outlived both rebuilds');
    assert.deepEqual(fakes.unsubscribed, []);

    mount({ topicString: 'stream-b' });
    assert.deepEqual(fakes.unsubscribed, [hexOf('stream-a')]);
    assert.deepEqual(
      fakes.subscriptions.map(({ topic }) => topic),
      [hexOf('stream-a'), hexOf('stream-b')],
    );
  });

  it('shows the state the tracker reports for the topic being watched', () => {
    mount({ topicString: 'stream-a' });

    act(() => fakes.subscriptions[0].listener(FEED_STATE_STALLED));

    assert.match(container.textContent ?? '', /Waiting for the broadcast to continue/);
  });

  /** Attached with the player rather than with the subscription, since it is the player that stalls. */
  it('detaches the reporter when the player is torn down', () => {
    mount({ topicString: 'stream-a' });
    const video = container.querySelector('video');
    assert.ok(video, 'the player rendered a video element');
    assert.equal(fakes.attachStallReporter.mock.calls[0][0], video);
    assert.equal(fakes.detachStallReporter.mock.calls.length, 0);

    mount({ topicString: 'stream-a', level: '720p' });
    assert.equal(fakes.detachStallReporter.mock.calls.length, 1, 'a rebuild detaches the old reporter');
    assert.equal(fakes.attachStallReporter.mock.calls.length, 2, 'and attaches a new one');

    act(() => root.unmount());
    root = createRoot(container);
    assert.equal(fakes.detachStallReporter.mock.calls.length, 2, 'unmounting detaches the last one');
  });

  it('counts the stalls it reports under the topic being watched', () => {
    mount({ topicString: 'stream-a' });
    const onStall = fakes.attachStallReporter.mock.calls[0][1];

    onStall();

    assert.deepEqual(fakes.feedHealth.recordPlaybackStall.mock.calls, [[hexOf('stream-a')]]);
  });
});

/** Lets settled promises run, then applies what they changed. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Architecture review 2026-10-08, P2 #7. A viewer who joined while only some qualities had reported
 * holds a short entry, and the player builds its master from it once. The player says so, so the page
 * can read the stream list again, and the fuller entry rebuilds the player with every quality.
 */
describe('the player says when the stream list named fewer rungs than the ladder has', () => {
  const rendition = (name: string, height: number): Rendition => ({
    name,
    width: (height * 16) / 9,
    height,
    topic: `rung-${name}`,
    bandwidth: height * 1000,
    avgBandwidth: height * 1000,
  });
  const ONE = [rendition('360p', 360)];
  const FOUR = [rendition('360p', 360), rendition('480p', 480), rendition('720p', 720), rendition('1080p', 1080)];

  it('reports a short entry, and once the entry names every rung it rebuilds with all four and reports it whole', async () => {
    const onLadderIncomplete = vi.fn();
    fakes.rungsMissingFromLadder.mockResolvedValue([hexOf('rung-480p'), hexOf('rung-720p'), hexOf('rung-1080p')]);
    mount({ topicString: 'stream-a', renditions: ONE, onLadderIncomplete });
    await settle();

    assert.deepEqual(onLadderIncomplete.mock.calls, [[true]]);

    fakes.rungsMissingFromLadder.mockResolvedValue([]);
    mount({ topicString: 'stream-a', renditions: FOUR, onLadderIncomplete });
    await settle();

    assert.deepEqual(onLadderIncomplete.mock.calls, [[true], [false]]);
    const resolve = fakes.registerLadder.mock.calls.at(-1)?.[1] as () => { renditions: Rendition[] };
    assert.deepEqual(
      resolve().renditions.map((r) => r.name),
      ['360p', '480p', '720p', '1080p'],
      'the rebuilt player does not offer every quality',
    );
  });

  it('asks nothing of a stream the list gave no ladder', async () => {
    const onLadderIncomplete = vi.fn();
    mount({ topicString: 'stream-a', onLadderIncomplete });
    await settle();

    assert.equal(fakes.rungsMissingFromLadder.mock.calls.length, 0);
    assert.deepEqual(onLadderIncomplete.mock.calls, []);
  });

  it('reports nothing for a player torn down before the marker answered', async () => {
    const onLadderIncomplete = vi.fn();
    fakes.rungsMissingFromLadder.mockResolvedValue([hexOf('rung-480p')]);
    mount({ topicString: 'stream-a', renditions: ONE, onLadderIncomplete });
    act(() => root.unmount());
    root = createRoot(container);
    await settle();

    assert.deepEqual(onLadderIncomplete.mock.calls, []);
  });
});
