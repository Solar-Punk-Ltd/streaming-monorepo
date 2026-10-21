import Hls from 'hls.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import {
  buildPlayerConfig,
  LIVE_MAX_LATENCY_DURATION_S,
  LIVE_SYNC_DURATION_S,
} from '../src/components/SwarmHlsPlayer/playerConfig';

const CLIENT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLAYER_SOURCE = join(CLIENT_ROOT, 'src/components/SwarmHlsPlayer/SwarmHlsPlayer.tsx');

/** Loaders of the right shape, so a config can be built without importing the real ones. */
const NO_LOADERS = { pLoader: undefined, fLoader: undefined };

/**
 * Line and block comments removed.
 *
 * The component guard below is about what the component *sets*, and both this file and the component
 * discuss these keys in prose — including, deliberately, the wrong values a second copy of the
 * tuning had drifted to. Matching those made the guard fire on the very comment recording why it
 * exists. A `//` inside a string literal would be stripped too, which no source here has.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * What `buildPlayerConfig` returns, with the loaders taken back off, which is the tuning the player
 * is actually constructed with.
 *
 * Not `HLS_TUNING`. That is the constant this module builds from, and reading it here left the one
 * step between the constant and the player untested: a `buildPlayerConfig` that stopped spreading
 * the tuning shipped every value on the hls.js default, the live target back at hls.js's own three
 * target durations, with all 102 tests green. hls.js does not throw on a config that
 * merely omits these keys, so `new Hls(...)` did not catch it either.
 */
const {
  pLoader: _pLoader,
  fLoader: _fLoader,
  autoStartLoad: _autoStartLoad,
  ...SHIPPED_TUNING
} = buildPlayerConfig(NO_LOADERS);

/**
 * The numbers that decide how the stream feels, asserted as the values that ship rather than
 * against the constants they are built from.
 *
 * Comparing `HLS_TUNING.liveSyncDuration` to `LIVE_SYNC_DURATION_S` would pass whatever either one
 * became, including the two decoupled, which is exactly the state that produces a player throwing
 * from its constructor on every mount. So the literals are written out here, and the config is
 * additionally handed to a real `new Hls(...)`, which is the only thing that knows its own rules.
 */
describe('SwarmHlsPlayer hls.js tuning', () => {
  it('ships the numbers it means to', () => {
    assert.deepEqual(
      { ...SHIPPED_TUNING },
      {
        // 12, and `playerConfig.ts` carries the derivation and its history. Do not restate it here:
        // a number quoted in two places drifts in one of them.
        liveSyncDuration: 12,
        // Derived as twice the above rather than written, so it moves with it. hls.js throws from
        // the constructor when this is at or below `liveSyncDuration`.
        liveMaxLatencyDuration: 24,
        maxLiveSyncPlaybackRate: 1,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 62914560,
        maxBufferHole: 1,
      },
    );
  });

  // Exactly 1 is the value hls.js reads as "never adapt", and its latency controller then returns
  // before it touches the playback rate at all, which is also what leaves a speed the viewer picks
  // from the native controls alone.
  it('holds live playback at normal speed, which hls.js reads as never adapting the rate', () => {
    assert.equal(SHIPPED_TUNING.maxLiveSyncPlaybackRate, 1);
  });

  // Not a restatement of the first test. hls.js validates this pair in its constructor and throws,
  // so a ceiling that slipped to or below the sync target would take every mount of the player with
  // it, in the browser only, where no test in this suite runs.
  it('is a config hls.js will accept, which its constructor is the only judge of', () => {
    const player = new Hls(buildPlayerConfig(NO_LOADERS));

    player.destroy();
  });

  it('is rejected by that same constructor once the ceiling stops clearing the target', () => {
    // Proves the test above can fail. Without it, `new Hls` not throwing is equally consistent with
    // hls.js having dropped the check.
    assert.throws(
      () => new Hls({ ...buildPlayerConfig(NO_LOADERS), liveMaxLatencyDuration: LIVE_SYNC_DURATION_S }),
      /liveMaxLatencyDuration/,
    );
  });

  it('holds a buffer deeper than the latency it tolerates, so a seek is not into empty buffer', () => {
    assert.ok(SHIPPED_TUNING.maxBufferLength! >= LIVE_MAX_LATENCY_DURATION_S);
    assert.ok(SHIPPED_TUNING.maxMaxBufferLength! >= SHIPPED_TUNING.maxBufferLength!);
  });

  /**
   * Fragment loading is the component's to start, from its MANIFEST_PARSED handler, once it knows
   * which rung to start on. Left on, hls.js starts loading from its own MANIFEST_LOADED handler, and
   * whether that runs before or after the component sets `startLevel` depends on the order two
   * internal controllers registered for the same event.
   *
   * Asserted here because the flag and the `startLoad()` call are a pair: either alone is a player
   * that loads at the wrong moment, or one that never loads at all.
   */
  it('leaves fragment loading for the component to start', () => {
    assert.equal(buildPlayerConfig(NO_LOADERS).autoStartLoad, false);
  });

  it('carries the loaders through, since a config without them fetches from an origin that is not there', () => {
    const loaders = { pLoader: class {}, fLoader: class {} } as unknown as typeof NO_LOADERS;

    const config = buildPlayerConfig(loaders);

    assert.equal(config.pLoader, loaders.pLoader);
    assert.equal(config.fLoader, loaders.fLoader);
  });

  /**
   * The seam a rendering test would cover. Nothing in this package can mount a React tree, so what
   * is checked instead is that the component asks this module for its config rather than carrying
   * its own copy of these numbers, which is the state this file was extracted from.
   */
  describe('the player component is wired to it', () => {
    const code = stripComments(readFileSync(PLAYER_SOURCE, 'utf8'));

    it('builds its hls.js config here', () => {
      assert.match(code, /new Hls\(\s*buildPlayerConfig\(/);
    });

    it('starts the loading the config above left off', () => {
      assert.match(code, /\bstartLoad\(\)/);
    });

    for (const key of Object.keys(SHIPPED_TUNING)) {
      it(`does not set ${key} of its own`, () => {
        assert.doesNotMatch(code, new RegExp(`\\b${key}\\s*:`));
      });
    }

    // Proves the checks above can fail. Stripping comments is what makes them readable; it must not
    // be what makes them pass.
    it('still sees a tuning value the component sets, and only ignores one it talks about', () => {
      assert.match(stripComments('const c = { liveSyncDuration: 10 };'), /\bliveSyncDuration\s*:/);
      assert.doesNotMatch(stripComments('// drifted back to `liveSyncDuration: 10`'), /\bliveSyncDuration\s*:/);
    });
  });
});
