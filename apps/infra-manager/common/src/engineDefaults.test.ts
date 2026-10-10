/**
 * What an unset setting falls back to, once the host has a say in it.
 *
 * The case that matters is a base `.env` that already sets one of these keys.
 * `.env.<profile>` is a copy of it and an unset key is left out, so that host
 * value is what the container starts with, and everything that names a default
 * or checks a pair of them has to say so.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import { effectiveEngineDefaults } from './engineDefaults.js';

describe('effectiveEngineDefaults', () => {
  it('answers the stack default for every key when the base env sets none', () => {
    const { values, sources, rejected } = effectiveEngineDefaults(SRS_SERVICE);

    assert.equal(values.HLS_WINDOW, '15');
    assert.equal(values.ABR_PRESET, 'veryfast');
    assert.equal(sources.HLS_WINDOW, 'stack');
    assert.deepEqual(rejected, []);
  });

  it('takes the base env value, and says the host set it', () => {
    const { values, sources } = effectiveEngineDefaults(SRS_SERVICE, {
      HLS_WINDOW: '30',
    });

    assert.equal(values.HLS_WINDOW, '30');
    assert.equal(sources.HLS_WINDOW, 'host');
    // Untouched keys keep the stack's own value and say so.
    assert.equal(values.HLS_SEGMENT_MAX, '2.5');
    assert.equal(sources.HLS_SEGMENT_MAX, 'stack');
  });

  it('keeps the stack default when the base env value is one the field refuses', () => {
    const { values, sources, rejected } = effectiveEngineDefaults(SRS_SERVICE, {
      HLS_WINDOW: '9000',
    });

    assert.equal(values.HLS_WINDOW, '15');
    assert.equal(sources.HLS_WINDOW, 'stack');
    assert.deepEqual(rejected, ['HLS_WINDOW']);
  });

  it('treats an empty base env value as unset', () => {
    const { values, sources, rejected } = effectiveEngineDefaults(SRS_SERVICE, {
      HLS_WINDOW: '   ',
    });

    assert.equal(values.HLS_WINDOW, '15');
    assert.equal(sources.HLS_WINDOW, 'stack');
    assert.deepEqual(rejected, []);
  });

  it("takes the version's own fallback over the pinned one, and still calls it the stack's", () => {
    const { values, sources } = effectiveEngineDefaults(SRS_SERVICE, {}, { HLS_WINDOW: '22.5' });

    assert.equal(values.HLS_WINDOW, '22.5');
    assert.equal(sources.HLS_WINDOW, 'stack');
    assert.equal(values.ABR_PRESET, 'veryfast');
  });

  it('lets the host value win over the version fallback as well', () => {
    const { values, sources } = effectiveEngineDefaults(SRS_SERVICE, { HLS_WINDOW: '30' }, { HLS_WINDOW: '22.5' });

    assert.equal(values.HLS_WINDOW, '30');
    assert.equal(sources.HLS_WINDOW, 'host');
  });

  /**
   * The stack has no default segment length and refuses to start without one, so the manager names
   * it on every deploy. A version cut before that still falls back to 0.5 or 1.5 on its own, and is
   * handed the manager's 2 all the same.
   */
  it("takes the manager's two second segment over any fallback a version names, and says the manager set it", () => {
    const fallbacks: Record<string, string>[] = [{}, { HLS_FRAGMENT: '0.5' }, { HLS_FRAGMENT: '1.5' }];
    for (const stack of fallbacks) {
      const { values, sources } = effectiveEngineDefaults(SRS_SERVICE, {}, stack);

      assert.equal(values.HLS_FRAGMENT, '2');
      assert.equal(sources.HLS_FRAGMENT, 'manager');
    }
  });

  it('still lets a segment length set on the host win over the manager default', () => {
    const { values, sources } = effectiveEngineDefaults(SRS_SERVICE, { HLS_FRAGMENT: '1' }, { HLS_FRAGMENT: '0.5' });

    assert.equal(values.HLS_FRAGMENT, '1');
    assert.equal(sources.HLS_FRAGMENT, 'host');
  });

  it("takes the manager's own SRT latency over a version's fallback, and says the manager set it", () => {
    // v3.1's entrypoint falls back to 200. The manager sets 2000 since
    // 2026-09-23, and a version pinned before that does not know it.
    const { values, sources } = effectiveEngineDefaults(SRS_SERVICE, {}, { SRT_LATENCY: '200', HLS_WINDOW: '22.5' });

    assert.equal(values.SRT_LATENCY, '2000');
    assert.equal(sources.SRT_LATENCY, 'manager');
    assert.equal(sources.HLS_WINDOW, 'stack', 'the other keys still follow the version');
  });

  it('still lets a value set on the host win over the manager default', () => {
    const { values, sources } = effectiveEngineDefaults(SRS_SERVICE, { SRT_LATENCY: '500' }, { SRT_LATENCY: '200' });

    assert.equal(values.SRT_LATENCY, '500');
    assert.equal(sources.SRT_LATENCY, 'host');
  });

  it('keeps the manager default when the host sets an SRT latency the field refuses', () => {
    const { values, sources, rejected } = effectiveEngineDefaults(SRS_SERVICE, {
      SRT_LATENCY: '5',
    });

    assert.equal(values.SRT_LATENCY, '2000');
    assert.equal(sources.SRT_LATENCY, 'manager');
    assert.deepEqual(rejected, ['SRT_LATENCY']);
  });

  it('answers only the keys the engine reads', () => {
    const { values } = effectiveEngineDefaults(OME_SERVICE, {
      API_PORT: '10000',
      HLS_FRAGMENT: '2',
      HLS_SEGMENT_DURATION: '4',
    });

    assert.deepEqual(Object.keys(values).sort(), [
      'HLS_SEGMENT_COUNT',
      'HLS_SEGMENT_DURATION',
      'OME_HLS_POLL_INTERVAL_MS',
    ]);
    assert.equal(values.HLS_SEGMENT_DURATION, '4');
  });
});
