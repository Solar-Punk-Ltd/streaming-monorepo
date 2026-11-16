import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARCHIVE_BATCH_LABEL_MAX_LENGTH } from '@streaming-monorepo/contracts';

import {
  ARCHIVE_ALREADY_REFUSAL,
  ARCHIVE_BATCH_SOURCES,
  ARCHIVE_EXPIRED_REFUSAL,
  ARCHIVE_KIND_UNKNOWN_REFUSAL,
  ARCHIVE_LABEL_MAX_LENGTH,
  ARCHIVE_MUTABLE_REFUSAL,
  ARCHIVE_NOT_HELD_REFUSAL,
  ARCHIVE_PURCHASE_NODE_LABEL_HEX,
  ARCHIVE_PURCHASE_NODE_LABEL_PREFIX,
  ARCHIVE_PURCHASE_SETTLE_MS,
  ARCHIVE_REMOVE_LIVE_REFUSAL,
  ARCHIVE_REMOVE_UNREAD_REFUSAL,
  archiveBatchProblem,
  archiveIsCatalogueBatchRefusal,
  archiveLabelProblem,
  archivePurchaseNodeLabel,
  archiveRemoveProblem,
  catalogueIsArchiveBatchRefusal,
  isPurchasedArchiveBatch,
} from './archiveBatches.js';

const BATCH = 'ab'.repeat(32);
const CATALOGUE_BATCH = 'c1'.repeat(32);
const MOVED_FROM_BATCH = 'c2'.repeat(32);
const ARCHIVED_BATCH = 'd3'.repeat(32);
const REQUEST_ID = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';

const immutableStamp = () => ({ batchTTL: 2_592_000, usable: true, exists: true, immutableFlag: true });

const context = (batchId: string = BATCH) => ({
  batchId,
  catalogueBatchIds: [CATALOGUE_BATCH, MOVED_FROM_BATCH],
  archiveBatchIds: [ARCHIVED_BATCH],
});

describe('the closed lists and the bounds', () => {
  it('names the two ways a batch becomes an archive batch', () => {
    assert.deepEqual(ARCHIVE_BATCH_SOURCES, ['purchase', 'adopted']);
  });

  it('keeps the label as long as the contract lets one be', () => {
    assert.equal(ARCHIVE_LABEL_MAX_LENGTH, ARCHIVE_BATCH_LABEL_MAX_LENGTH);
  });

  it('gives a lost purchase thirty minutes', () => {
    assert.equal(ARCHIVE_PURCHASE_SETTLE_MS, 1_800_000);
  });
});

describe('whether a batch the catalogue node holds can be an archive batch', () => {
  it('takes an immutable batch with life left, whatever its depth', () => {
    assert.equal(archiveBatchProblem(immutableStamp(), context()), null);
  });

  it('refuses a mutable one, and one whose kind the node does not say', () => {
    assert.equal(
      archiveBatchProblem({ ...immutableStamp(), immutableFlag: false }, context()),
      ARCHIVE_MUTABLE_REFUSAL,
    );
    assert.equal(
      archiveBatchProblem({ ...immutableStamp(), immutableFlag: null }, context()),
      ARCHIVE_KIND_UNKNOWN_REFUSAL,
    );
    const { immutableFlag: _flag, ...unsaid } = immutableStamp();
    assert.equal(archiveBatchProblem(unsaid, context()), ARCHIVE_KIND_UNKNOWN_REFUSAL);
  });

  it('refuses an expired one and one the node does not hold', () => {
    assert.equal(archiveBatchProblem({ ...immutableStamp(), batchTTL: 0 }, context()), ARCHIVE_EXPIRED_REFUSAL);
    assert.equal(archiveBatchProblem({ ...immutableStamp(), exists: false }, context()), ARCHIVE_NOT_HELD_REFUSAL);
  });

  it("refuses the catalogue's own batch, the pinned one and the one a move left, naming it", () => {
    for (const batchId of [CATALOGUE_BATCH, MOVED_FROM_BATCH]) {
      const problem = archiveBatchProblem(immutableStamp(), context(batchId));
      assert.equal(problem, archiveIsCatalogueBatchRefusal(batchId));
      assert.match(problem!, /holds the catalogue/);
    }
  });

  it('refuses one that is an archive batch already, before anything else is said about it', () => {
    const expired = { ...immutableStamp(), batchTTL: 0 };
    assert.equal(archiveBatchProblem(expired, context(ARCHIVED_BATCH)), ARCHIVE_ALREADY_REFUSAL);
  });
});

describe('a label', () => {
  it('passes when absent and when it has 1 to the most characters once trimmed', () => {
    assert.equal(archiveLabelProblem(null), null);
    assert.equal(archiveLabelProblem('Autumn event'), null);
    assert.equal(archiveLabelProblem(`  ${'x'.repeat(ARCHIVE_LABEL_MAX_LENGTH)}  `), null);
  });

  it('is refused when empty or too long', () => {
    assert.match(archiveLabelProblem('   ')!, /at least one character/);
    assert.match(archiveLabelProblem('x'.repeat(ARCHIVE_LABEL_MAX_LENGTH + 1))!, /at most 64/);
  });
});

describe('taking an archive batch off the list', () => {
  it('is for a batch the node reports as expired, or as gone from it', () => {
    assert.equal(archiveRemoveProblem('expired'), null);
    assert.equal(archiveRemoveProblem('gone'), null);
  });

  it('is refused for a batch with life left, since the admin would show its recordings as expired', () => {
    for (const state of ['active', 'pending', 'full', 'none'] as const) {
      assert.equal(archiveRemoveProblem(state), ARCHIVE_REMOVE_LIVE_REFUSAL, state);
    }
    assert.match(ARCHIVE_REMOVE_LIVE_REFUSAL, /has not expired/);
  });

  it('is refused while the node did not say', () => {
    assert.equal(archiveRemoveProblem('unknown'), ARCHIVE_REMOVE_UNREAD_REFUSAL);
    assert.equal(archiveRemoveProblem(null), ARCHIVE_REMOVE_UNREAD_REFUSAL);
    assert.equal(archiveRemoveProblem('unknown', { deploymentGone: false }), ARCHIVE_REMOVE_UNREAD_REFUSAL);
  });

  it('is for a batch whose deployment is gone, whatever its last reading said', () => {
    for (const state of [null, 'unknown', 'active', 'full', 'expired'] as const) {
      assert.equal(archiveRemoveProblem(state, { deploymentGone: true }), null, String(state));
    }
  });
});

describe("designating the catalogue's own batch", () => {
  it('refuses an archive batch, naming it', () => {
    const sentence = catalogueIsArchiveBatchRefusal(ARCHIVED_BATCH);
    assert.match(sentence, /is an archive batch/);
    assert.match(sentence, new RegExp(ARCHIVED_BATCH.slice(0, 6)));
  });

  it('says the same of an adopt the other way round: already an archive batch', () => {
    assert.match(ARCHIVE_ALREADY_REFUSAL, /already an archive batch/);
  });
});

describe("the label a purchase's batch carries on its node", () => {
  const LABEL = `${ARCHIVE_PURCHASE_NODE_LABEL_PREFIX}7d1e2f3a4b5c`;

  it('is the prefix and the first twelve hex digits of the request id, in lower case', () => {
    assert.equal(ARCHIVE_PURCHASE_NODE_LABEL_HEX, 12);
    assert.equal(archivePurchaseNodeLabel(REQUEST_ID.toUpperCase()), LABEL);
    assert.match(LABEL, /^archive-[0-9a-f]{12}$/);
  });

  it('is made from a UUID alone', () => {
    for (const bad of ['', 'self', `${REQUEST_ID}-x`, '../x']) {
      assert.throws(() => archivePurchaseNodeLabel(bad), /UUID/);
    }
  });

  const settle = (batchId: string = BATCH) => ({
    batchId,
    nodeLabel: LABEL,
    depth: 22,
    catalogueBatchIds: [CATALOGUE_BATCH, MOVED_FROM_BATCH],
    archiveBatchIds: [ARCHIVED_BATCH],
  });
  const bought = () => ({ label: LABEL, depth: 22, immutableFlag: true });

  it('finds the batch of a purchase with a lost answer: its exact label, its depth, immutable', () => {
    assert.equal(isPurchasedArchiveBatch(bought(), settle()), true);
  });

  it('passes over a batch with another label, another depth or no said immutability', () => {
    assert.equal(isPurchasedArchiveBatch({ ...bought(), label: `${LABEL}0` }, settle()), false);
    assert.equal(isPurchasedArchiveBatch({ ...bought(), label: 'archive' }, settle()), false);
    assert.equal(isPurchasedArchiveBatch({ ...bought(), label: null }, settle()), false);
    assert.equal(isPurchasedArchiveBatch({ ...bought(), depth: 23 }, settle()), false);
    assert.equal(isPurchasedArchiveBatch({ ...bought(), immutableFlag: false }, settle()), false);
    assert.equal(isPurchasedArchiveBatch({ ...bought(), immutableFlag: null }, settle()), false);
  });

  it("never takes the catalogue's batch or one that is an archive batch already, whatever its label", () => {
    for (const batchId of [CATALOGUE_BATCH, MOVED_FROM_BATCH, ARCHIVED_BATCH]) {
      assert.equal(isPurchasedArchiveBatch(bought(), settle(batchId)), false, batchId);
    }
  });
});
