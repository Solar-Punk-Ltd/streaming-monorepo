/**
 * A key per stage: a stream's owner is its stage's. Unit test, against the
 * in-memory stores, with the fake stream store reading the stage table the
 * way the SQL does. `pnpm test`.
 *
 * The rules, from docs/architecture/stages.md: a stream takes its stage's
 * owner when the stage is set or changed, and again at the publish claim of a
 * draft that holds no recording, since the manager may have rotated the
 * stage's key; a stream with no stage keeps the brand key's address; a row
 * that holds a recording never changes owner, and is refused at publish when
 * its stage now signs as another; a draft older than stages that holds a
 * recording takes only a stage that signs as its owner; the catalogue is
 * still signed by the brand key, and a reconcile counts as ours every entry
 * under the brand key or any stage's owner, retired ones included.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { UPLOADER } from '../../src/domain/actor.js';
import { FeedOwnerMismatchError, StageLockedError } from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import { buildFeedEntry, planReconcile } from '../../src/domain/feedEntries.js';
import { asFeedOwner, type FeedIdentity } from '../../src/domain/feedIdentity.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { splitStageRecord } from '../../src/domain/StageService.js';
import { StreamService, type StreamInputValues } from '../../src/domain/StreamService.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  noCatalogueStamp,
  streamRow,
  TEST_OPERATOR,
  TEST_OWNER,
} from './support/fakes.js';
import { FakeStageStore, STAGE_ID, stageRecord } from './support/stageFakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

/** `STAGE_ID` signs with a key of its own. */
const OWN_OWNER = '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3';
/** A stage still signing as the brand key, as every stage did before each had its own. */
const BRAND_STAGE = '8c3f5d1b-4e5f-4061-9c73-3d4e5f607182';
const BRAND_STAGE_OWNER = `0x${TEST_OWNER}`;
/** A stage the manager retired, whose streams and old entries still name its owner. */
const RETIRED_STAGE = '6a1d3b9f-2c3d-4e4f-9a51-1b2c3d4e5f60';
const RETIRED_OWNER = '0x1111111111111111111111111111111111111111';
/** Nobody this admin knows. */
const FOREIGN_OWNER = '0x2222222222222222222222222222222222222222';
/** A key `STAGE_ID` signed with before the one it has, which no stage row names any more. */
const PRE_ROTATION_OWNER = '0x1234567890123456789012345678901234567890';
/** `STAGE_ID`'s owner once the manager rotated its key. */
const ROTATED_OWNER = '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09';

const FORM: StreamInputValues = {
  title: 'Opening keynote',
  description: 'The opening talk.',
  tags: ['swarm'],
  mediaType: 'video',
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
};

async function setup(gateway = new FakeFeedGateway()) {
  const stages = new FakeStageStore();
  await stages.upsert(splitStageRecord(stageRecord({ owner: OWN_OWNER })));
  await stages.upsert(
    splitStageRecord(stageRecord({ stageId: BRAND_STAGE, name: 'Brand-key stage', owner: BRAND_STAGE_OWNER })),
  );
  await stages.upsert(
    splitStageRecord(stageRecord({ stageId: RETIRED_STAGE, name: 'Old stage', owner: RETIRED_OWNER })),
  );
  await stages.retire(RETIRED_STAGE, '2026-09-28T11:00:00.000Z');

  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  store.stages = stages;
  const writes = new FakeFeedWriteLog();
  const audit = new InMemoryAuditLog();
  const streams = new StreamService(store, stages, feed, audit);
  const publish = new PublishService(store, renditions, stages, writes, gateway, noCatalogueStamp(), feed, audit);
  return { stages, store, writes, gateway, audit, streams, publish };
}

/** The manager rotated `STAGE_ID`'s key and pushed the stage again. */
async function rotate(stages: FakeStageStore, stageId = STAGE_ID): Promise<void> {
  await stages.upsert(
    splitStageRecord(stageRecord({ stageId, owner: ROTATED_OWNER, observedAt: '2026-09-28T10:05:00.000Z' })),
  );
}

/** A stream created on `STAGE_ID` before its key was rotated. */
const onOwnStage = (over: Parameters<typeof streamRow>[0] = {}) =>
  streamRow({ stage_id: STAGE_ID, owner: asFeedOwner(OWN_OWNER), ...over });

/** A draft older than stages that holds a recording: the brand key's, and no stage. */
const recordedBeforeStages = () => streamRow({ stage_id: null, manifest_index: 7, duration_seconds: 61 });

function answer(err: unknown): { status: number; body: unknown } {
  const sent = { status: 0, body: undefined as unknown };
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  errorHandler(err, {} as Request, res as unknown as Response, () => undefined);
  return sent;
}

describe('a stream takes its stage’s owner', () => {
  it('when it is created on a stage, in the form a row keeps an owner', async () => {
    const { streams } = await setup();

    const created = await streams.create(TEST_OPERATOR, { ...FORM, stageId: STAGE_ID });

    assert.equal(created.owner, OWN_OWNER.slice(2));
  });

  it('and keeps the brand key’s address when it is created with no stage', async () => {
    const { streams } = await setup();

    assert.equal((await streams.create(TEST_OPERATOR, { ...FORM, stageId: null })).owner, TEST_OWNER);
  });

  it('when its stage changes, and goes back to the brand key’s with none', async () => {
    const { store, streams, audit } = await setup();
    const row = store.add(onOwnStage());

    const moved = await streams.update(TEST_OPERATOR, row.id, { ...FORM, stageId: BRAND_STAGE });
    assert.equal(moved.owner, TEST_OWNER);
    assert.deepEqual(audit.entries.at(-1)?.details, {
      from: STAGE_ID,
      to: BRAND_STAGE,
      ownerFrom: OWN_OWNER.slice(2),
      ownerTo: TEST_OWNER,
    });

    const back = await streams.update(TEST_OPERATOR, row.id, { ...FORM, stageId: STAGE_ID });
    assert.equal(back.owner, OWN_OWNER.slice(2));

    const off = await streams.update(TEST_OPERATOR, row.id, { ...FORM, stageId: null });
    assert.equal(off.owner, TEST_OWNER);
  });

  it('and not on a save that leaves the stage alone', async () => {
    const { stages, store, streams } = await setup();
    const row = store.add(onOwnStage());
    await rotate(stages);

    assert.equal((await streams.update(TEST_OPERATOR, row.id, { ...FORM, title: 'Renamed' })).owner, row.owner);
  });
});

describe('a row that holds a recording keeps its owner', () => {
  it('and its stage, whatever it is moved to', async () => {
    const { store, streams } = await setup();
    const row = store.add(onOwnStage({ manifest_index: 7, duration_seconds: 61 }));

    await assert.rejects(
      () => streams.update(TEST_OPERATOR, row.id, { ...FORM, stageId: BRAND_STAGE }),
      (error: unknown) => error instanceof StageLockedError && error.reason === 'recording',
    );
    assert.deepEqual(store.get(row.id), row);
  });

  it('so one older than stages takes only a stage that signs as the recording’s owner', async () => {
    const { store, streams } = await setup();
    const row = store.add(recordedBeforeStages());

    await assert.rejects(
      () => streams.update(TEST_OPERATOR, row.id, { ...FORM, stageId: STAGE_ID }),
      (error: unknown) => error instanceof StageLockedError && error.reason === 'owner',
    );
    assert.deepEqual(store.get(row.id), row, 'nothing written');

    const given = await streams.update(TEST_OPERATOR, row.id, { ...FORM, stageId: BRAND_STAGE });
    assert.equal(given.stage_id, BRAND_STAGE);
    assert.equal(given.owner, TEST_OWNER);
  });

  it('and the stage refused when its key was rotated while the edit was on its way', async () => {
    const { stages, store, streams } = await setup();
    const row = store.add(recordedBeforeStages());
    const update = store.update.bind(store);
    store.update = async (...args) => {
      await rotate(stages, BRAND_STAGE);
      return update(...args);
    };

    await assert.rejects(
      () => streams.update(TEST_OPERATOR, row.id, { ...FORM, stageId: BRAND_STAGE }),
      (error: unknown) => error instanceof StageLockedError && error.reason === 'owner',
    );
    assert.equal(store.get(row.id).stage_id, null);
  });

  it('answers the refusal as 409 stage_locked with its reason', () => {
    const refusal = answer(new StageLockedError(STAGE_ID, 'owner'));
    assert.equal(refusal.status, 409);
    assert.deepEqual(
      { ...(refusal.body as object), message: undefined },
      { error: 'stage_locked', id: STAGE_ID, reason: 'owner', message: undefined },
    );
  });
});

describe('publishing on a stage with a key of its own', () => {
  it('writes the entry under the stage’s owner, on the catalogue the brand key signs', async () => {
    const { store, writes, gateway, publish } = await setup();
    const row = store.add(onOwnStage());

    const outcome = await publish.publish(TEST_OPERATOR, row.id);

    const entry = gateway.writes.at(-1)!.entries[0] as { owner: string };
    assert.equal(entry.owner, OWN_OWNER.slice(2));
    assert.equal(outcome.stream.owner, OWN_OWNER.slice(2));
    assert.equal(outcome.feed.owner, TEST_OWNER, 'the catalogue is the brand key’s');
    assert.equal(writes.records[0]!.owner, TEST_OWNER);
  });

  it('re-reads the owner at the claim of a draft with no recording, once the stage’s key was rotated', async () => {
    const { stages, store, gateway, publish } = await setup();
    const row = store.add(onOwnStage());
    await rotate(stages);

    const outcome = await publish.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.owner, ROTATED_OWNER.slice(2));
    assert.equal((gateway.writes.at(-1)!.entries[0] as { owner: string }).owner, ROTATED_OWNER.slice(2));
  });

  it('refuses a recorded draft whose stage now signs as another key, and writes nothing', async () => {
    const { stages, store, gateway, publish } = await setup();
    const row = store.add(onOwnStage({ manifest_index: 7, duration_seconds: 61 }));
    await rotate(stages);

    await assert.rejects(
      () => publish.publish(TEST_OPERATOR, row.id),
      (error: unknown) =>
        error instanceof FeedOwnerMismatchError &&
        error.streamOwner === OWN_OWNER.slice(2) &&
        error.stageId === STAGE_ID &&
        error.stageOwner === ROTATED_OWNER &&
        /recording was made under another key/.test(error.message),
    );
    assert.equal(gateway.writes.length, 0);
    assert.deepEqual(store.get(row.id), row, 'never claimed, owner kept');

    const refusal = answer(new FeedOwnerMismatchError(row.id, row.owner, STAGE_ID, ROTATED_OWNER));
    assert.equal(refusal.status, 409);
    assert.equal((refusal.body as { error: string }).error, 'feed_owner_mismatch');
  });

  it('publishes a recorded draft under the owner it was recorded as, while its stage still signs as that', async () => {
    const { store, gateway, publish } = await setup();
    const row = store.add(onOwnStage({ manifest_index: 7, duration_seconds: 61 }));

    const outcome = await publish.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.status, 'vod');
    assert.equal(outcome.stream.owner, row.owner);
    assert.equal((gateway.writes.at(-1)!.entries[0] as { owner: string }).owner, row.owner);
  });

  it('publishes a recorded draft older than stages on the brand-key stage it was given', async () => {
    const { store, streams, publish } = await setup();
    const row = store.add(recordedBeforeStages());
    await streams.update(TEST_OPERATOR, row.id, { ...FORM, stageId: BRAND_STAGE });

    const outcome = await publish.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.status, 'vod');
    assert.equal(outcome.stream.owner, TEST_OWNER);
  });

  it('takes off an entry a failed publish left under the pre-rotation owner, so the stream is listed once', async () => {
    const row = onOwnStage({ publish_error: 'the node timed out after it took the write' });
    const leftOver = { ...buildFeedEntry(row, null, 1), title: 'Left by the failed publish' };
    const foreign = { owner: asFeedOwner(FOREIGN_OWNER), topic: row.topic, title: 'Someone else’s' };
    const { stages, store, gateway, publish } = await setup(
      new FakeFeedGateway({ index: 3, entries: [leftOver, foreign] }),
    );
    store.add(row);
    await rotate(stages);

    await publish.publish(TEST_OPERATOR, row.id);

    const written = gateway.writes.at(-1)!.entries as { owner: string; topic: string }[];
    assert.deepEqual(
      written.map((entry) => entry.owner),
      [asFeedOwner(FOREIGN_OWNER), ROTATED_OWNER.slice(2)],
      'the left-over entry is gone, and an owner of nobody this admin knows is left',
    );
  });

  it('leaves the list alone for a draft whose last publish did not fail', async () => {
    const row = onOwnStage();
    const other = { ...buildFeedEntry(row, null, 1), owner: RETIRED_OWNER.slice(2) };
    const { store, gateway, publish } = await setup(new FakeFeedGateway({ index: 3, entries: [other] }));
    store.add(row);

    await publish.publish(TEST_OPERATOR, row.id);

    assert.equal((gateway.writes.at(-1)!.entries as unknown[]).length, 2);
  });

  it('leaves the owner alone at the claim of an unpublish', async () => {
    const { stages, store, publish } = await setup();
    const row = store.add(onOwnStage());
    await rotate(stages);

    const outcome = await publish.unpublish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.owner, OWN_OWNER.slice(2));
  });

  it('keeps the owner of a stream already published when the stage’s key is rotated', async () => {
    const { stages, store, publish } = await setup();
    const row = store.add(onOwnStage());
    await publish.publish(TEST_OPERATOR, row.id);
    await rotate(stages);

    const again = await publish.publish(TEST_OPERATOR, row.id);

    assert.equal(again.stream.status, 'published');
    assert.equal(again.stream.owner, OWN_OWNER.slice(2), 'publishing fixed it');
  });

  it('writes a state report of a stream on its own key, which the brand key does not sign', async () => {
    const { store, gateway, publish } = await setup();
    const row = store.add(onOwnStage({ status: 'live', live_since: new Date('2026-10-01T09:01:00.000Z') }));

    const outcome = await publish.republishWithState(UPLOADER, row);

    assert.equal(outcome.entryStatus, 'live');
    assert.equal((gateway.writes.at(-1)!.entries[0] as { owner: string }).owner, OWN_OWNER.slice(2));
  });
});

describe('reconcile with an owner per stage', () => {
  it('counts the brand key, every stage and a retired stage as ours, and leaves anyone else’s', async () => {
    const ghost = (owner: string, n: number) => ({ owner, topic: `9c1ac0de-0000-4000-8000-00000000000${n}` });
    const foreign = ghost(asFeedOwner(FOREIGN_OWNER), 4);
    const gateway = new FakeFeedGateway({
      index: 3,
      entries: [ghost(TEST_OWNER, 1), ghost(asFeedOwner(OWN_OWNER), 2), ghost(asFeedOwner(RETIRED_OWNER), 3), foreign],
    });
    const { store, publish } = await setup(gateway);
    const onStage = store.add(onOwnStage({ status: 'published', published_feed_index: 3 }));
    const onRetired = store.add(
      streamRow({ stage_id: RETIRED_STAGE, owner: asFeedOwner(RETIRED_OWNER), status: 'published' }),
    );
    const outcome = await publish.reconcile(TEST_OPERATOR);

    assert.deepEqual(outcome.removed, [ghost('', 1).topic, ghost('', 2).topic, ghost('', 3).topic]);
    assert.deepEqual(outcome.added, [onStage.topic, onRetired.topic]);
    const written = gateway.writes.at(-1)!.entries as { owner: string; topic: string }[];
    assert.deepEqual(written[0], foreign, 'an entry of nobody this admin knows is left as it is');
    assert.deepEqual(
      written.slice(1).map((entry) => entry.owner),
      [OWN_OWNER.slice(2), RETIRED_OWNER.slice(2)],
    );
  });

  it('adds a stream published under its stage’s key before the manager rotated it, under that key', async () => {
    const { stages, store, gateway, publish } = await setup(new FakeFeedGateway({ index: 3, entries: [] }));
    const row = store.add(
      streamRow({ stage_id: STAGE_ID, owner: asFeedOwner(PRE_ROTATION_OWNER), status: 'published' }),
    );
    await rotate(stages);

    const outcome = await publish.reconcile(TEST_OPERATOR);

    assert.deepEqual(outcome.added, [row.topic]);
    const written = gateway.writes.at(-1)!.entries as { owner: string; topic: string }[];
    assert.deepEqual(
      written.map((entry) => entry.owner),
      [asFeedOwner(PRE_ROTATION_OWNER)],
    );
  });

  it('rebuilds the stale entry of a stream under its stage’s pre-rotation key', async () => {
    const row = streamRow({ stage_id: STAGE_ID, owner: asFeedOwner(PRE_ROTATION_OWNER), status: 'published' });
    const stale = { ...buildFeedEntry(row, null, 1), title: 'Stale title' };
    const { stages, store, gateway, publish } = await setup(new FakeFeedGateway({ index: 3, entries: [stale] }));
    store.add(row);
    await rotate(stages);

    const outcome = await publish.reconcile(TEST_OPERATOR);

    assert.deepEqual(outcome.updated, [row.topic]);
    assert.deepEqual([outcome.added, outcome.removed], [[], []]);
    const written = gateway.writes.at(-1)!.entries as { owner: string; title: string }[];
    assert.equal(written.length, 1, 'rebuilt in place, not added a second time');
    assert.equal(written[0]!.title, row.title);
    assert.equal(written[0]!.owner, asFeedOwner(PRE_ROTATION_OWNER));
  });

  it('compares owners whatever their case and prefix', () => {
    const row = streamRow({ owner: asFeedOwner(OWN_OWNER), status: 'published' });
    const stale = { ...buildFeedEntry(row, null, 1), title: 'Stale', owner: OWN_OWNER.toUpperCase() };

    const plan = planReconcile([stale], [row], [TEST_OWNER, OWN_OWNER.toUpperCase()], 2);

    assert.deepEqual(plan.updated, [row.topic]);
    assert.deepEqual(plan.added, []);
  });
});
