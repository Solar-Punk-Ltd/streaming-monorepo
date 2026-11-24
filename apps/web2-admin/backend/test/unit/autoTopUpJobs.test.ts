/**
 * How the tick of stamp auto top-up reads a marked stamp against the manager's inventory: the node that pays for it,
 * its batch or archive stamp, and whether the node's view of the chain is current. Unit test, `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FundingArchiveBatch } from '@streaming-monorepo/contracts';

import { markedStampsOf } from '../../src/domain/funding/autoTopUpJobs.js';
import type { AutoTopUpMarkRow } from '../../src/domain/funding/StampAutoTopUpStore.js';

import {
  BATCH_CATALOGUE,
  BATCH_RUNG,
  BATCH_STAGE,
  fundingBatch,
  NODE_A,
  NODE_CATALOGUE,
  NODE_RUNG,
  stampInventory,
} from './support/fundingFakes.js';

const ARCHIVE = `0x${'a4'.repeat(32)}`;
const FORMER_CATALOGUE = 'catalogue-old:uploader';

function mark(nodeId: string, batchId: string): AutoTopUpMarkRow {
  return {
    batchId,
    nodeId,
    nodeLabel: nodeId,
    markedAt: new Date('2026-11-24T10:00:00.000Z'),
    markedBy: 'test-operator',
    alert: null,
    unreadSince: null,
  };
}

function archiveStamp(nodeId: string): FundingArchiveBatch {
  return {
    ...fundingBatch({ batchId: ARCHIVE, depth: 22, immutable: true, ttlSeconds: 20 * 86_400 }),
    nodeId,
    nodeLabel: nodeId,
    label: 'archive one',
    writable: nodeId === NODE_CATALOGUE,
  };
}

describe('markedStampsOf', () => {
  it('finds each batch with the node that pays for it, an archive stamp with its holder', () => {
    const inventory = stampInventory();
    inventory.archiveBatches = [archiveStamp(NODE_CATALOGUE)];
    const [ownNode] = inventory.stages[0]!.nodes;
    inventory.stages[0]!.nodes[0] = { ...ownNode!, chainLagBlocks: 3 };

    const [stage, catalogue, archive, rung] = markedStampsOf(inventory, [
      mark(NODE_A, BATCH_STAGE),
      mark(NODE_CATALOGUE, BATCH_CATALOGUE),
      mark(NODE_CATALOGUE, ARCHIVE),
      mark(NODE_RUNG, BATCH_RUNG.toUpperCase().replace('0X', '0x')),
    ]);

    assert.equal(stage!.node?.nodeId, NODE_A);
    assert.equal(stage!.batch?.batchId, BATCH_STAGE);
    assert.equal(stage!.archive, false);
    assert.equal(stage!.chainCurrent, true, 'three blocks behind is current');
    assert.equal(catalogue!.node?.nodeId, NODE_CATALOGUE);
    assert.equal(catalogue!.batch?.batchId, BATCH_CATALOGUE);
    assert.equal(catalogue!.chainCurrent, null, 'a manager that does not say');
    assert.equal(archive!.node?.nodeId, NODE_CATALOGUE, 'the holder pays for its archive stamp');
    assert.equal(archive!.batch?.batchId, ARCHIVE);
    assert.equal(archive!.archive, true);
    assert.equal(rung!.batch?.batchId, BATCH_RUNG, 'batch ids are compared in lower case');
  });

  it('says when the node holds the batch no more, when no funded node holds it, and when the chain view is behind', () => {
    const inventory = stampInventory();
    inventory.archiveBatches = [archiveStamp(FORMER_CATALOGUE)];
    const [ownNode] = inventory.stages[0]!.nodes;
    inventory.stages[0]!.nodes[0] = { ...ownNode!, batch: null, chainLagBlocks: 121 };

    const [gone, former, missing] = markedStampsOf(inventory, [
      mark(NODE_A, BATCH_STAGE),
      mark(FORMER_CATALOGUE, ARCHIVE),
      mark('stage-9:uploader', BATCH_RUNG),
    ]);

    assert.equal(gone!.node?.nodeId, NODE_A);
    assert.equal(gone!.batch, null, 'the node holds the batch no more');
    assert.equal(gone!.chainCurrent, false, 'past 120 blocks behind');
    assert.equal(former!.node, null, 'a catalogue node no longer is funded outside the admin');
    assert.equal(former!.batch?.batchId, ARCHIVE);
    assert.equal(former!.archive, true);
    assert.equal(former!.chainCurrent, null);
    assert.equal(missing!.node, null);
    assert.equal(missing!.batch, null);
  });
});
