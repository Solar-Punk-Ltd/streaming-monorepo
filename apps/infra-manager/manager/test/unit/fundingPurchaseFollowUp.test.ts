/**
 * What follows a batch purchase of the funding API, which the manager runs in the background from the step each
 * purchase's row holds: a lost answer settled from the node's batches, the wait for a usable batch and its hour, a
 * rung's batch set and the stages that follow it applied one at a time, the catalogue batch designated as a move and
 * released, an archive stamp recorded, and the admin's three calls, restart, check and release.
 *
 * Unit test, no database, no chain and no Bee node: an in-memory journal, a fake node that is read, fakes of the three
 * ports of `purchaseFollowUpPorts.ts` and of the archive batches' designation, and a clock the test moves. Each step is
 * taken with `advance`, as the sweep takes it every 30 seconds. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  ARCHIVE_PURCHASE_SETTLE_MS,
  PURCHASE_CHECK_NOTHING_REFUSAL,
  PURCHASE_NOT_USABLE_ERROR,
  PURCHASE_RELEASE_NOT_WAITING_REFUSAL,
  PURCHASE_RESTART_NOT_WAITING_REFUSAL,
  purchaseNodeLabel,
} from '@streaming-infra-manager/common';
import {
  FUNDING_PURCHASE_USABLE_WAIT_SECONDS,
  type FundingBatchPurchasePurpose,
  type FundingPurchaseApplyState,
} from '@streaming-monorepo/contracts';

import type { BeeStamp } from '../../src/domain/BeeClient.js';
import { ArchiveBatchRefusedError } from '../../src/domain/errors/index.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';
import { FUNDING_STATUS_READ_MS } from '../../src/domain/funding/FundingChainService.js';
import { FundingPurchaseFollowUp } from '../../src/domain/funding/FundingPurchaseFollowUp.js';
import type { FundingStampPurchaseRow } from '../../src/domain/funding/FundingStampPurchaseJournal.js';
import type {
  PurchasedCatalogueBatches,
  PurchasedRungBatches,
  PurchaseFollower,
  PurchaseStageApplier,
  PurchaseStageLook,
} from '../../src/domain/funding/purchaseFollowUpPorts.js';
import type { ArchiveBatchToDesignate } from '../../src/domain/stages/archiveBatchPorts.js';
import type { Profile } from '../../src/types/index.js';
import { emptyCatalogueDesignationRow } from '../support/InMemoryCatalogueDesignation.js';
import { InMemoryFundingStampPurchaseJournal } from '../support/InMemoryFundingStampPurchaseJournal.js';
import { makeProfile } from '../support/profileFixtures.js';

const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const RUNG_ID = '2dab8c50-4e6f-4071-8c1d-3e4f5a6b7c8d';
const CATALOGUE_ID = '4fcdae72-6081-4293-ae3f-5a6b7c8d9eaf';
const STAGE_ONE = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const STAGE_TWO = '1c9a7b4f-3d5e-4f60-9b0c-2d3e4f5a6b7c';
const STAGE_PASTED = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const BOUGHT = 'c5'.repeat(32);
const REPLACED = 'd6'.repeat(32);
const PREVIOUS = 'e7'.repeat(32);
const CATALOGUE_BATCH = 'ef'.repeat(32);
const DEPTH = 20;
const START = Date.parse('2026-11-19T10:00:00.000Z');
const HOUR = FUNDING_PURCHASE_USABLE_WAIT_SECONDS * 1000;

const PROFILES: Record<string, Profile> = {
  [`${RUNG_ID}:bee-uploader`]: makeProfile({
    name: 'pool-720p',
    kind: 'custom',
    instance_id: RUNG_ID,
    components: ['bee-uploader'],
    port_slot: 3,
  }),
  [`${CATALOGUE_ID}:bee-uploader`]: makeProfile({
    name: 'catalogue',
    kind: 'custom',
    instance_id: CATALOGUE_ID,
    components: ['bee-uploader'],
    port_slot: 5,
  }),
};

function nodeOf(purpose: FundingBatchPurchasePurpose): string {
  return purpose === 'rung' ? `${RUNG_ID}:bee-uploader` : `${CATALOGUE_ID}:bee-uploader`;
}

/** A purchase's row at the step it has reached: bought, and waiting for its batch to become usable, by default. */
function row(
  purpose: FundingBatchPurchasePurpose,
  over: Partial<FundingStampPurchaseRow> = {},
): FundingStampPurchaseRow {
  return {
    requestId: REQUEST,
    purpose,
    nodeId: nodeOf(purpose),
    depth: DEPTH,
    amountPerChunkPlur: '12441600000',
    costPlur: (12441600000n << BigInt(DEPTH)).toString(),
    immutable: purpose !== 'rung',
    label: purpose === 'archive' ? 'Autumn event' : null,
    nodeLabel: purchaseNodeLabel(purpose, REQUEST),
    replacesBatchId: purpose === 'archive' ? null : `0x${REPLACED}`,
    batchId: `0x${BOUGHT}`,
    txHash: null,
    state: 'confirmed',
    step: 'waiting_usable',
    error: null,
    createdAt: new Date(START),
    updatedAt: new Date(START),
    boughtAt: new Date(START),
    setAt: null,
    previousBatchId: null,
    releasedAt: null,
    recordedAt: null,
    ...over,
  };
}

/** A batch as Bee answers it, the bought one by default, not usable yet. */
function beeStamp(batchID: string, over: Partial<BeeStamp> = {}): BeeStamp {
  return {
    batchID,
    utilization: 0,
    usable: false,
    label: purchaseNodeLabel('rung', REQUEST),
    depth: DEPTH,
    amount: '12441600000',
    bucketDepth: 16,
    blockNumber: 43_000_000,
    immutableFlag: false,
    exists: true,
    batchTTL: 30 * 86_400,
    ...over,
  };
}

/** The three ports of `purchaseFollowUpPorts.ts`, faked: what each was asked, and what each answers. */
class FakePorts {
  readonly sets: Array<{ profileName: string; batchId: string; requestId: string }> = [];
  followers: PurchaseFollower[] = [
    { stageId: STAGE_ONE, name: 'stage-one', following: true },
    { stageId: STAGE_TWO, name: 'stage-two', following: true },
    { stageId: STAGE_PASTED, name: 'stage-pasted', following: false },
  ];
  setFailure: Error | null = null;
  readonly looks: Array<{ stageId: string; batchId: string; force: boolean; retryFailed: boolean }> = [];
  /** What each stage's looks answer, one after another; the last one stands. */
  readonly answers = new Map<string, PurchaseStageLook[]>();
  /** The stages whose look rejects, as one that could not be read at all. */
  readonly unreadable = new Set<string>();
  readonly designations: Array<{ profileName: string; batchId: string; requestId: string }> = [];
  previous: string | null = PREVIOUS;
  designateFailure: Error | null = null;
  readonly releases: Array<{ batchId: string; previousBatchId: string; requestId: string }> = [];
  releaseFailure: Error | null = null;

  answer(stageId: string, ...looks: Array<FundingPurchaseApplyState | PurchaseStageLook>): void {
    this.answers.set(
      stageId,
      looks.map((look) => (typeof look === 'string' ? { apply: look, message: null } : look)),
    );
  }

  readonly rungs: PurchasedRungBatches = {
    current: async () => ({ batchId: REPLACED, state: 'expired' }),
    set: async (input) => {
      this.sets.push(input);
      if (this.setFailure) throw this.setFailure;
      return this.followers;
    },
  };

  readonly stages: PurchaseStageApplier = {
    look: async (input) => {
      this.looks.push(input);
      if (this.unreadable.has(input.stageId)) throw new Error('the stage could not be read');
      const queue = this.answers.get(input.stageId) ?? [{ apply: 'applying', message: null }];
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
  };

  readonly catalogue: PurchasedCatalogueBatches = {
    current: async () => ({ batchId: CATALOGUE_BATCH, state: 'gone' }),
    designate: async (input) => {
      this.designations.push(input);
      if (this.designateFailure) throw this.designateFailure;
      return { previousBatchId: this.previous };
    },
    release: async (input) => {
      this.releases.push(input);
      if (this.releaseFailure) throw this.releaseFailure;
    },
  };
}

class FakeDesignator {
  readonly asked: ArchiveBatchToDesignate[] = [];
  failure: Error | null = null;

  async designateArchiveBatch(batch: ArchiveBatchToDesignate): Promise<void> {
    this.asked.push(batch);
    if (this.failure) throw this.failure;
  }
}

const running: FundingPurchaseFollowUp[] = [];

afterEach(async () => {
  // No timer of a test's follow-up outlives it.
  await Promise.all(running.splice(0).map((followUp) => followUp.stop()));
});

function setup(rows: FundingStampPurchaseRow[] = []) {
  const journal = new InMemoryFundingStampPurchaseJournal();
  for (const each of rows) journal.rows.set(each.requestId, { ...each });
  const ports = new FakePorts();
  const designator = new FakeDesignator();
  const node: { stamps: BeeStamp[]; stamp: BeeStamp | Error; listReads: number } = {
    stamps: [],
    stamp: beeStamp(BOUGHT),
    listReads: 0,
  };
  let now = START;
  const followUp = new FundingPurchaseFollowUp({
    journal,
    deployment: async (nodeId) => PROFILES[nodeId] ?? null,
    uploaderApiUrl: (profile) => `http://bee.invalid:${profile.port_slot}`,
    reads: () => ({
      listStamps: async () => {
        node.listReads += 1;
        return node.stamps;
      },
      getStamp: async (batchId) => {
        assert.equal(batchId, BOUGHT, 'the batch is read by its id without 0x');
        if (node.stamp instanceof Error) throw node.stamp;
        return node.stamp;
      },
    }),
    archiveBatches: { list: async () => [] },
    catalogue: {
      read: async () =>
        Object.assign(emptyCatalogueDesignationRow(), {
          profileName: 'catalogue',
          batchId: CATALOGUE_BATCH,
          batchDepth: 22,
          designatedAt: new Date(START),
        }),
    },
    designator,
    rungs: ports.rungs,
    stages: ports.stages,
    catalogueBatches: ports.catalogue,
    now: () => now,
    usablePollMs: 3_600_000,
  });
  running.push(followUp);
  return {
    followUp,
    journal,
    ports,
    designator,
    node,
    usable: () => void (node.stamp = beeStamp(BOUGHT, { usable: true })),
    later: (ms: number) => void (now += ms),
    current: () => journal.rows.get(REQUEST)!,
    applies: () => journal.stages.get(REQUEST)?.map((stage) => [stage.name, stage.apply]) ?? [],
  };
}

async function refusedWith(promise: Promise<unknown>, expected: RegExp | string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof FundingApiError, String(err));
    assert.equal(err.code, 'stamp_refused');
    if (typeof expected === 'string') assert.equal(err.message, expected);
    else assert.match(err.message, expected);
    return true;
  });
}

describe('a bought batch waiting to become usable', () => {
  it('waits while the node does not call it usable, and stops as failed an hour after it was bought', async () => {
    const { current, followUp, later, ports } = setup([row('rung')]);
    await followUp.advance(REQUEST);
    assert.equal(current().step, 'waiting_usable');
    later(HOUR - 1);
    await followUp.advance(REQUEST);
    assert.equal(current().step, 'waiting_usable', 'not before the hour');
    later(1);
    await followUp.advance(REQUEST);
    assert.deepEqual(
      [current().step, current().state, current().error],
      ['failed', 'confirmed', PURCHASE_NOT_USABLE_ERROR],
    );
    assert.deepEqual(ports.sets, [], 'nothing was set');
  });

  it('waits on a node it could not read, as one that does not call the batch usable yet', async () => {
    const { current, followUp, node } = setup([row('rung')]);
    node.stamp = new Error('connect ECONNREFUSED');
    await followUp.advance(REQUEST);
    assert.equal(current().step, 'waiting_usable');
  });
});

describe('a rung purchase', () => {
  it('sets the usable batch on the rung, writes the stages that follow it, and takes the first', async () => {
    const { applies, current, followUp, ports, usable } = setup([row('rung')]);
    usable();
    await followUp.advance(REQUEST);
    assert.deepEqual(ports.sets, [{ profileName: 'pool-720p', batchId: BOUGHT, requestId: REQUEST }]);
    assert.equal(current().step, 'set');
    assert.ok(current().setAt);
    assert.deepEqual(applies(), [
      ['stage-one', 'applying'],
      ['stage-two', 'pending'],
      ['stage-pasted', 'not_following'],
    ]);
    assert.deepEqual(ports.looks, [{ stageId: STAGE_ONE, batchId: BOUGHT, force: false, retryFailed: false }]);
  });

  it('applies one stage at a time, and is done once every stage is settled', async () => {
    const { applies, current, followUp, ports, usable } = setup([row('rung')]);
    ports.answer(STAGE_ONE, 'applying', 'applying', 'applied');
    ports.answer(STAGE_TWO, 'applying', 'applied');
    usable();
    await followUp.advance(REQUEST);
    await followUp.advance(REQUEST);
    assert.deepEqual(
      ports.looks.map((look) => look.stageId),
      [STAGE_ONE, STAGE_ONE],
      'the second stage waits while the first one’s Apply runs',
    );
    await followUp.advance(REQUEST);
    assert.deepEqual(applies().slice(0, 2), [
      ['stage-one', 'applied'],
      ['stage-two', 'applying'],
    ]);
    assert.equal(current().step, 'set');
    await followUp.advance(REQUEST);
    assert.deepEqual(applies(), [
      ['stage-one', 'applied'],
      ['stage-two', 'applied'],
      ['stage-pasted', 'not_following'],
    ]);
    assert.equal(current().step, 'done');
    assert.ok(!ports.looks.some((look) => look.stageId === STAGE_PASTED), 'a pasted string is never looked at');
  });

  it('lets a stage that waits for a broadcast hold none of the later ones back, and starts no second Apply', async () => {
    const { applies, followUp, ports, usable } = setup([row('rung')]);
    ports.answer(STAGE_ONE, 'waiting_live', 'applying');
    ports.answer(STAGE_TWO, 'applying');
    usable();
    await followUp.advance(REQUEST);
    assert.deepEqual(applies().slice(0, 2), [
      ['stage-one', 'waiting_live'],
      ['stage-two', 'applying'],
    ]);
    ports.looks.length = 0;
    await followUp.advance(REQUEST);
    assert.deepEqual(
      ports.looks.map((look) => look.stageId),
      [STAGE_TWO],
      'the Apply under way is looked at first, and nothing else starts while it runs',
    );
  });

  it('is done at once when no stage follows the rung', async () => {
    const { current, followUp, ports, usable } = setup([row('rung')]);
    ports.followers = [];
    usable();
    await followUp.advance(REQUEST);
    assert.equal(current().step, 'done');
  });

  it('leaves a stage that could not be read for the next pass, and looks at the next one', async () => {
    const { applies, followUp, ports, usable } = setup([row('rung')]);
    ports.unreadable.add(STAGE_ONE);
    usable();
    await followUp.advance(REQUEST);
    assert.deepEqual(applies().slice(0, 2), [
      ['stage-one', 'pending'],
      ['stage-two', 'applying'],
    ]);
  });

  it('stops as failed with the port’s sentence when the batch could not be set, and a check sets it', async () => {
    const { current, followUp, ports, usable } = setup([row('rung')]);
    ports.setFailure = new Error('Another batch was set on pool-720p meanwhile, so this one is left unset.');
    usable();
    await followUp.advance(REQUEST);
    assert.deepEqual(
      [current().step, current().error],
      ['failed', 'Another batch was set on pool-720p meanwhile, so this one is left unset.'],
    );
    ports.setFailure = null;
    await followUp.check(REQUEST);
    assert.equal(current().step, 'set');
    assert.equal(current().error, null);
    assert.equal(ports.sets.length, 2);
  });
});

describe('a catalogue purchase', () => {
  it('designates the usable batch as a move, keeps the batch it moved from, and waits for the release', async () => {
    const { current, followUp, ports, usable } = setup([row('catalogue')]);
    usable();
    await followUp.advance(REQUEST);
    assert.deepEqual(ports.designations, [{ profileName: 'catalogue', batchId: BOUGHT, requestId: REQUEST }]);
    assert.deepEqual([current().step, current().previousBatchId], ['set', `0x${PREVIOUS}`]);
  });

  it('is done at once when it moved from no batch', async () => {
    const { current, followUp, ports, usable } = setup([row('catalogue')]);
    ports.previous = null;
    usable();
    await followUp.advance(REQUEST);
    assert.deepEqual([current().step, current().previousBatchId], ['done', null]);
  });

  it('releases the batch it moved from on the admin’s word, once, and answers a second release as it stands', async () => {
    const { current, followUp, later, ports } = setup([
      row('catalogue', { step: 'set', setAt: new Date(START), previousBatchId: `0x${PREVIOUS}` }),
    ]);
    later(60_000);
    await followUp.release(REQUEST);
    assert.deepEqual(ports.releases, [{ batchId: BOUGHT, previousBatchId: PREVIOUS, requestId: REQUEST }]);
    assert.deepEqual([current().step, current().releasedAt], ['done', new Date(START + 60_000)]);
    await followUp.release(REQUEST);
    assert.equal(ports.releases.length, 1);
  });

  it('refuses a release with the port’s sentence when the designation moved on, and leaves the purchase set', async () => {
    const { current, followUp, ports } = setup([
      row('catalogue', { step: 'set', setAt: new Date(START), previousBatchId: `0x${PREVIOUS}` }),
    ]);
    ports.releaseFailure = new Error('The catalogue has moved on to another batch since.');
    await refusedWith(followUp.release(REQUEST), 'The catalogue has moved on to another batch since.');
    assert.equal(current().step, 'set');
  });

  it('refuses a release for a purchase with no previous batch waiting', async () => {
    for (const waiting of [
      row('rung', { step: 'set', setAt: new Date(START) }),
      row('catalogue'),
      row('catalogue', { step: 'done', setAt: new Date(START) }),
    ]) {
      const { followUp, ports } = setup([waiting]);
      await refusedWith(followUp.release(REQUEST), PURCHASE_RELEASE_NOT_WAITING_REFUSAL);
      assert.deepEqual(ports.releases, []);
    }
  });

  it('stops as failed with the designation’s own sentence when a check refuses', async () => {
    const { current, followUp, ports, usable } = setup([row('catalogue')]);
    ports.designateFailure = new Error('A move to another batch is still pending.');
    usable();
    await followUp.advance(REQUEST);
    assert.deepEqual([current().step, current().error], ['failed', 'A move to another batch is still pending.']);
  });
});

describe('an archive stamp purchase', () => {
  it('is recorded as an archive batch, and done once its batch is usable', async () => {
    const { current, designator, followUp, usable } = setup([row('archive')]);
    await followUp.advance(REQUEST);
    assert.equal(designator.asked.length, 1, 'recorded as soon as it is bought');
    assert.ok(current().recordedAt);
    assert.equal(current().step, 'waiting_usable');
    usable();
    await followUp.advance(REQUEST);
    assert.equal(current().step, 'done');
    assert.equal(designator.asked.length, 1, 'and never again');
  });

  it('stops as failed with the refusal once usable when its batch has become the catalogue’s, and a check takes it up', async () => {
    const { current, designator, followUp, usable } = setup([row('archive')]);
    designator.failure = new ArchiveBatchRefusedError('The batch holds the catalogue.');
    usable();
    await followUp.advance(REQUEST);
    assert.deepEqual(
      [current().step, current().error, current().state],
      ['failed', 'The batch holds the catalogue.', 'confirmed'],
    );
    designator.failure = null;
    await followUp.check(REQUEST);
    assert.equal(current().step, 'done');
    assert.ok(current().recordedAt);
  });
});

describe('a purchase whose answer was lost', () => {
  function lost(purpose: FundingBatchPurchasePurpose) {
    return row(purpose, { state: 'unknown', step: 'buying', batchId: null, boughtAt: null });
  }

  it('is settled by the batch under its label, of its depth and kind, and goes on to wait for it', async () => {
    const { current, followUp, node } = setup([lost('rung')]);
    node.stamps = [
      beeStamp('a1'.repeat(32), { immutableFlag: true }),
      beeStamp('a2'.repeat(32), { depth: DEPTH + 1 }),
      beeStamp(BOUGHT),
    ];
    await followUp.advance(REQUEST);
    assert.deepEqual(
      [current().state, current().batchId, current().step, current().boughtAt],
      ['confirmed', `0x${BOUGHT}`, 'waiting_usable', new Date(START)],
    );
  });

  it('never takes the catalogue’s own batch under its label', async () => {
    const { current, followUp, node } = setup([lost('rung')]);
    node.stamps = [beeStamp(CATALOGUE_BATCH)];
    await followUp.advance(REQUEST);
    assert.equal(current().state, 'unknown');
  });

  it('fails thirty minutes after it was journalled with no batch under its label, and frees the node', async () => {
    const { current, followUp, later } = setup([lost('catalogue')]);
    later(ARCHIVE_PURCHASE_SETTLE_MS + FUNDING_STATUS_READ_MS);
    await followUp.advance(REQUEST);
    assert.deepEqual([current().state, current().step], ['failed', 'failed']);
    assert.match(current().error ?? '', /thirty minutes/);
  });
});

describe('the admin’s restart of a stage', () => {
  function waiting(apply: FundingPurchaseApplyState) {
    const setUp = setup([row('rung', { step: 'set', setAt: new Date(START) })]);
    setUp.journal.stages.set(REQUEST, [
      {
        stageId: STAGE_ONE,
        name: 'stage-one',
        position: 0,
        apply,
        message: null,
        forcedAt: null,
        updatedAt: new Date(START),
      },
    ]);
    return setUp;
  }

  for (const apply of ['waiting_live', 'waiting_unknown'] as const) {
    it(`runs the Apply now of a stage in ${apply}, forced, and keeps when it was asked`, async () => {
      const { applies, followUp, journal, later, ports } = waiting(apply);
      later(1_000);
      await followUp.restart(REQUEST, STAGE_ONE);
      assert.deepEqual(ports.looks, [{ stageId: STAGE_ONE, batchId: BOUGHT, force: true, retryFailed: false }]);
      assert.deepEqual(applies(), [['stage-one', 'applying']]);
      assert.deepEqual(journal.stages.get(REQUEST)?.[0]?.forcedAt, new Date(START + 1_000));
    });
  }

  it('refuses a stage in any other state, and one the purchase does not follow, asking the stage nothing', async () => {
    for (const apply of ['pending', 'waiting_settings', 'applying', 'applied', 'failed', 'stopped'] as const) {
      const { followUp, ports } = waiting(apply);
      await refusedWith(followUp.restart(REQUEST, STAGE_ONE), PURCHASE_RESTART_NOT_WAITING_REFUSAL);
      assert.deepEqual(ports.looks, [], apply);
    }
    await refusedWith(waiting('waiting_live').followUp.restart(REQUEST, STAGE_TWO), /no stage with this id/);
  });

  it('refuses when the stage could not be read, and leaves it waiting', async () => {
    const { applies, followUp, ports } = waiting('waiting_live');
    ports.unreadable.add(STAGE_ONE);
    await refusedWith(followUp.restart(REQUEST, STAGE_ONE), /could not be read/);
    assert.deepEqual(applies(), [['stage-one', 'waiting_live']]);
  });

  it('answers unknown_request for a purchase never journalled', async () => {
    await assert.rejects(setup().followUp.restart(REQUEST, STAGE_ONE), (err: unknown) => {
      assert.ok(err instanceof FundingApiError);
      assert.equal(err.code, 'unknown_request');
      return true;
    });
  });
});

describe('the admin’s check', () => {
  it('starts again the Apply of each stage that failed, one at a time', async () => {
    const { applies, followUp, journal, ports } = setup([row('rung', { step: 'set', setAt: new Date(START) })]);
    const failed = (stageId: string, name: string, position: number) => ({
      stageId,
      name,
      position,
      apply: 'failed' as const,
      message: 'The Apply did not go through.',
      forcedAt: null,
      updatedAt: new Date(START),
    });
    journal.stages.set(REQUEST, [failed(STAGE_ONE, 'stage-one', 0), failed(STAGE_TWO, 'stage-two', 1)]);
    await followUp.check(REQUEST);
    assert.deepEqual(ports.looks, [{ stageId: STAGE_ONE, batchId: BOUGHT, force: false, retryFailed: true }]);
    assert.deepEqual(applies(), [
      ['stage-one', 'applying'],
      ['stage-two', 'failed'],
    ]);
    ports.answer(STAGE_ONE, 'applied');
    await followUp.advance(REQUEST);
    assert.deepEqual(ports.looks.at(-1), { stageId: STAGE_TWO, batchId: BOUGHT, force: false, retryFailed: true });
  });

  it('takes up a purchase that stopped for want of a usable batch once its node calls it usable', async () => {
    const { current, followUp, usable } = setup([row('rung', { step: 'failed', error: PURCHASE_NOT_USABLE_ERROR })]);
    await followUp.check(REQUEST);
    assert.deepEqual([current().step, current().error], ['failed', PURCHASE_NOT_USABLE_ERROR], 'still not usable');
    usable();
    await followUp.check(REQUEST);
    assert.equal(current().step, 'set');
  });

  it('refuses when nothing stopped, and when nothing was bought', async () => {
    for (const nothing of [
      row('rung'),
      row('rung', { step: 'set', setAt: new Date(START) }),
      row('rung', { state: 'failed', step: 'failed', batchId: null, error: 'The node refused it (402).' }),
    ]) {
      await refusedWith(setup([nothing]).followUp.check(REQUEST), PURCHASE_CHECK_NOTHING_REFUSAL);
    }
  });
});

describe('the sweep', () => {
  it('advances every purchase there is something left to do for, and none that is done or failed', async () => {
    const second = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
    const done = '8b2c3d4e-5f60-4a7b-9c8d-0e1f2a3b4c5d';
    const { followUp, journal, ports, usable } = setup([
      row('rung'),
      row('catalogue', { requestId: second, nodeLabel: purchaseNodeLabel('catalogue', second) }),
      row('rung', {
        requestId: done,
        nodeLabel: purchaseNodeLabel('rung', done),
        step: 'done',
        setAt: new Date(START),
      }),
    ]);
    usable();
    await followUp.sweep();
    assert.equal(journal.rows.get(REQUEST)?.step, 'set');
    assert.equal(journal.rows.get(second)?.step, 'set');
    assert.equal(journal.rows.get(done)?.step, 'done');
    assert.equal(ports.sets.length, 1);
  });

  it('never runs one purchase’s follow-up twice at once', async () => {
    const { followUp, ports, usable } = setup([row('rung')]);
    usable();
    await Promise.all([followUp.advance(REQUEST), followUp.advance(REQUEST), followUp.sweep()]);
    assert.equal(ports.sets.length, 1);
  });

  it('does nothing once stopped', async () => {
    const { current, followUp, usable } = setup([row('rung')]);
    usable();
    await followUp.stop();
    await followUp.sweep();
    await followUp.advance(REQUEST);
    assert.equal(current().step, 'waiting_usable');
  });
});
