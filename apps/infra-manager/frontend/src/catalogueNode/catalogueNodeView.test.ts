/**
 * What the catalogue node card offers and says: the deployments that are nothing but a Bee node, each batch's
 * reading in a line, and the manager's own refusal of a mutable batch, one whose kind the node did not report, and an
 * expired one. Once a batch is pinned, another is a move, a third one is refused while a move is pending, and a move
 * is confirmed and released with the sentences the card shows.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABR_NODE_POOL_GROUP_KIND,
  CATALOGUE_EXPIRED_REFUSAL,
  CATALOGUE_KIND_UNKNOWN_REFUSAL,
  CATALOGUE_MUTABLE_REFUSAL,
  cataloguePushLine,
  catalogueReleaseFirstRefusal,
} from '@streaming-infra-manager/common';

import {
  CATALOGUE_RELEASE_LABEL,
  CATALOGUE_API_EVERY_ADDRESS_WARNING,
  catalogueApiWarning,
  catalogueBatchViews,
  catalogueCandidates,
  catalogueMoveConfirmText,
  catalogueMoveLabel,
  catalogueMoveSteps,
  catalogueMovingLine,
  cataloguePinnedNote,
  catalogueReadingLine,
  catalogueReleaseConfirmText,
  pinnedBatchNote,
} from './catalogueNodeView';

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

describe('once a batch has been designated', () => {
  const NEXT = 'ff'.repeat(32);
  const THIRD = 'ee'.repeat(32);

  it('offers every other batch as a move, still refused for what a designation is refused for', () => {
    const views = catalogueBatchViews(
      [stamp(), stamp({ batchID: NEXT }), stamp({ batchID: THIRD, immutableFlag: false })],
      BATCH,
    );
    assert.deepEqual(
      views.map((view) => [view.problem, view.move]),
      [
        [null, false],
        [null, true],
        [CATALOGUE_MUTABLE_REFUSAL, true],
      ],
    );
    assert.equal(catalogueMoveLabel(NEXT), 'Move the catalogue to batch ffffffff…ffffff');
  });

  it('while a move is pending, offers the batch moved from as a move back and refuses a third one', () => {
    const views = catalogueBatchViews([stamp({ batchID: NEXT }), stamp(), stamp({ batchID: THIRD })], NEXT, BATCH);
    assert.deepEqual(
      views.map((view) => [view.problem, view.move]),
      [
        [null, false],
        [null, true],
        [catalogueReleaseFirstRefusal(BATCH), false],
      ],
    );
  });

  it('says, while cleared, which batch and node the catalogue stays pinned to', () => {
    const note = cataloguePinnedNote({ profileName: 'catalogue-node', batchId: BATCH });
    assert.match(note, /^The catalogue stays pinned to batch abababab…ababab on catalogue-node/);
    assert.match(note, /Designate it again/);
    assert.match(note, /another batch is a move\.$/);
  });
});

describe('a move of the catalogue', () => {
  const NEXT = 'ff'.repeat(32);
  const move = { profileName: 'catalogue-node', batchId: BATCH };

  it('is confirmed with what the admin does and what to keep alive until it is done', () => {
    const text = catalogueMoveConfirmText(BATCH, NEXT);
    assert.match(
      text,
      /^The web2 admin stamps every slot of the catalogue again under batch ffffffff…ffffff, then switches to it\./,
    );
    assert.match(text, /keep batch abababab…ababab alive/);
    assert.match(text, /press Release the previous batch here\.$/);
  });

  it('is shown pending with the batch moved from and the three steps', () => {
    assert.equal(catalogueMovingLine(move), 'Moving from batch abababab…ababab on catalogue-node');
    const steps = catalogueMoveSteps(NEXT);
    assert.equal(steps.length, 3);
    assert.match(steps[0]!, /Stages page, start “Move the catalogue to batch ffffffff…ffffff”/);
    assert.match(steps[0]!, /CATALOGUE_MOVE_ENABLED/);
    assert.equal(steps[1], 'Wait until it says the move is done.');
    assert.equal(steps[2], `Press “${CATALOGUE_RELEASE_LABEL}” here.`);
  });

  it('is released after a confirm that says the node can then go and the batch may lapse', () => {
    const text = catalogueReleaseConfirmText(move);
    assert.match(text, /catalogue-node can then be removed, and the batch may lapse/);
    assert.match(text, /only once the web2 admin reports the move done\.$/);
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

describe('the pinned node’s Bee API', () => {
  it('warns when Docker reports it published on every address, and says nothing otherwise', () => {
    assert.equal(catalogueApiWarning({ apiOnEveryAddress: true }), CATALOGUE_API_EVERY_ADDRESS_WARNING);
    assert.match(CATALOGUE_API_EVERY_ADDRESS_WARNING, /every address/);
    assert.match(CATALOGUE_API_EVERY_ADDRESS_WARNING, /no password/);
    assert.match(CATALOGUE_API_EVERY_ADDRESS_WARNING, /firewall must admit the control host alone/);
    for (const apiOnEveryAddress of [false, null, undefined]) {
      assert.equal(catalogueApiWarning({ apiOnEveryAddress }), null, String(apiOnEveryAddress));
    }
  });

  // A redeploy binds a node on the manager's own host to the bridge only when
  // its bind is empty, it is not on host networking and the manager confirmed
  // the bridge. The card promises no more than that, so a node kept open on
  // purpose, or one on host networking, is not told a redeploy closes it.
  it('promises a redeploy only where one binds the node, and says what binds it otherwise', () => {
    const warning = CATALOGUE_API_EVERY_ADDRESS_WARNING;
    assert.match(
      warning,
      /only when its BEE_UPLOADER_API_BIND is empty, it is not on host networking and the manager confirmed the bridge/,
    );
    assert.match(warning, /could not confirm the bridge.*BEE_UPLOADER_API_BIND in the node’s settings is yours to set/);
    assert.match(
      warning,
      /0\.0\.0\.0 keeps the node open on purpose, so this warning stays until that setting changes/,
    );
    assert.match(warning, /Under host networking its listen address is what counts/);
    assert.match(warning, /BEE_UPLOADER_API_LISTEN in the node’s settings/);
    assert.match(warning, /the deploy warns while it is empty/);
  });
});
