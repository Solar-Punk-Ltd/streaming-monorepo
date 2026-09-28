/**
 * What the catalogue node card offers and says: the deployments that are nothing but a Bee node, each batch's
 * reading in a line, and the manager's own refusal of a mutable batch, one whose kind the node did not report, and an
 * expired one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABR_NODE_POOL_GROUP_KIND,
  CATALOGUE_EXPIRED_REFUSAL,
  CATALOGUE_KIND_UNKNOWN_REFUSAL,
  CATALOGUE_MUTABLE_REFUSAL,
  cataloguePushLine,
} from '@streaming-infra-manager/common';

import { catalogueBatchViews, catalogueCandidates, catalogueReadingLine, pinnedBatchNote } from './catalogueNodeView';

const BATCH = 'ab'.repeat(32);

function stamp(over: Record<string, unknown> = {}) {
  return {
    batchID: BATCH,
    depth: 20,
    bucketDepth: 16,
    utilization: 4,
    batchTTL: 90 * 86_400,
    usable: true,
    exists: true,
    immutableFlag: true,
    ...over,
  };
}

describe('the deployments the card offers', () => {
  it('lists only Bee-only deployments, and says why a pool rung cannot be the catalogue node', () => {
    const candidates = catalogueCandidates(
      [
        { name: 'stage', kind: 'streamer', status: 'RUNNING', group_id: null },
        { name: 'rung-360p', kind: 'custom', components: ['bee-uploader'], status: 'RUNNING', group_id: 3 },
        { name: 'catalogue', kind: 'custom', components: ['bee-uploader'], status: 'RUNNING', group_id: null },
      ],
      [{ id: 3, kind: ABR_NODE_POOL_GROUP_KIND }],
    );
    assert.deepEqual(
      candidates.map((candidate) => candidate.name),
      ['catalogue', 'rung-360p'],
    );
    assert.equal(candidates[0]!.problem, null);
    assert.match(candidates[1]!.problem ?? '', /rung of an ABR node pool/);
  });
});

describe('the batches the card offers', () => {
  it('reads each in a line, and refuses a mutable, an unreported and an expired one with the manager’s sentence', () => {
    const unreported: Record<string, unknown> = stamp({ batchID: 'cc'.repeat(32) });
    delete unreported.immutableFlag;
    const views = catalogueBatchViews([
      stamp(),
      stamp({ batchID: `0x${'DD'.repeat(32)}`, immutableFlag: false }),
      unreported as ReturnType<typeof stamp>,
      stamp({ batchID: 'ee'.repeat(32), batchTTL: 0, usable: false }),
    ]);
    assert.equal(views[0]!.problem, null);
    assert.match(views[0]!.label, /depth 20 · 90d 0h · 25% full · immutable$/);
    assert.equal(views[1]!.batchId, 'dd'.repeat(32), 'kept as the manager keeps it');
    assert.equal(views[1]!.problem, CATALOGUE_MUTABLE_REFUSAL);
    assert.match(views[1]!.label, /mutable$/);
    assert.equal(views[2]!.problem, CATALOGUE_KIND_UNKNOWN_REFUSAL);
    assert.match(views[2]!.label, /kind not reported$/);
    assert.equal(views[3]!.problem, CATALOGUE_EXPIRED_REFUSAL);
  });
});

describe('what the card says of the pinned batch', () => {
  it('gives its state, depth, life and fill, and says when it has not been read', () => {
    assert.equal(catalogueReadingLine(null), 'The batch has not been read yet.');
    assert.equal(
      catalogueReadingLine({
        batchId: BATCH,
        state: 'active',
        ttlSeconds: 2 * 86_400 + 3_600,
        fillRatio: 0.5,
        immutable: true,
        depth: 22,
        readAt: '2026-09-28T10:00:00.000Z',
      }),
      'active · depth 22 · 2d 1h left · 50% full · immutable',
    );
    assert.equal(
      catalogueReadingLine({
        batchId: BATCH,
        state: 'unknown',
        ttlSeconds: null,
        fillRatio: null,
        immutable: null,
        depth: null,
        readAt: '2026-09-28T10:00:00.000Z',
      }),
      'unknown · depth unknown · life left unknown · fill unknown · kind not reported',
    );
  });

  it('says how the last push went and how long ago', () => {
    const at = Date.parse('2026-09-28T10:00:00.000Z');
    assert.equal(cataloguePushLine(null, at), 'Web2 admin: not sent yet');
    assert.equal(
      cataloguePushLine({ kind: 'store', outcome: 'stored', at: new Date(at).toISOString() }, at + 12_000),
      'Web2 admin: stored 12 s ago',
    );
    assert.equal(
      cataloguePushLine({ kind: 'clear', outcome: 'unreachable', at: new Date(at).toISOString() }, at),
      'Web2 admin: admin unreachable 0 s ago',
    );
  });

  it('tells the node’s page that Buy and Use leave the catalogue on the pinned batch, and Top up keeps it alive', () => {
    const note = pinnedBatchNote(BATCH);
    assert.match(note, /catalogue node/);
    assert.match(note, /leaves the catalogue on the pinned one/);
    assert.match(note, /Moving the catalogue to another batch is its own action\./);
    assert.match(note, /Top up the pinned batch here/);
  });
});
