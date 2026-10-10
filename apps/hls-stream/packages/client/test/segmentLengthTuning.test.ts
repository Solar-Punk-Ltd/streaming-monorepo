import type Hls from 'hls.js';
import HlsPlayer, { Events } from 'hls.js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { attachLiveSyncToSegmentLength } from '../src/components/SwarmHlsPlayer/liveSyncLength';
import { buildPlayerConfig, liveLatencyFor } from '../src/components/SwarmHlsPlayer/playerConfig';
import { rungProgressBoundMs } from '../src/components/SwarmHlsPlayer/rungPosition';

/**
 * The two player numbers that were tuned to the event's 2 s segments: how long a rung has to show a
 * new index, and how far behind live the viewer sits. Both are three segments of the length the
 * playlist names, so a stage cutting longer segments is not called dead or rebuffered, and neither
 * drops under what it is at 2 s, so a stage cutting very short ones keeps the margin the player has
 * always run with.
 */
describe('the bound a rung has to show a new index in', () => {
  it('is three segments of the length the playlist names', () => {
    assert.equal(rungProgressBoundMs(2_000), 6_000);
    assert.equal(rungProgressBoundMs(4_000), 12_000);
  });

  it('never drops under six seconds, however short the segments', () => {
    assert.equal(rungProgressBoundMs(500), 6_000);
    assert.equal(rungProgressBoundMs(1_000), 6_000);
  });

  it('is six seconds while the length is not known', () => {
    for (const unknown of [null, undefined, 0, -1, Number.NaN]) {
      assert.equal(rungProgressBoundMs(unknown), 6_000, String(unknown));
    }
  });
});

describe('how far behind live the player aims', () => {
  it('is three segments of the length the playlist names, with the catch-up limit twice that', () => {
    assert.deepEqual(liveLatencyFor(2_000), { liveSyncDuration: 6, liveMaxLatencyDuration: 12 });
    assert.deepEqual(liveLatencyFor(4_000), { liveSyncDuration: 12, liveMaxLatencyDuration: 24 });
  });

  it('never drops under six seconds, however short the segments', () => {
    assert.deepEqual(liveLatencyFor(500), { liveSyncDuration: 6, liveMaxLatencyDuration: 12 });
    assert.deepEqual(liveLatencyFor(null), { liveSyncDuration: 6, liveMaxLatencyDuration: 12 });
  });

  /** hls.js throws from its constructor when the limit is not above the target, so the pair has to stay ordered. */
  it('is a pair hls.js accepts at every length', () => {
    for (const segmentMs of [null, 250, 2_000, 6_000, 30_000]) {
      const hls = new HlsPlayer({
        ...buildPlayerConfig({ pLoader: undefined, fLoader: undefined }),
        ...liveLatencyFor(segmentMs),
      });
      hls.destroy();
    }
  });
});

/** A player as the follower sees it: the live config, the target latency setter, and LEVEL_UPDATED. */
function makePlayer(callerTuning: { liveSyncDuration?: number } = {}) {
  const listeners = new Map<string, (event: string, data: unknown) => void>();
  const targets: number[] = [];
  const config = { liveSyncDuration: callerTuning.liveSyncDuration ?? 6, liveMaxLatencyDuration: 12 };
  const hls = {
    config,
    set targetLatency(latency: number) {
      targets.push(latency);
      config.liveSyncDuration = latency;
    },
    on: (event: string, listener: (event: string, data: unknown) => void) => listeners.set(event, listener),
    off: (event: string, listener: (event: string, data: unknown) => void) => {
      if (listeners.get(event) === listener) {
        listeners.delete(event);
      }
    },
  };
  const detach = attachLiveSyncToSegmentLength(hls as unknown as Hls, callerTuning);
  const playlist = (...durationsS: number[]) =>
    listeners.get(Events.LEVEL_UPDATED)?.(Events.LEVEL_UPDATED, {
      details: { fragments: durationsS.map((duration) => ({ duration })) },
    });
  return { config, targets, detach, playlist, listening: () => listeners.has(Events.LEVEL_UPDATED) };
}

describe('the live target following the segment length', () => {
  it('moves to three segments behind live once a playlist of longer segments arrives', () => {
    const player = makePlayer();

    player.playlist(4, 4, 4.1, 3.9);

    assert.deepEqual(player.targets, [12]);
    assert.equal(player.config.liveMaxLatencyDuration, 24);
  });

  it('leaves the target alone on the 2 s stage, and on a stage cutting shorter segments', () => {
    const player = makePlayer();

    player.playlist(2, 2, 2);
    player.playlist(0.5, 0.5, 0.5);

    assert.deepEqual(player.targets, []);
    assert.deepEqual(player.config, { liveSyncDuration: 6, liveMaxLatencyDuration: 12 });
  });

  it('sets the target once per length, not on every playlist', () => {
    const player = makePlayer();

    player.playlist(4, 4);
    player.playlist(4, 4, 4);
    player.playlist(2, 2, 2);

    assert.deepEqual(player.targets, [12, 6]);
    assert.equal(player.config.liveMaxLatencyDuration, 12);
  });

  /** A measurement harness moves the target through `hls.targetLatency` between arms of one broadcast. */
  it('leaves a target set from outside while the segment length holds', () => {
    const player = makePlayer();
    player.config.liveSyncDuration = 9;

    player.playlist(2, 2, 2);

    assert.deepEqual(player.targets, []);
    assert.equal(player.config.liveSyncDuration, 9);
  });

  /** A caller who names a target keeps it, even one equal to the shipped floor. */
  it('keeps a target of 6 s the caller set at 6 s, whatever length the playlist names', () => {
    const player = makePlayer({ liveSyncDuration: 6 });

    player.playlist(2, 2, 2);
    player.playlist(4, 4, 4);

    assert.deepEqual(player.targets, []);
    assert.equal(player.config.liveSyncDuration, 6);
  });

  it('keeps a target of 9 s the caller set at 9 s', () => {
    const player = makePlayer({ liveSyncDuration: 9 });

    player.playlist(4, 4, 4);

    assert.deepEqual(player.targets, []);
    assert.equal(player.config.liveSyncDuration, 9);
  });

  it('stops listening once detached', () => {
    const player = makePlayer();

    player.detach();

    assert.equal(player.listening(), false);
  });
});
