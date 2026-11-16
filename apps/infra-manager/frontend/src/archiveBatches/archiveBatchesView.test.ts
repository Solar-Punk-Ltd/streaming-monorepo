/**
 * What the archive batches card says and offers: each batch's title, how it became one and whether the web2 admin
 * copies onto it, Remove only for a batch whose last reading or gone deployment lets it go, and the adopt picker's
 * line per candidate.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ARCHIVE_REMOVE_LIVE_REFUSAL,
  ARCHIVE_REMOVE_UNREAD_REFUSAL,
  type ArchiveBatchCandidate,
  type ArchiveBatchRow,
  type CatalogueReading,
} from '@streaming-infra-manager/common';

import {
  archiveBatchOrigin,
  archiveBatchRemoveProblem,
  archiveBatchTitle,
  archiveBatchWritableLine,
  archiveCandidateLabel,
  archiveRemoveConfirmText,
} from './archiveBatchesView';

const BATCH = 'ab'.repeat(32);

function reading(state: CatalogueReading['state']): CatalogueReading {
  return {
    batchId: BATCH,
    state,
    ttlSeconds: 86_400,
    fillRatio: 0.1,
    immutable: true,
    depth: 22,
    readAt: '2026-11-13T09:00:00.000Z',
  };
}

function row(over: Partial<ArchiveBatchRow> = {}): ArchiveBatchRow {
  return {
    batchId: BATCH,
    profileName: 'catalogue',
    depth: 22,
    label: 'Spring archive',
    source: 'adopted',
    purchaseRequestId: null,
    designatedAt: '2026-11-13T09:00:00.000Z',
    designatedBy: 'operator',
    reading: reading('active'),
    writable: true,
    ...over,
  };
}

describe('an archive batch on the card', () => {
  it('is titled by its label, or by its id without one, with its deployment', () => {
    assert.equal(archiveBatchTitle(row()), 'Spring archive on catalogue');
    assert.match(archiveBatchTitle(row({ label: null })), /^Batch abababab.* on catalogue$/);
  });

  it('says whether it was bought or adopted, and by whom', () => {
    assert.match(archiveBatchOrigin(row()), /^Adopted .* by operator$/);
    assert.match(
      archiveBatchOrigin(row({ source: 'purchase', designatedBy: null, purchaseRequestId: 'x' })),
      /^Bought through the web2 admin /,
    );
  });

  it('says why the admin copies nothing onto it', () => {
    assert.equal(archiveBatchWritableLine(row(), 'catalogue'), 'The web2 admin copies recordings onto it.');
    assert.match(archiveBatchWritableLine(row({ writable: false }), null), /no catalogue node is designated/);
    assert.match(
      archiveBatchWritableLine(row({ writable: false, profileName: 'catalogue-old' }), 'catalogue'),
      /catalogue-old is the catalogue node no longer.*topped up/,
    );
    assert.match(archiveBatchWritableLine(row({ writable: false, reading: null }), 'catalogue'), /Not read yet/);
    assert.match(
      archiveBatchWritableLine(row({ writable: false, reading: reading('pending') }), 'catalogue'),
      /Not usable yet/,
    );
    assert.match(
      archiveBatchWritableLine(row({ writable: false, reading: reading('unknown') }), 'catalogue'),
      /did not answer/,
    );
  });

  it('offers Remove for an expired or dropped batch, and for one whose deployment is gone', () => {
    for (const state of ['expired', 'gone'] as const) {
      assert.equal(archiveBatchRemoveProblem(row({ reading: reading(state) }), false), null, state);
    }
    for (const state of ['active', 'unknown'] as const) {
      assert.equal(archiveBatchRemoveProblem(row({ reading: reading(state) }), true), null, state);
    }
  });

  it('says why it does not offer Remove, in the manager’s words', () => {
    for (const state of ['active', 'full', 'pending'] as const) {
      assert.equal(archiveBatchRemoveProblem(row({ reading: reading(state) }), false), ARCHIVE_REMOVE_LIVE_REFUSAL);
    }
    assert.equal(archiveBatchRemoveProblem(row({ reading: reading('unknown') }), false), ARCHIVE_REMOVE_UNREAD_REFUSAL);
    assert.equal(archiveBatchRemoveProblem(row({ reading: null }), false), ARCHIVE_REMOVE_UNREAD_REFUSAL);
  });

  it('confirms a removal naming the batch and its node, and for a deployment that is gone says the recordings stay', () => {
    assert.match(
      archiveRemoveConfirmText(row(), false),
      /^Take batch abababab.* on catalogue off the archive batches\?/,
    );
    assert.match(
      archiveRemoveConfirmText(row(), true),
      /Its deployment, catalogue, is gone.*recordings stay on Swarm until the batch expires/,
    );
  });
});

describe('a candidate in the adopt picker', () => {
  it('reads its node label, id, depth, life and kind in one line', () => {
    const candidate: ArchiveBatchCandidate = {
      batchId: BATCH,
      nodeLabel: 'spare',
      depth: 22,
      immutable: true,
      ttlSeconds: 0,
      problem: null,
    };
    assert.match(archiveCandidateLabel(candidate), /^spare · abababab.* · depth 22 · no life left · immutable$/);
    assert.match(
      archiveCandidateLabel({ ...candidate, nodeLabel: null, depth: null, immutable: null, ttlSeconds: null }),
      /^abababab.* · depth unknown · life left unknown · kind unknown$/,
    );
  });
});
