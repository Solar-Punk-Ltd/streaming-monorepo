import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FUNDING_BATCH_PURCHASE_PURPOSES, FUNDING_PURCHASE_APPLY_STATES } from '@streaming-monorepo/contracts';

import { archivePurchaseNodeLabel } from './archiveBatches.js';
import {
  PURCHASE_NODE_LABEL_PATTERN,
  purchaseNodeLabel,
  purchaseReplaceProblem,
  purchaseStepOnceSet,
} from './batchPurchases.js';
import type { StampState } from './stampHealth.js';

const REQUEST_ID = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const BATCH_ID = `0x${'d4'.repeat(32)}`;

describe("a purchase's label on its node", () => {
  it('is the purpose and the first twelve hex digits of the request id, in lower case', () => {
    assert.equal(purchaseNodeLabel('rung', REQUEST_ID), 'rung-7d1e2f3a4b5c');
    assert.equal(purchaseNodeLabel('catalogue', REQUEST_ID.toUpperCase()), 'catalogue-7d1e2f3a4b5c');
    for (const purpose of FUNDING_BATCH_PURCHASE_PURPOSES) {
      assert.match(purchaseNodeLabel(purpose, REQUEST_ID), PURCHASE_NODE_LABEL_PATTERN);
    }
  });

  it('is for an archive stamp the label an archive purchase has always carried', () => {
    assert.equal(purchaseNodeLabel('archive', REQUEST_ID), archivePurchaseNodeLabel(REQUEST_ID));
  });

  it('is refused for anything but a UUID', () => {
    for (const bad of ['', 'not-a-uuid', `${REQUEST_ID}x`]) {
      assert.throws(() => purchaseNodeLabel('rung', bad), /UUID/);
    }
  });
});

describe('what a purchase may replace', () => {
  const states: StampState[] = ['none', 'unknown', 'active', 'pending', 'full', 'expired', 'gone'];

  it('is a batch that no longer pays: none, an expired one, one the node holds no more', () => {
    for (const purpose of ['rung', 'catalogue'] as const) {
      const taken = states.filter((state) => purchaseReplaceProblem(purpose, state) === null);
      assert.deepEqual(taken, ['none', 'expired', 'gone'], purpose);
    }
  });

  it('sends a batch that still works to a top-up or a dilution, and waits for a node that did not answer', () => {
    assert.match(purchaseReplaceProblem('rung', 'active') ?? '', /Top it up/);
    assert.match(purchaseReplaceProblem('rung', 'full') ?? '', /Dilute it/);
    assert.match(purchaseReplaceProblem('catalogue', 'unknown') ?? '', /^The catalogue batch could not be read/);
    assert.match(purchaseReplaceProblem('rung', 'pending') ?? '', /not usable yet/);
  });

  it('refuses nothing for an archive stamp, which replaces none', () => {
    for (const state of states) assert.equal(purchaseReplaceProblem('archive', state), null, state);
  });
});

describe("a purchase's step once its batch is set", () => {
  const stage = (apply: (typeof FUNDING_PURCHASE_APPLY_STATES)[number]) => ({ apply });

  it('is done for a rung when every following stage is settled, and at once when none follows', () => {
    assert.equal(purchaseStepOnceSet('rung', [], null), 'done');
    assert.equal(
      purchaseStepOnceSet('rung', [stage('applied'), stage('not_following'), stage('stopped')], null),
      'done',
    );
    for (const apply of [
      'pending',
      'waiting_live',
      'waiting_unknown',
      'waiting_settings',
      'applying',
      'failed',
    ] as const) {
      assert.equal(purchaseStepOnceSet('rung', [stage('applied'), stage(apply)], null), 'set', apply);
    }
  });

  it('is done for the catalogue once the batch it moved from is released, or when it moved from none', () => {
    assert.equal(purchaseStepOnceSet('catalogue', [], { previousBatchId: BATCH_ID, released: false }), 'set');
    assert.equal(purchaseStepOnceSet('catalogue', [], { previousBatchId: BATCH_ID, released: true }), 'done');
    assert.equal(purchaseStepOnceSet('catalogue', [], { previousBatchId: null, released: false }), 'done');
  });

  it('is done for an archive stamp', () => {
    assert.equal(purchaseStepOnceSet('archive', [], null), 'done');
  });
});
