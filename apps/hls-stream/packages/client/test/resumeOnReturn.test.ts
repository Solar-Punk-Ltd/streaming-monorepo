import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import {
  attachResumeOnReturn,
  decideOnReturn,
  isViewerPause,
  type ReturnPage,
  type ReturnSnapshot,
} from '../src/components/SwarmHlsPlayer/resumeOnReturn';

/** A live stream the lock paused, with no pause event seen, which a return must play again. */
const PAUSED_UNSEEN: ReturnSnapshot = {
  isLive: true,
  isPaused: true,
  lastPause: null,
  hiddenAtMs: 10_000,
};

/**
 * An iPhone pauses the video when the phone locks and Safari does not resume it on unlock,
 * so a live viewer came back to a stopped player. A return plays it again unless the viewer paused it.
 *
 * Written in milliseconds rather than against the module's constant, so that a change to the window is
 * a change a test notices.
 */
describe('whose pause it was', () => {
  it("is the viewer's, made while watching more than a second before the page was hidden", () => {
    assert.equal(isViewerPause({ atMs: 8_900, whilePageVisible: true }, 10_000), true);
  });

  it("is the system's, made in the second before the page was hidden", () => {
    assert.equal(isViewerPause({ atMs: 9_000, whilePageVisible: true }, 10_000), false);
    assert.equal(isViewerPause({ atMs: 9_800, whilePageVisible: true }, 10_000), false);
  });

  it("is the system's, made while the page was hidden", () => {
    assert.equal(isViewerPause({ atMs: 10_050, whilePageVisible: false }, 10_000), false);
  });

  it("is the viewer's, made while watching a page never hidden", () => {
    assert.equal(isViewerPause({ atMs: 8_900, whilePageVisible: true }, null), true);
  });
});

describe('what the player does when the page becomes visible again', () => {
  it('plays a paused live stream whose pause it never saw', () => {
    assert.equal(decideOnReturn(PAUSED_UNSEEN), 'play');
  });

  it('plays a paused live stream the system paused', () => {
    assert.equal(decideOnReturn({ ...PAUSED_UNSEEN, lastPause: { atMs: 10_050, whilePageVisible: false } }), 'play');
  });

  it('leaves a live stream the viewer paused', () => {
    assert.equal(decideOnReturn({ ...PAUSED_UNSEEN, lastPause: { atMs: 3_000, whilePageVisible: true } }), 'leave');
  });

  it('leaves a live stream that is playing, whatever its last pause was', () => {
    assert.equal(decideOnReturn({ ...PAUSED_UNSEEN, isPaused: false }), 'leave');
  });

  it('leaves a recording', () => {
    assert.equal(decideOnReturn({ ...PAUSED_UNSEEN, isLive: false }), 'leave');
  });
});

type EventName = 'visibilitychange' | 'pagehide' | 'pageshow' | 'pause';

/** Listeners keyed on their event type, as a real target keeps them, so a wrong event name fails. */
function makeTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    addEventListener: (type: EventName, listener: (event: Event) => void) => {
      const forType = listeners.get(type) ?? new Set();
      forType.add(listener);
      listeners.set(type, forType);
    },
    removeEventListener: (type: EventName, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: EventName, event: Record<string, unknown> = {}) => {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener(event as unknown as Event);
      }
    },
    count: () => [...listeners.values()].reduce((total, forType) => total + forType.size, 0),
  };
}

function makeStage(options: { isLive?: boolean; play?: () => Promise<void> } = {}) {
  let clockMs = 0;
  const page = { ...makeTarget(), visibilityState: 'visible' as DocumentVisibilityState };
  const mediaEvents = makeTarget();
  const media = {
    ...mediaEvents,
    paused: false,
    currentTime: 100,
    play: vi.fn((): Promise<void> => {
      media.paused = false;
      return options.play?.() ?? Promise.resolve();
    }),
  };
  const reportPlayFailure = vi.fn();
  const detach = attachResumeOnReturn(
    media as unknown as HTMLMediaElement,
    { document: page, window: page } as unknown as ReturnPage,
    () => options.isLive ?? true,
    reportPlayFailure,
    () => clockMs,
  );
  return {
    media,
    page,
    reportPlayFailure,
    detach,
    plays: () => media.play.mock.calls.length,
    at: (ms: number) => {
      clockMs = ms;
    },
    hide: () => {
      page.visibilityState = 'hidden';
      page.emit('visibilitychange');
    },
    show: () => {
      page.visibilityState = 'visible';
      page.emit('visibilitychange');
    },
    pause: () => {
      media.paused = true;
      mediaEvents.emit('pause');
    },
    listenerCount: () => page.count() + mediaEvents.count(),
  };
}

describe('the player wired to the page coming back', () => {
  it('plays a live stream the lock paused without a pause event', () => {
    const stage = makeStage();
    stage.at(5_000);
    stage.hide();
    stage.media.paused = true;
    stage.at(65_000);
    stage.show();

    assert.equal(stage.plays(), 1);
    assert.equal(stage.media.currentTime, 100, 'a return never seeks, hls.js moves the viewer to live');
  });

  it('plays a live stream the lock paused while the page was hidden', () => {
    const stage = makeStage();
    stage.at(5_000);
    stage.hide();
    stage.at(5_200);
    stage.pause();
    stage.at(65_000);
    stage.show();

    assert.equal(stage.plays(), 1);
  });

  it('plays a live stream paused in the second before the page was hidden', () => {
    const stage = makeStage();
    stage.at(4_400);
    stage.pause();
    stage.at(5_000);
    stage.hide();
    stage.at(65_000);
    stage.show();

    assert.equal(stage.plays(), 1);
  });

  it('leaves a live stream the viewer paused while watching, then hid', () => {
    const stage = makeStage();
    stage.at(1_000);
    stage.pause();
    stage.at(5_000);
    stage.hide();
    stage.at(65_000);
    stage.show();

    assert.equal(stage.plays(), 0);
  });

  it('plays a live stream whose system pause arrives just after the page is back', () => {
    const stage = makeStage();
    stage.at(5_000);
    stage.hide();
    stage.at(65_000);
    stage.show();
    assert.equal(stage.plays(), 0);
    stage.at(65_400);
    stage.pause();

    assert.equal(stage.plays(), 1);
  });

  it('leaves a pause the viewer makes once the page has been back a while', () => {
    const stage = makeStage();
    stage.at(5_000);
    stage.hide();
    stage.at(65_000);
    stage.show();
    stage.at(70_000);
    stage.pause();

    assert.equal(stage.plays(), 0);
  });

  it('leaves a playing live stream alone', () => {
    const stage = makeStage();
    stage.at(5_000);
    stage.hide();
    stage.at(65_000);
    stage.show();

    assert.equal(stage.plays(), 0);
  });

  it('leaves a recording the lock paused', () => {
    const stage = makeStage({ isLive: false });
    stage.at(5_000);
    stage.hide();
    stage.pause();
    stage.at(65_000);
    stage.show();
    stage.at(65_200);
    stage.pause();

    assert.equal(stage.plays(), 0);
  });

  it('plays once on a back-forward cache restore, which fires both a visibility change and a page show', () => {
    const stage = makeStage();
    stage.at(5_000);
    stage.page.emit('pagehide', { persisted: true });
    stage.hide();
    stage.pause();
    stage.at(65_000);
    stage.page.emit('pageshow', { persisted: true });
    stage.show();

    assert.equal(stage.plays(), 1);
  });

  it('ignores a page show that is a first load', () => {
    const stage = makeStage();
    stage.media.paused = true;
    stage.page.emit('pageshow', { persisted: false });

    assert.equal(stage.plays(), 0);
  });

  it('reports a refused play once, and does nothing else', async () => {
    const refusal = new Error('NotAllowedError');
    const stage = makeStage({
      play: () => {
        stage.media.paused = true;
        return Promise.reject(refusal);
      },
    });
    stage.at(5_000);
    stage.hide();
    stage.pause();
    stage.at(65_000);
    stage.page.emit('pageshow', { persisted: true });
    stage.show();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(stage.plays(), 1);
    assert.deepEqual(stage.reportPlayFailure.mock.calls, [[refusal]]);
    assert.equal(stage.media.currentTime, 100);
  });

  it('removes every listener it added', () => {
    const stage = makeStage();
    assert.ok(stage.listenerCount() > 0);
    stage.detach();
    assert.equal(stage.listenerCount(), 0);
  });
});
