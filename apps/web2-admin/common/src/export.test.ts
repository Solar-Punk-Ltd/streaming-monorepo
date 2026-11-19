import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXPORT_OUTDATED_TEXT, exportOutdated, type ExportState } from './export.js';

describe('whether a kept file is out of date', () => {
  const done = { state: 'done' as const, manifestIndex: 42 };

  it('is not while the quality holds the playlist the export read', () => {
    assert.equal(exportOutdated(done, { live: false, manifestIndex: 42 }), null);
  });

  it('is once the stream recorded again, which gives the quality another playlist', () => {
    assert.equal(exportOutdated(done, { live: false, manifestIndex: 57 }), 'recorded_again');
  });

  it('is once the stream recorded again without this quality', () => {
    assert.equal(exportOutdated(done, { live: false, manifestIndex: null }), 'recorded_again');
  });

  it('is while the stream is live again, whatever index the quality holds', () => {
    assert.equal(exportOutdated(done, { live: true, manifestIndex: null }), 'live');
    assert.equal(exportOutdated(done, { live: true, manifestIndex: 42 }), 'live');
  });

  it('is never for an export that is not finished, which pauses on a live stream by itself', () => {
    const open: ExportState[] = ['reading', 'joining', 'paused', 'waiting'];
    for (const state of open) {
      assert.equal(exportOutdated({ state, manifestIndex: 42 }, { live: true, manifestIndex: null }), null, state);
      assert.equal(exportOutdated({ state, manifestIndex: 42 }, { live: false, manifestIndex: 57 }), null, state);
    }
  });

  it('has a sentence for each reason', () => {
    assert.match(EXPORT_OUTDATED_TEXT.live, /live again/);
    assert.match(EXPORT_OUTDATED_TEXT.recorded_again, /^Out of date: /);
  });
});
