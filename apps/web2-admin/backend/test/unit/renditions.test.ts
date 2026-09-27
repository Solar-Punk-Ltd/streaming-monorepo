/**
 * The ABR ladder's arithmetic. Unit test — the pure functions only.
 *
 * The merge is the one with a bug behind it. swarm-hls-stream's scenario H: a
 * rung dies and comes back, announces itself before it has finalized again,
 * and a wholesale replace throws away the index it already reported — which
 * un-finishes a ladder that was finished and leaves the viewer a master
 * playlist it cannot seek. Every case below is a shape that report can arrive
 * in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Rendition } from '@streaming-monorepo/web2-admin-common';

import { mergeRendition, isLadderFinished, ladderDuration, toRendition } from '../../src/domain/renditions.js';
import type { StreamRenditionRow } from '../../src/types/index.js';

const TOPIC_720 = 'bbbbbbbb-0000-4000-8000-000000000720';
const TOPIC_360 = 'bbbbbbbb-0000-4000-8000-000000000360';

function rendition(over: Partial<Rendition> = {}): Rendition {
  return {
    name: '720p',
    width: 1280,
    height: 720,
    topic: TOPIC_720,
    bandwidth: 2_800_000,
    avgBandwidth: 2_400_000,
    ...over,
  };
}

function renditionRow(over: Partial<StreamRenditionRow> = {}): StreamRenditionRow {
  return {
    stream_id: '00000000-0000-4000-8000-000000000001',
    name: '720p',
    width: 1280,
    height: 720,
    topic: TOPIC_720,
    bandwidth: 2_800_000,
    avg_bandwidth: 2_400_000,
    manifest_index: null,
    duration_seconds: null,
    updated_at: new Date('2026-09-11T11:00:00.000Z'),
    ...over,
  };
}

describe('toRendition', () => {
  it('renames the two nullable columns and leaves them off when null', () => {
    const value = toRendition(renditionRow());

    assert.deepEqual(value, {
      name: '720p',
      width: 1280,
      height: 720,
      topic: TOPIC_720,
      bandwidth: 2_800_000,
      avgBandwidth: 2_400_000,
    });
    assert.ok(!('index' in value), 'an unfinished rung has no index');
    assert.ok(!('duration' in value), 'and no duration');
  });

  it('carries index 0, which is a feed index like any other', () => {
    const value = toRendition(renditionRow({ manifest_index: 0, duration_seconds: 0 }));
    assert.equal(value.index, 0);
    assert.equal(value.duration, 0);
  });
});

describe('mergeRendition', () => {
  it('takes the incoming report when nothing is stored for that rung', () => {
    const incoming = rendition();
    assert.deepEqual(mergeRendition(null, incoming), incoming);
  });

  it('replaces an unfinished rung wholesale', () => {
    // A rung that restarted on a different topic, with a re-tuned encoder:
    // nothing stored is worth keeping, because nothing has been published
    // under it that a viewer can still play.
    const stored = rendition({ topic: TOPIC_360, bandwidth: 1_000_000 });
    const incoming = rendition({ bandwidth: 3_000_000 });

    assert.deepEqual(mergeRendition(stored, incoming), incoming);
  });

  it('keeps what a finished rung finished with, on the same topic', () => {
    // Scenario H. The recovered rung resumes writing the feed it was already
    // writing, so the recording it closed there is still the one on the
    // catalogue: `index` and `duration` stay, the encoder's numbers do not.
    const stored = rendition({ index: 42, duration: 61.5 });
    const incoming = rendition({
      width: 1920,
      height: 1080,
      bandwidth: 5_000_000,
      avgBandwidth: 4_000_000,
    });

    assert.deepEqual(mergeRendition(stored, incoming), {
      name: '720p',
      width: 1920,
      height: 1080,
      topic: TOPIC_720,
      bandwidth: 5_000_000,
      avgBandwidth: 4_000_000,
      index: 42,
      duration: 61.5,
    });
  });

  it('matches the topic case-insensitively, as a UUID', () => {
    const stored = rendition({ index: 42, duration: 61.5 });
    const incoming = rendition({ topic: TOPIC_720.toUpperCase() });

    assert.equal(mergeRendition(stored, incoming).index, 42);
  });

  it('replaces a finished rung that reports on a fresh topic', () => {
    // Not a recovery: a rung that starts a new session mints a new feed. The
    // encoder reconnected after the broadcast finished, so this rung is live
    // again — keeping the old record would leave the master advertising the
    // recording's feed while the one now being written went unadvertised.
    const stored = rendition({ index: 42, duration: 61.5 });
    const incoming = rendition({ topic: TOPIC_360 });

    const merged = mergeRendition(stored, incoming);
    assert.deepEqual(merged, incoming);
    assert.equal(merged.topic, TOPIC_360, 'the feed now being written');
    assert.ok(!('index' in merged), 'and it is delivering, not finished');
    assert.ok(!('duration' in merged));
  });

  it('lets a finished report replace a finished rung', () => {
    // A second recording of the same rung: the incoming index is the newer
    // one, and keeping the stored one would point the viewer at the old take.
    const stored = rendition({ index: 42, duration: 61.5 });
    const incoming = rendition({ topic: TOPIC_360, index: 7, duration: 12 });

    assert.deepEqual(mergeRendition(stored, incoming), incoming);
  });
});

describe('isLadderFinished', () => {
  it('is false for a ladder nobody has reported', () => {
    assert.equal(isLadderFinished([]), false);
  });

  it('is false while any rung is still delivering', () => {
    assert.equal(isLadderFinished([rendition({ name: '360p', index: 3, duration: 60 }), rendition()]), false);
  });

  it('is true once every rung has an index', () => {
    assert.equal(
      isLadderFinished([rendition({ name: '360p', index: 3, duration: 60 }), rendition({ index: 0, duration: 61 })]),
      true,
    );
  });
});

describe('ladderDuration', () => {
  it('is null while the ladder is unfinished', () => {
    assert.equal(ladderDuration([]), null);
    assert.equal(ladderDuration([rendition()]), null);
  });

  it('is the longest rung, not the first or the last', () => {
    // The rungs are cut from one broadcast and differ by fractions of a
    // segment; a seek bar built on the shortest stops before the end.
    assert.equal(
      ladderDuration([rendition({ name: '360p', index: 3, duration: 61.2 }), rendition({ index: 4, duration: 60.8 })]),
      61.2,
    );
  });
});
