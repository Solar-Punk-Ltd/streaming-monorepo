/**
 * Where the catalogue is written, and when it is not. Unit test: the catalogue batch rules on their own, then the
 * publish service and the boot check over the real CatalogueBatchService, with the catalogue stamp store, the feed
 * write log and the gateway in memory. `pnpm test`.
 *
 * Pinned here: every write goes through the node and batch of the stored catalogue stamp and records its exact bytes
 * and its batch; a publish, an unpublish or a reconcile with no designation, a cleared one, or an expired or gone batch
 * is refused with its sentence before anything moves; the admin keeps writing with the batch it pinned while a move
 * to another is waiting, and adopts the designated one when the feed has no history; and the boot's feed check waits
 * for a designation when the admin starts with none.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { CatalogueStampRecord } from '@streaming-monorepo/contracts';

import { UPLOADER } from '../../src/domain/actor.js';
import {
  CatalogueBatchService,
  catalogueRefusal,
  planCatalogueWrite,
  type CatalogueWritePlan,
} from '../../src/domain/CatalogueBatch.js';
import { CatalogueStampUnavailableError } from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import { FeedBootCheckRunner } from '../../src/domain/feedBootCheck.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { StageService } from '../../src/domain/StageService.js';
import type { CatalogueStampRow } from '../../src/types/index.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  streamRow,
  TEST_OPERATOR,
  TEST_OWNER,
} from './support/fakes.js';
import {
  CATALOGUE_BATCH_ID,
  catalogueStampRecord,
  FakeCatalogueStampStore,
  FakeStageStore,
  stagesWithMain,
} from './support/stageFakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

/** A batch the manager designates after the catalogue already has history under CATALOGUE_BATCH_ID. */
const NEXT_BATCH_ID = 'd3'.repeat(32);

const NONE = 'The manager has not designated a catalogue batch yet. Nothing is written to the catalogue until it does.';
const CLEARED =
  'The manager cleared the catalogue batch designation. Nothing is written to the catalogue until it designates one again.';
const EXPIRED = 'The catalogue batch c2c2c2c2… is expired. Nothing can be written to the catalogue with it.';
const GONE = 'The catalogue batch c2c2c2c2… is gone. Nothing can be written to the catalogue with it.';

/** The row as migrations 010 and 011 leave it after `record` was pushed and `active` pinned. */
function row(
  record: CatalogueStampRecord | null,
  active: CatalogueStampRecord | null = null,
  cleared = false,
): CatalogueStampRow {
  const at = new Date('2026-09-28T10:00:00.000Z');
  return {
    manager_id: record?.managerId ?? null,
    batch_id: record?.batchId ?? null,
    record,
    observed_at: at,
    received_at: at,
    cleared_observed_at: cleared ? at : null,
    cleared_at: cleared ? at : null,
    active_batch_id: active?.batchId ?? null,
    active_record: active,
    active_pinned_at: active ? at : null,
  };
}

const next = (over: Partial<CatalogueStampRecord> = {}) =>
  catalogueStampRecord({
    batchId: NEXT_BATCH_ID,
    beeApiUrl: 'http://198.51.100.7:1633',
    nodeName: 'new-catalogue-node',
    observedAt: '2026-09-28T11:00:00.000Z',
    ...over,
  });

function writes(plan: CatalogueWritePlan): { batchId: string | undefined; pin: boolean; moveWaitingTo: string | null } {
  assert.equal(plan.refusal, null, `refused: ${plan.refusal?.message}`);
  return { batchId: plan.batch?.batchId, pin: plan.pin, moveWaitingTo: plan.moveWaitingTo };
}

describe('planCatalogueWrite', () => {
  it('refuses when the manager has designated no batch, with the sentence the console shows', () => {
    for (const stored of [null, row(null, null, true)]) {
      const plan = planCatalogueWrite(stored, false);
      assert.deepEqual(plan.refusal, { problem: 'none', message: NONE });
      assert.equal(plan.batch, null);
    }
  });

  it('refuses a cleared designation, and keeps the pinned batch pinned', () => {
    const plan = planCatalogueWrite(row(catalogueStampRecord(), catalogueStampRecord(), true), true);
    assert.deepEqual(plan.refusal, { problem: 'cleared', message: CLEARED });
    assert.equal(plan.pin, false);
    assert.equal(plan.pinned, CATALOGUE_BATCH_ID);
  });

  it('writes with the designated batch and pins it when nothing is pinned, history or not', () => {
    for (const hasHistory of [false, true]) {
      assert.deepEqual(writes(planCatalogueWrite(row(catalogueStampRecord()), hasHistory)), {
        batchId: CATALOGUE_BATCH_ID,
        pin: true,
        moveWaitingTo: null,
      });
    }
  });

  it('writes with the designated batch and its latest reading when it is the pinned one', () => {
    const designated = catalogueStampRecord({ ttlSeconds: 5 * 86_400, beeApiUrl: 'http://192.0.2.11:1633' });
    const plan = planCatalogueWrite(row(designated, catalogueStampRecord()), true);
    assert.deepEqual(writes(plan), { batchId: CATALOGUE_BATCH_ID, pin: false, moveWaitingTo: null });
    assert.equal(plan.batch, designated);
  });

  it('keeps writing with the pinned batch, as last read, while a move to a newly designated one waits', () => {
    const pinned = catalogueStampRecord();
    const plan = planCatalogueWrite(row(next(), pinned), true);
    assert.deepEqual(writes(plan), { batchId: CATALOGUE_BATCH_ID, pin: false, moveWaitingTo: NEXT_BATCH_ID });
    assert.equal(plan.batch, pinned, "the pinned batch's own node and readings, not the designated one's");
  });

  it('adopts a newly designated batch when the feed has no history to move', () => {
    assert.deepEqual(writes(planCatalogueWrite(row(next(), catalogueStampRecord()), false)), {
      batchId: NEXT_BATCH_ID,
      pin: true,
      moveWaitingTo: null,
    });
  });

  it('refuses a batch that is expired or gone, naming it', () => {
    for (const [state, message] of [
      ['expired', EXPIRED],
      ['gone', GONE],
    ] as const) {
      const plan = planCatalogueWrite(row(catalogueStampRecord({ state })), false);
      assert.deepEqual(plan.refusal, { problem: state, message });
      assert.equal(plan.pin, false, 'a dead batch is never pinned');
    }
  });

  it('refuses when the pinned batch is expired by its last reading, even though the designated one is fine', () => {
    const plan = planCatalogueWrite(row(next(), catalogueStampRecord({ state: 'expired' })), true);
    assert.deepEqual(plan.refusal, { problem: 'expired', message: EXPIRED });
    assert.equal(plan.moveWaitingTo, NEXT_BATCH_ID);
  });

  it('says every refusal in a sentence of its own', () => {
    assert.equal(catalogueRefusal('none', null), NONE);
    assert.equal(catalogueRefusal('cleared', null), CLEARED);
    assert.equal(catalogueRefusal('expired', CATALOGUE_BATCH_ID), EXPIRED);
    assert.equal(catalogueRefusal('gone', CATALOGUE_BATCH_ID), GONE);
  });
});

function setup({ stampRequired = true } = {}) {
  const catalogue = new FakeCatalogueStampStore();
  const feedWrites = new FakeFeedWriteLog();
  const audit = new InMemoryAuditLog();
  const gateway = new FakeFeedGateway();
  const batches = new CatalogueBatchService(catalogue, feedWrites, feed, audit, { stampRequired });
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const service = new PublishService(store, renditions, stagesWithMain(), feedWrites, gateway, batches, feed, audit);
  return { catalogue, feedWrites, audit, gateway, batches, store, service };
}

async function refusedWith(promise: Promise<unknown>, problem: string, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CatalogueStampUnavailableError, `not a catalogue refusal: ${String(error)}`);
    assert.equal(error.problem, problem);
    assert.equal(error.message, message);
    return true;
  });
}

describe('CatalogueBatchService', () => {
  it('hands the in-memory gateway no target while nothing is designated, and follows a designation once there is one', async () => {
    const { catalogue, batches } = setup({ stampRequired: false });
    assert.equal(await batches.forWrite(TEST_OPERATOR), null);
    assert.equal((await batches.status()).refusal, null, 'a local run with no manager is not refused');

    await catalogue.upsert(catalogueStampRecord({ state: 'expired' }));
    await refusedWith(batches.forWrite(TEST_OPERATOR), 'expired', EXPIRED);
  });

  it('pins the batch once, audited as the writer, and not again on the next write', async () => {
    const { catalogue, audit, batches } = setup();
    await catalogue.upsert(catalogueStampRecord());

    assert.deepEqual(await batches.forWrite(TEST_OPERATOR), {
      beeApiUrl: 'http://192.0.2.10:1633',
      batchId: CATALOGUE_BATCH_ID,
    });
    await batches.forWrite(TEST_OPERATOR);

    assert.deepEqual(catalogue.pins, [CATALOGUE_BATCH_ID]);
    assert.equal(catalogue.row?.active_batch_id, CATALOGUE_BATCH_ID);
    assert.deepEqual(
      audit.entries.map((entry) => [entry.action, entry.actor, entry.details]),
      [
        [
          'catalogue.batch.pin',
          TEST_OPERATOR,
          { batchId: CATALOGUE_BATCH_ID, nodeName: 'catalogue-node', previousBatchId: null, feedHadHistory: false },
        ],
      ],
    );
  });

  it('keeps the pinned batch fresh while it is the designated one, and as it was once another is designated', async () => {
    const { catalogue, batches } = setup();
    await catalogue.upsert(catalogueStampRecord());
    await batches.forWrite(TEST_OPERATOR);

    await catalogue.upsert(catalogueStampRecord({ ttlSeconds: 86_400, observedAt: '2026-09-28T10:30:00.000Z' }));
    assert.equal(catalogue.row?.active_record?.ttlSeconds, 86_400);

    await catalogue.upsert(next());
    assert.equal(catalogue.row?.active_record?.ttlSeconds, 86_400, 'a record for another batch leaves it be');
    assert.equal(catalogue.row?.active_record?.observedAt, '2026-09-28T10:30:00.000Z');
  });

  it('tells the console the batch it writes with and a waiting move, without the Bee API address', async () => {
    const { catalogue, feedWrites, batches } = setup();
    await catalogue.upsert(catalogueStampRecord());
    await batches.forWrite(TEST_OPERATOR);
    await feedWrites.record({
      owner: feed.owner,
      topic: feed.topicHex,
      feedIndex: 0,
      entryCount: 0,
      payload: [],
      payloadText: '[]',
      reference: 'a'.repeat(64),
      batchId: CATALOGUE_BATCH_ID,
    });
    await catalogue.upsert(next());

    const status = await batches.status();
    assert.deepEqual(status, {
      batch: {
        batchId: CATALOGUE_BATCH_ID,
        nodeName: 'catalogue-node',
        state: 'active',
        ttlSeconds: 30 * 86_400,
        fillRatio: 0.01,
        observedAt: '2026-09-28T10:00:00.000Z',
      },
      refusal: null,
      moveWaitingTo: NEXT_BATCH_ID,
    });
    assert.equal(JSON.stringify(status).includes('1633'), false);
  });

  it('reads the feed through the batch it writes with, expired or not, and skips with no designation', async () => {
    const { catalogue, batches } = setup();
    assert.deepEqual(await batches.forRead(), { skipped: NONE });

    await catalogue.upsert(catalogueStampRecord({ state: 'expired' }));
    assert.deepEqual(await batches.forRead(), {
      target: { beeApiUrl: 'http://192.0.2.10:1633', batchId: CATALOGUE_BATCH_ID },
    });
  });
});

describe('PublishService through the catalogue stamp', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('refuses a publish with no designation before it claims the row or writes anything', async () => {
    const { store, gateway, feedWrites, service } = ctx;
    const stream = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), {
      thumbnail: Buffer.from('89504e47', 'hex'),
      thumbnail_mime: 'image/png',
    });

    await refusedWith(service.publish(TEST_OPERATOR, stream.id), 'none', NONE);

    assert.equal(store.get(stream.id).status, 'draft');
    assert.equal(store.get(stream.id).publish_error, null);
    assert.equal(gateway.writes.length, 0);
    assert.equal(gateway.thumbnails.length, 0, 'nothing is stamped either');
    assert.equal(feedWrites.records.length, 0);
  });

  it('refuses an unpublish and a reconcile with no designation, leaving the stream on the catalogue', async () => {
    const { store, gateway, service } = ctx;
    const stream = store.add(streamRow({ status: 'published', published_feed_index: 0 }));

    await refusedWith(service.unpublish(TEST_OPERATOR, stream.id), 'none', NONE);
    await refusedWith(service.reconcile(TEST_OPERATOR), 'none', NONE);

    assert.equal(store.get(stream.id).status, 'published');
    assert.equal(gateway.writes.length, 0);
  });

  it('writes the feed and its thumbnail through the stamp, and records the exact bytes and the batch', async () => {
    const { catalogue, store, gateway, feedWrites, service } = ctx;
    await catalogue.upsert(catalogueStampRecord());
    const stream = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), {
      thumbnail: Buffer.from('89504e47', 'hex'),
      thumbnail_mime: 'image/png',
    });

    await service.publish(TEST_OPERATOR, stream.id);

    const target = { beeApiUrl: 'http://192.0.2.10:1633', batchId: CATALOGUE_BATCH_ID };
    assert.deepEqual(gateway.thumbnails[0]?.target, target);
    assert.deepEqual(gateway.writes[0]?.target, target);
    const [record] = feedWrites.records;
    assert.equal(record?.payloadText, gateway.writes[0]?.payloadText, 'the string the gateway sent');
    assert.deepEqual(JSON.parse(record!.payloadText!), record?.payload);
    assert.equal(record?.batchId, CATALOGUE_BATCH_ID);
    assert.equal(catalogue.row?.active_batch_id, CATALOGUE_BATCH_ID, 'pinned by the first write');
  });

  it('keeps writing with the pinned batch after the manager designates another, and adopts it on a feed with no history', async () => {
    const { catalogue, store, gateway, feedWrites, service } = ctx;
    await catalogue.upsert(catalogueStampRecord());
    const first = store.add(streamRow());
    await service.publish(TEST_OPERATOR, first.id);

    await catalogue.upsert(next());
    const second = store.add(streamRow());
    await service.publish(TEST_OPERATOR, second.id);

    assert.deepEqual(gateway.writes[1]?.target, { beeApiUrl: 'http://192.0.2.10:1633', batchId: CATALOGUE_BATCH_ID });
    assert.equal(feedWrites.records[1]?.batchId, CATALOGUE_BATCH_ID);
    assert.equal(catalogue.row?.active_batch_id, CATALOGUE_BATCH_ID);

    // A feed with no recorded write (the feed key changed) has nothing to move: the designated batch is adopted.
    feedWrites.records.length = 0;
    const third = store.add(streamRow());
    await service.publish(TEST_OPERATOR, third.id);
    assert.deepEqual(gateway.writes.at(-1)?.target, { beeApiUrl: 'http://198.51.100.7:1633', batchId: NEXT_BATCH_ID });
    assert.equal(catalogue.row?.active_batch_id, NEXT_BATCH_ID);
  });

  it('refuses after the manager clears the designation, and writes again with the pinned batch once it is back', async () => {
    const { catalogue, store, gateway, service } = ctx;
    await catalogue.upsert(catalogueStampRecord());
    const stream = store.add(streamRow());
    await service.publish(TEST_OPERATOR, stream.id);

    await catalogue.clear('2026-09-28T10:10:00.000Z');
    await refusedWith(service.unpublish(TEST_OPERATOR, stream.id), 'cleared', CLEARED);
    assert.equal(catalogue.row?.active_batch_id, CATALOGUE_BATCH_ID, 'a clear leaves the pin');

    await catalogue.upsert(catalogueStampRecord({ observedAt: '2026-09-28T10:20:00.000Z' }));
    await service.unpublish(TEST_OPERATOR, stream.id);
    assert.equal(gateway.writes.at(-1)?.target?.batchId, CATALOGUE_BATCH_ID);
  });

  it('refuses a publish once the batch is expired or gone', async () => {
    const { catalogue, store, service } = ctx;
    const stream = store.add(streamRow());
    await catalogue.upsert(catalogueStampRecord({ state: 'gone' }));

    await refusedWith(service.publish(TEST_OPERATOR, stream.id), 'gone', GONE);
    assert.equal(store.get(stream.id).status, 'draft');
  });

  it("refuses a state report's rewrite, keeps the reported state, and records why on the row", async () => {
    const { store, gateway, service } = ctx;
    const stream = store.add(streamRow({ status: 'live', published_feed_index: 3 }));

    await refusedWith(service.republishWithState(UPLOADER, store.get(stream.id)), 'none', NONE);

    assert.equal(store.get(stream.id).status, 'live');
    assert.equal(store.get(stream.id).publish_error, NONE);
    assert.equal(gateway.writes.length, 0);
  });
});

describe('the boot feed check without a catalogue stamp', () => {
  it('is skipped with the reason, reads nothing, and runs once a push stores a designation', async () => {
    const { catalogue, gateway, audit, service } = setup();
    const runner = new FeedBootCheckRunner(service);
    const stages = new StageService(new FakeStageStore(), catalogue, audit);
    let stored: Promise<unknown> = Promise.resolve();
    stages.onCatalogueStampStored(() => {
      stored = runner.catalogueStampStored();
    });

    const atBoot = await runner.run();
    assert.equal(atBoot?.skipped, NONE);
    assert.equal(gateway.reads.length, 0);

    await stages.storeCatalogueStamp(catalogueStampRecord());
    const later = (await stored) as Awaited<ReturnType<FeedBootCheckRunner['run']>>;
    assert.equal(later?.skipped, null);
    assert.deepEqual(gateway.reads, [{ beeApiUrl: 'http://192.0.2.10:1633', batchId: CATALOGUE_BATCH_ID }]);

    // Once run, it is done: a later push does not run it again.
    await stages.storeCatalogueStamp(catalogueStampRecord({ observedAt: '2026-09-28T10:05:00.000Z' }));
    assert.equal(await stored, null);
    assert.equal(gateway.reads.length, 1);
  });

  it('does not tell the listener about a push that was kept out or stays cleared', async () => {
    const catalogue = new FakeCatalogueStampStore();
    const stages = new StageService(new FakeStageStore(), catalogue, new InMemoryAuditLog());
    let calls = 0;
    stages.onCatalogueStampStored(() => {
      calls += 1;
    });

    await stages.clearCatalogueStamp('2026-09-28T12:00:00.000Z');
    await stages.storeCatalogueStamp(catalogueStampRecord());
    assert.equal(calls, 0, 'a record observed before the clear sets nothing');

    await stages.storeCatalogueStamp(catalogueStampRecord({ observedAt: '2026-09-28T12:00:01.000Z' }));
    assert.equal(calls, 1);
  });
});
