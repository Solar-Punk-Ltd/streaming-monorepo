/**
 * The console's "Edited since it was published" notice. Unit test: a row in, a
 * boolean out, and the same boolean on the wire.
 *
 * What is pinned is what the notice is measured against. The console used to
 * compare `updatedAt` with `publishedAt`, and the uploader's own reports move
 * `updated_at` while a republish of a live or recorded stream leaves
 * `published_at` alone. So a stream nobody edited warned after its first
 * broadcast, and a real edit kept warning after the republish that put it on
 * the feed (both seen on the deployed admin, 2026-09-24). The notice now
 * compares the edit the row holds with the edit the catalogue entry was last
 * rebuilt from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toStream } from '../../src/api/presenters.js';
import { hasUnpublishedEdits } from '../../src/domain/unpublishedEdits.js';

import { streamRow } from './support/fakes.js';

const PUBLISHED_AT = new Date('2026-09-24T10:00:00.000Z');
const EDITED_AT = new Date('2026-09-24T10:05:00.000Z');

describe('hasUnpublishedEdits', () => {
  it('stays false for a stream nobody edited, however far the uploader moved it on', () => {
    const recording = streamRow({
      status: 'vod',
      published_at: PUBLISHED_AT,
      published_feed_index: 4,
      live_since: new Date('2026-09-24T10:01:00.000Z'),
      ended_at: new Date('2026-09-24T11:30:00.000Z'),
      manifest_index: 412,
      duration_seconds: 5340,
      // The live and vod reports moved this, and nothing else did.
      updated_at: new Date('2026-09-24T11:30:00.000Z'),
    });

    assert.equal(hasUnpublishedEdits(recording), false);
    assert.equal(toStream(recording).hasUnpublishedEdits, false);
  });

  it('is true once the console edits what the entry carries after it was rebuilt', () => {
    for (const status of ['published', 'live', 'vod'] as const) {
      const edited = streamRow({
        status,
        published_at: PUBLISHED_AT,
        content_edited_at: EDITED_AT,
        entry_content_edited_at: PUBLISHED_AT,
      });

      assert.equal(hasUnpublishedEdits(edited), true, status);
      assert.equal(toStream(edited).hasUnpublishedEdits, true, status);
    }
  });

  it('is true for an edit made after an entry that predates the tracking', () => {
    // A row published before migration 006 has no record of which edit its
    // entry carries, and an edit since then is certainly not on it.
    const edited = streamRow({
      status: 'published',
      published_at: PUBLISHED_AT,
      content_edited_at: EDITED_AT,
      entry_content_edited_at: null,
    });

    assert.equal(hasUnpublishedEdits(edited), true);
  });

  it('goes false once the entry is rebuilt from the edited row', () => {
    // Two Date objects for one instant: the value is read into the service and
    // written back, so identity is never what makes them equal.
    const caughtUp = streamRow({
      status: 'live',
      published_at: PUBLISHED_AT,
      content_edited_at: new Date(EDITED_AT.getTime()),
      entry_content_edited_at: new Date(EDITED_AT.getTime()),
      updated_at: new Date('2026-09-24T12:00:00.000Z'),
    });

    assert.equal(hasUnpublishedEdits(caughtUp), false);
  });

  it('is false for a stream that is not on the catalogue, edits or not', () => {
    for (const status of ['draft', 'publishing'] as const) {
      const offFeed = streamRow({
        status,
        content_edited_at: EDITED_AT,
        entry_content_edited_at: null,
      });

      assert.equal(hasUnpublishedEdits(offFeed), false, status);
    }
  });
});
