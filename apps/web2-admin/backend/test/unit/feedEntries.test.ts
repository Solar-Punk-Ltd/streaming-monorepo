/**
 * What one stream looks like on the catalogue feed. Unit test — the builder
 * only.
 *
 * This is the boundary between the admin layer's vocabulary (five statuses,
 * including two of its own) and the viewer's (three states). Getting it wrong
 * is invisible here and obvious in a player: a recording advertised as
 * scheduled never opens, and a live entry carrying a stale manifest index
 * points at the wrong feed update.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

import { buildFeedEntry, feedEntryState } from '../../src/domain/feedEntries.js';

import { streamRow, TEST_OWNER } from './support/fakes.js';

describe('feedEntryState', () => {
  it('maps every admin status onto one of the viewer\'s three states', () => {
    const expected: Record<StreamStatus, string> = {
      draft: 'scheduled',
      publishing: 'scheduled',
      published: 'scheduled',
      live: 'live',
      vod: 'vod',
    };
    for (const [status, state] of Object.entries(expected)) {
      assert.equal(feedEntryState(status as StreamStatus), state, status);
    }
  });
});

describe('buildFeedEntry', () => {
  it('announces a published stream as scheduled, with no index or duration', () => {
    // `publishing` is what the row says while the publish that writes this
    // entry holds it, and that is still an announcement.
    const entry = buildFeedEntry(
      streamRow({ status: 'publishing' }),
      null,
      1_700_000_000_000,
    );

    assert.equal(entry.state, 'scheduled');
    assert.equal(entry.owner, TEST_OWNER);
    assert.equal(entry.mediatype, 'video');
    assert.equal(entry.thumbnail, '');
    assert.equal(entry.scheduledStartTime, '2026-10-01T09:00:00.000Z');
    assert.equal(entry.timestamp, 1_700_000_000_000);
    assert.ok(!('index' in entry), 'no index on a scheduled entry');
    assert.ok(!('duration' in entry), 'no duration on a scheduled entry');
  });

  it('says live, and still carries nothing to play a recording with', () => {
    const entry = buildFeedEntry(
      streamRow({
        status: 'live',
        live_since: new Date('2026-10-01T09:01:00.000Z'),
      }),
      'a'.repeat(64),
      1_700_000_000_000,
    );

    assert.equal(entry.state, 'live');
    assert.equal(entry.thumbnail, 'a'.repeat(64));
    assert.ok(!('index' in entry));
    assert.ok(!('duration' in entry));
  });

  it('says vod, with the manifest index and duration the uploader reported', () => {
    const entry = buildFeedEntry(
      streamRow({
        status: 'vod',
        manifest_index: 412,
        duration_seconds: 3725.5,
        ended_at: new Date('2026-10-01T10:02:05.000Z'),
      }),
      null,
      1_700_000_000_000,
    );

    assert.equal(entry.state, 'vod');
    assert.equal(entry.index, 412);
    assert.equal(entry.duration, 3725.5);
  });

  it('keeps index and duration off a vod entry that has neither reported', () => {
    // A `vod` row can only get here through a report that carried both, but an
    // entry rebuilt from an older row must not advertise index 0, which is a
    // real manifest index and would play the first segment of the stream.
    const entry = buildFeedEntry(streamRow({ status: 'vod' }), null, 1);

    assert.equal(entry.state, 'vod');
    assert.ok(!('index' in entry));
    assert.ok(!('duration' in entry));
  });

  it('accepts index 0, which is a feed index like any other', () => {
    const entry = buildFeedEntry(
      streamRow({ status: 'vod', manifest_index: 0, duration_seconds: 0 }),
      null,
      1,
    );

    assert.equal(entry.index, 0);
    assert.equal(entry.duration, 0);
  });

  it('writes no group and no renditions for a single-rendition stream', () => {
    // The entry a non-ABR stream gets must stay exactly what it was before the
    // ladder existed; an empty `renditions: []` is not the same thing and
    // would have swarm-hls-stream's reader look for a master playlist.
    const entry = buildFeedEntry(streamRow({ status: 'live' }), null, 1);

    assert.ok(!('group' in entry));
    assert.ok(!('renditions' in entry));
  });

  it('carries the ladder, with the declared topic as its group', () => {
    // In admin mode the master playlist is published on the stream's own
    // topic, so `group` is that topic and not a random id the uploader minted.
    const row = streamRow({ status: 'live' });
    const ladder = [
      {
        name: '360p',
        width: 640,
        height: 360,
        topic: 'bbbbbbbb-0000-4000-8000-000000000360',
        bandwidth: 800_000,
        avgBandwidth: 700_000,
      },
      {
        name: '720p',
        width: 1280,
        height: 720,
        topic: 'bbbbbbbb-0000-4000-8000-000000000720',
        bandwidth: 2_800_000,
        avgBandwidth: 2_400_000,
        index: 42,
        duration: 61.5,
      },
    ];

    const entry = buildFeedEntry(row, null, 1, ladder);

    assert.equal(entry.group, row.topic);
    assert.deepEqual(entry.renditions, ladder);
  });

  it('keeps the ladder on a vod entry, beside the master index', () => {
    // The entry's own `index` is the master playlist's, not a rung's: it is
    // what the viewer opens, and each rung carries its own index inside.
    const entry = buildFeedEntry(
      streamRow({ status: 'vod', manifest_index: 9, duration_seconds: 61.5 }),
      null,
      1,
      [
        {
          name: '720p',
          width: 1280,
          height: 720,
          topic: 'bbbbbbbb-0000-4000-8000-000000000720',
          bandwidth: 2_800_000,
          avgBandwidth: 2_400_000,
          index: 42,
          duration: 61.5,
        },
      ],
    );

    assert.equal(entry.index, 9, 'the master, not the rung');
    assert.equal(entry.renditions?.[0]?.index, 42);
  });
});
