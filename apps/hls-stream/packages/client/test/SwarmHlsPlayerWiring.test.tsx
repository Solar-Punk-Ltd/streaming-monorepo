// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import assert from 'node:assert/strict';
import { Topic } from '@ethersphere/bee-js';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { FEED_STATE_STALLED, type FeedState } from '../src/components/SwarmHlsPlayer/feedState';
import { SwarmHlsPlayer, type HlsPlayerProps } from '../src/components/SwarmHlsPlayer/SwarmHlsPlayer';
import { MEDIA_TYPE_VIDEO } from '../src/types/stream';

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
  manifestFetcher: { feedHealth: fakes.feedHealth, registerLadder: vi.fn(), unregisterLadder: vi.fn() },
}));

vi.mock('../src/components/SwarmHlsPlayer/playbackHealth', () => ({
  attachPlaybackStallReporter: fakes.attachStallReporter,
}));

/** A bundle built with a release, which only the QoE overlay may show. */
const built = vi.hoisted(() => ({
  release: { label: 'QA-build-2026-10-07', commit: `1702aff1b${'e'.repeat(31)}` },
}));

vi.mock('../src/utils/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/config')>();
  return { config: { ...actual.config, release: built.release } };
});

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

/**
 * The release the player was built as is for whoever opens the QoE overlay, which `?qoe=1` on a watch
 * URL does, and for nobody else: the player's own face shows nothing of it.
 */
describe('the release the player was built as', () => {
  it('shows nowhere in the player without the overlay', () => {
    mount({ topicString: 'stream-a' });

    assert.equal(container.querySelector('.qoe-overlay__release'), null);
    assert.doesNotMatch(container.textContent ?? '', /QA-build-2026-10-07|1702aff1b/);
  });

  it('shows in the overlay, under its header', () => {
    mount({ topicString: 'stream-a', enableQoeOverlay: true });

    const line = container.querySelector('.qoe-overlay__release .qoe-overlay__value');
    assert.equal(line?.textContent, 'QA-build-2026-10-07 (1702aff1b)');
    assert.equal(line?.getAttribute('title'), built.release.commit);
  });
});
