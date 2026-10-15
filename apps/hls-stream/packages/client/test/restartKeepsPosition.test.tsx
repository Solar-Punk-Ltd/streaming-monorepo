// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import assert from 'node:assert/strict';
import { ErrorDetails, ErrorTypes, Events } from 'hls.js';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { SwarmHlsPlayer } from '../src/components/SwarmHlsPlayer/SwarmHlsPlayer';
import { MEDIA_TYPE_VIDEO } from '../src/types/stream';

/**
 * Where the player picks up after it rebuilds itself on a fatal error. Seen live on 2026-10-15: a viewer
 * 2100 s into a 2142 s recording hit a fatal error and was sent back to 0. A recording has a fixed
 * timeline, so the rebuilt player resumes where the viewer was. A live broadcast rejoins at the live
 * edge as it always has, because its timeline is rebuilt from the newest playlist.
 */

type Handler = (event: string, data: unknown) => void;

const fakes = vi.hoisted(() => {
  const instances: Array<{
    handlers: Map<string, Handler[]>;
    startLoads: Array<number | undefined>;
    levels: Array<{ details?: { live: boolean } }>;
    currentLevel: number;
    destroyed: boolean;
  }> = [];
  return { instances };
});

vi.mock('hls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hls.js')>();
  class FakeHls {
    static isSupported() {
      return true;
    }
    static DefaultConfig = actual.default.DefaultConfig;
    handlers = new Map<string, Handler[]>();
    startLoads: Array<number | undefined> = [];
    levels: Array<{ details?: { live: boolean } }> = [];
    currentLevel = -1;
    destroyed = false;
    config = { abrBandWidthUpFactor: 0.7 };
    constructor() {
      fakes.instances.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }
    off() {}
    attachMedia() {}
    loadSource() {}
    startLoad(position?: number) {
      this.startLoads.push(position);
    }
    stopLoad() {}
    destroy() {
      this.destroyed = true;
    }
  }
  return { ...actual, default: FakeHls };
});

vi.mock('../src/components/SwarmHlsPlayer/CustomManifestLoader', () => ({
  CustomManifestLoader: class {},
  CustomFragmentLoader: class {},
  manifestFetcher: {
    feedHealth: {
      subscribe: () => () => undefined,
      recordPlaybackStall: () => undefined,
    },
    registerLadder: () => undefined,
    unregisterLadder: () => undefined,
    watchLadderCompletion: () => () => undefined,
    followOnlyRung: () => undefined,
    attachPlayhead: () => () => undefined,
    markLiveSegmentGap: () => false,
  },
}));

const { noDetach } = vi.hoisted(() => ({ noDetach: () => () => undefined }));
vi.mock('../src/components/SwarmHlsPlayer/rungHealth', () => ({
  attachActiveRungFollower: noDetach,
  attachRungFailover: noDetach,
  attachWatchedRungReporter: noDetach,
}));
vi.mock('../src/components/SwarmHlsPlayer/livePlaybackRate', () => ({ attachLivePlaybackRateGuard: noDetach }));
vi.mock('../src/components/SwarmHlsPlayer/liveSyncLength', () => ({ attachLiveSyncToSegmentLength: noDetach }));
vi.mock('../src/components/SwarmHlsPlayer/playerTestHandle', () => ({ exposePlayerForInstrumentation: noDetach }));
vi.mock('../src/components/SwarmHlsPlayer/playbackHealth', () => ({ attachPlaybackStallReporter: noDetach }));
vi.mock('../src/components/SwarmHlsPlayer/returningBroadcast', () => ({ attachReturningBroadcastRejoin: noDetach }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fakes.instances.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function emit(index: number, event: string, data: unknown = {}): void {
  const instance = fakes.instances[index];
  act(() => {
    for (const handler of instance.handlers.get(event) ?? []) {
      handler(event, data);
    }
  });
}

const FATAL_LEVEL_LOAD = { fatal: true, type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.LEVEL_LOAD_ERROR };

/**
 * Mounts the player, plays to `positionS` on a level that is or is not live, and fails it fatally.
 *
 * @param parseRebuilt Whether the rebuilt player then parses its manifest, which is when it starts loading.
 */
function failFatallyAt(positionS: number, live: boolean, parseRebuilt = true): void {
  act(() => {
    root.render(
      createElement(SwarmHlsPlayer, {
        owner: '0000000000000000000000000000000000000000',
        topicString: 'restart-position',
        mediaType: MEDIA_TYPE_VIDEO,
        autoPlay: false,
      }),
    );
  });
  const video = container.querySelector('video');
  assert.ok(video);
  emit(0, Events.MANIFEST_PARSED);
  fakes.instances[0].levels = [{ details: { live } }];
  fakes.instances[0].currentLevel = 0;
  Object.defineProperty(video, 'currentTime', { configurable: true, value: positionS });

  emit(0, Events.ERROR, FATAL_LEVEL_LOAD);
  assert.equal(fakes.instances[0].destroyed, true, 'the fatal error did not restart the player');
  assert.equal(fakes.instances.length, 2, 'no second player was built');
  if (parseRebuilt) {
    emit(1, Events.MANIFEST_PARSED);
  }
}

describe('a player restarted by a fatal error', () => {
  it('resumes a recording where the viewer was, not from the start', () => {
    failFatallyAt(2100, false);

    assert.deepEqual(fakes.instances[1].startLoads, [2100]);
  });

  // The rebuilt player holds no level yet, so what it reads as its own position is nothing, and that
  // nothing must not replace the place the viewer had.
  it('keeps the recording position through a second fatal error before the rebuilt player has started', () => {
    failFatallyAt(2100, false, false);

    emit(1, Events.ERROR, FATAL_LEVEL_LOAD);
    assert.equal(fakes.instances.length, 3, 'the second fatal error did not restart the player');
    emit(2, Events.MANIFEST_PARSED);

    assert.deepEqual(fakes.instances[2].startLoads, [2100]);
  });

  it('names the error that caused the restart in the line that announces it', () => {
    failFatallyAt(2100, false);

    const lines = vi.mocked(console.warn).mock.calls.map((call) => call.join(' '));
    const restart = lines.filter((line) => line.startsWith('Restarting stream'));
    assert.equal(restart.length, 1, `restart lines: ${restart.join(' | ')}`);
    assert.match(restart[0], new RegExp(ErrorDetails.LEVEL_LOAD_ERROR));
    assert.doesNotMatch(restart[0], /manifest parsing/);
  });

  it('rejoins a live broadcast at the live edge, as it always has', () => {
    failFatallyAt(2100, true);

    assert.deepEqual(fakes.instances[1].startLoads, [undefined]);
  });

  it('starts a recording the viewer had not started yet from the start', () => {
    failFatallyAt(0, false);

    assert.deepEqual(fakes.instances[1].startLoads, [undefined]);
  });
});
