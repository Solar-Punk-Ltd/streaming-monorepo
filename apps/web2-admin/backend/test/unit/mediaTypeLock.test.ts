/**
 * The media-type lock. Unit test — the rule only, no database.
 *
 * `<mediaType>/<topic>` is the ingest stream id, so flipping the media type of
 * a published stream silently repoints the address the streamer already has in
 * OBS. A draft has handed that address to nobody yet, so it stays editable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

import { MediaTypeLockedError } from '../../src/domain/errors/index.js';
import { isMediaTypeLocked } from '../../src/domain/StreamService.js';

import { streamRow } from './support/fakes.js';

describe('isMediaTypeLocked', () => {
  it('lets a draft change its media type', () => {
    const draft = streamRow({ status: 'draft', media_type: 'video' });
    assert.equal(isMediaTypeLocked(draft, 'audio'), false);
  });

  it('locks a published stream against a change', () => {
    const published = streamRow({ status: 'published', media_type: 'video' });
    assert.equal(isMediaTypeLocked(published, 'audio'), true);
  });

  it('locks the states the uploader will report, too', () => {
    for (const status of ['published', 'live', 'vod'] as StreamStatus[]) {
      const stream = streamRow({ status, media_type: 'audio' });
      assert.equal(isMediaTypeLocked(stream, 'video'), true, status);
    }
  });

  it('is not triggered by an edit that keeps the media type', () => {
    // The common case: the console PUTs the whole StreamInput back on every
    // save, media type included, so an unchanged value must not be a conflict.
    for (const status of ['draft', 'published', 'live', 'vod'] as StreamStatus[]) {
      const stream = streamRow({ status, media_type: 'video' });
      assert.equal(isMediaTypeLocked(stream, 'video'), false, status);
    }
  });

  it('leaves `publishing` to the status transition, which reports stream_busy', () => {
    const publishing = streamRow({ status: 'publishing', media_type: 'video' });
    assert.equal(isMediaTypeLocked(publishing, 'audio'), false);
  });

  it('carries the message the console shows', () => {
    const error = new MediaTypeLockedError('an-id', 'video');
    assert.equal(
      error.message,
      'Unpublish the stream before changing its media type; it is part of the OBS stream id.',
    );
    assert.equal(error.currentMediaType, 'video');
  });
});
