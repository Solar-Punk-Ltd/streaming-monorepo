/**
 * A stream's stage: which stages a stream may be put on, when its stage may
 * change, that the change is audited, and that a draft with no stage is not
 * published. Unit test, against the in-memory stores and audit log. `pnpm test`.
 *
 * The rules, from docs/architecture/stages.md: a stage is picked from those
 * that are not retired and run SRS; it changes only while the stream is a
 * draft, because publishing fixes it; a stream that holds a recording keeps
 * its stage; and a stream already on a stage the manager retires later keeps
 * it. The conditional UPDATE holds the same rules against a race, and the fake
 * store holds them the way the SQL does; the SQL itself is pinned in
 * test/integration/streamRepository.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  StageLockedError,
  StageRequiredError,
  StageUnavailableError,
  StreamBusyError,
} from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { splitStageRecord } from '../../src/domain/StageService.js';
import {
  stageLockFor,
  StreamService,
  stageUnavailability,
  type StreamInputValues,
} from '../../src/domain/StreamService.js';

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

const SECOND_STAGE = '8c3f5d1b-4e5f-4061-9c73-3d4e5f607182';
const RETIRED_STAGE = '6a1d3b9f-2c3d-4e4f-9a51-1b2c3d4e5f60';
const OME_STAGE = '7b2e4c0a-3d4e-4f50-8b62-2c3d4e5f6071';
const UNKNOWN_STAGE = 'ffffffff-ffff-4fff-8fff-fffffffffff0';

/** The form exactly as `streamRow()` holds it, so a save of it changes nothing but what a test adds. */
const FORM: StreamInputValues = {
  title: 'Opening keynote',
  description: 'The opening talk.',
  tags: ['swarm'],
  mediaType: 'video',
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
};

async function setup() {
  const stages = new FakeStageStore();
  await stages.upsert(splitStageRecord(stageRecord()));
  await stages.upsert(splitStageRecord(stageRecord({ stageId: SECOND_STAGE, name: 'Second stage' })));
  await stages.upsert(splitStageRecord(stageRecord({ stageId: RETIRED_STAGE, name: 'Old stage' })));
  await stages.retire(RETIRED_STAGE, '2026-09-28T11:00:00.000Z');
  await stages.upsert(splitStageRecord(stageRecord({ stageId: OME_STAGE, name: 'OME stage', engine: 'ome' })));

  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const audit = new InMemoryAuditLog();
  const service = new StreamService(store, stages, feed, audit);
  const publish = new PublishService(
    store,
    renditions,
    stages,
    new FakeFeedWriteLog(),
    new FakeFeedGateway(),
    noCatalogueStamp(),
    feed,
    audit,
  );
  return { stages, store, audit, service, publish };
}

describe('stageUnavailability', () => {
  it('takes an active SRS stage, and says why it takes no other', async () => {
    const { stages } = await setup();

    assert.equal(stageUnavailability(await stages.find(STAGE_ID)), null);
    assert.equal(stageUnavailability(await stages.find(RETIRED_STAGE)), 'retired');
    assert.equal(stageUnavailability(await stages.find(OME_STAGE)), 'unsupported');
    assert.equal(stageUnavailability(null), 'unknown');
  });
});

describe('stageLockFor', () => {
  it('lets a draft move, and names no lock for a save that keeps the stage', () => {
    assert.equal(stageLockFor(streamRow(), SECOND_STAGE), null);
    assert.equal(stageLockFor(streamRow(), null), null);
    for (const status of ['published', 'live', 'vod', 'publishing'] as const) {
      assert.equal(stageLockFor(streamRow({ status }), STAGE_ID), null, status);
    }
  });

  it('locks every status but draft', () => {
    for (const status of ['published', 'live', 'vod', 'publishing'] as const) {
      assert.equal(stageLockFor(streamRow({ status }), SECOND_STAGE), 'published', status);
    }
  });

  it('keeps the stage of a draft that holds a recording, and lets one without a stage take its first', () => {
    const recorded = { manifest_index: 7, duration_seconds: 61 };

    assert.equal(stageLockFor(streamRow(recorded), SECOND_STAGE), 'recording');
    assert.equal(stageLockFor(streamRow(recorded), null), 'recording');
    assert.equal(stageLockFor(streamRow({ ...recorded, stage_id: null }), STAGE_ID), null);
  });
});

describe('StreamService on stages', () => {
  it('creates a stream on the stage the form names, and says so in its audit entry', async () => {
    const { audit, service } = await setup();

    const created = await service.create(TEST_OPERATOR, { ...FORM, stageId: STAGE_ID });

    assert.equal(created.stage_id, STAGE_ID);
    assert.deepEqual(audit.withAction('stream.create')[0]?.details, {
      title: 'Opening keynote',
      mediaType: 'video',
      stageId: STAGE_ID,
    });
  });

  it('refuses to create a stream on a stage that cannot take it, and creates nothing', async () => {
    const { store, audit, service } = await setup();

    for (const [stageId, reason] of [
      [RETIRED_STAGE, 'retired'],
      [OME_STAGE, 'unsupported'],
      [UNKNOWN_STAGE, 'unknown'],
    ] as const) {
      await assert.rejects(
        () => service.create(TEST_OPERATOR, { ...FORM, stageId }),
        (error: unknown) => error instanceof StageUnavailableError && error.reason === reason,
        reason,
      );
    }
    assert.equal(store.rows.size, 0);
    assert.deepEqual(audit.entries, []);
  });

  it('moves a draft to another stage and audits only the move, as stream.stage', async () => {
    const { store, audit, service } = await setup();
    const row = store.add(streamRow());

    const updated = await service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: SECOND_STAGE });

    assert.equal(updated.stage_id, SECOND_STAGE);
    assert.equal(updated.content_edited_at, null, 'a stage is not on the catalogue entry');
    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'stream.stage',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'draft',
        statusAfter: 'draft',
        details: { from: STAGE_ID, to: SECOND_STAGE },
      },
    ]);
  });

  it('audits a save that moved the stage and edited a field as two entries', async () => {
    const { store, audit, service } = await setup();
    const row = store.add(streamRow({ stage_id: null }));

    await service.update(TEST_OPERATOR, row.id, { ...FORM, title: 'Renamed', stageId: STAGE_ID });

    assert.deepEqual(
      audit.entries.map(({ action, details }) => ({ action, details })),
      [
        { action: 'stream.update', details: { changed: ['title'] } },
        { action: 'stream.stage', details: { from: null, to: STAGE_ID } },
      ],
    );
  });

  it('takes a draft off its stage', async () => {
    const { store, service } = await setup();
    const row = store.add(streamRow());

    assert.equal((await service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: null })).stage_id, null);
  });

  it('leaves the stage alone when the form does not name one', async () => {
    const { store, audit, service } = await setup();
    const row = store.add(streamRow({ status: 'published' }));

    const updated = await service.update(TEST_OPERATOR, row.id, FORM);

    assert.equal(updated.stage_id, STAGE_ID);
    assert.deepEqual(audit.entries, []);
  });

  it('refuses to move a stream that is not a draft, whatever it is', async () => {
    const { store, service } = await setup();

    for (const status of ['published', 'live', 'vod'] as const) {
      const row = store.add(streamRow({ status }));
      await assert.rejects(
        () => service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: SECOND_STAGE }),
        (error: unknown) => error instanceof StageLockedError && error.reason === 'published',
        status,
      );
      assert.equal(store.get(row.id).stage_id, STAGE_ID, status);
    }
  });

  it('keeps the stage of a draft that holds a recording', async () => {
    const { store, service } = await setup();
    const row = store.add(streamRow({ manifest_index: 7, duration_seconds: 61 }));

    await assert.rejects(
      () => service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: SECOND_STAGE }),
      (error: unknown) => error instanceof StageLockedError && error.reason === 'recording',
    );
    assert.equal(store.get(row.id).stage_id, STAGE_ID);
  });

  it('gives a recorded draft from before stages its first stage', async () => {
    const { store, service } = await setup();
    const row = store.add(streamRow({ stage_id: null, manifest_index: 7, duration_seconds: 61 }));

    assert.equal((await service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: STAGE_ID })).stage_id, STAGE_ID);
  });

  it('refuses to move a draft to a stage that cannot take it', async () => {
    const { store, service } = await setup();
    const row = store.add(streamRow());

    for (const stageId of [RETIRED_STAGE, OME_STAGE, UNKNOWN_STAGE]) {
      await assert.rejects(
        () => service.update(TEST_OPERATOR, row.id, { ...FORM, stageId }),
        StageUnavailableError,
        stageId,
      );
    }
    assert.equal(store.get(row.id).stage_id, STAGE_ID);
  });

  it('keeps a published stream on a stage the manager retired after it was published', async () => {
    const { stages, store, service } = await setup();
    const row = store.add(streamRow({ status: 'published' }));
    await stages.retire(STAGE_ID, '2026-09-28T12:00:00.000Z');

    const updated = await service.update(TEST_OPERATOR, row.id, { ...FORM, title: 'Renamed', stageId: STAGE_ID });

    assert.equal(updated.title, 'Renamed');
    assert.equal(updated.stage_id, STAGE_ID);
  });

  it('refuses the move of a draft that was published while the edit was on its way', async () => {
    const { store, service } = await setup();
    const row = store.add(streamRow());
    const update = store.update.bind(store);
    store.update = async (id, data, allowedFrom) => {
      store.add({ ...store.get(id), status: 'published', published_feed_index: 0 });
      return update(id, data, allowedFrom);
    };

    await assert.rejects(
      () => service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: SECOND_STAGE }),
      (error: unknown) => error instanceof StageLockedError && error.reason === 'published',
    );
    assert.equal(store.get(row.id).stage_id, STAGE_ID);
  });

  it('refuses the move to a stage the manager retired while the edit was on its way', async () => {
    const { stages, store, service } = await setup();
    store.stages = stages;
    const row = store.add(streamRow());
    const update = store.update.bind(store);
    store.update = async (id, data, allowedFrom) => {
      await stages.retire(SECOND_STAGE, '2026-09-28T12:00:00.000Z');
      return update(id, data, allowedFrom);
    };

    await assert.rejects(
      () => service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: SECOND_STAGE }),
      (error: unknown) => error instanceof StageUnavailableError && error.reason === 'retired',
    );
    assert.equal(store.get(row.id).stage_id, STAGE_ID);
  });

  it('reads a stage without its passphrase, on an edit and on a publish', async () => {
    const { stages, store, service, publish } = await setup();
    stages.find = () => Promise.reject(new Error('the passphrase is read'));
    const row = store.add(streamRow());

    await service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: SECOND_STAGE });
    await service.create(TEST_OPERATOR, { ...FORM, stageId: STAGE_ID });
    assert.equal((await publish.publish(TEST_OPERATOR, row.id)).stream.status, 'published');
  });

  it('answers stream_busy when a publish claimed the draft while the move was on its way', async () => {
    // The claim is released again, to a draft or back to published, so the
    // operator is told to try again rather than that the stage is fixed.
    const { store, service } = await setup();
    const row = store.add(streamRow());
    const update = store.update.bind(store);
    store.update = async (id, data, allowedFrom) => {
      store.add({ ...store.get(id), status: 'publishing' });
      return update(id, data, allowedFrom);
    };

    await assert.rejects(
      () => service.update(TEST_OPERATOR, row.id, { ...FORM, stageId: SECOND_STAGE }),
      StreamBusyError,
    );
  });
});

describe('PublishService on stages', () => {
  it('refuses to publish a draft with no stage, and leaves it a draft with nothing written', async () => {
    const { store, audit, publish } = await setup();
    const row = store.add(streamRow({ stage_id: null }));

    await assert.rejects(() => publish.publish(TEST_OPERATOR, row.id), StageRequiredError);

    assert.equal(store.get(row.id).status, 'draft');
    assert.equal(store.get(row.id).publish_error, null);
    assert.deepEqual(audit.entries, []);
  });

  it('refuses to publish a draft whose stage no longer takes streams, and writes nothing', async () => {
    const { store, audit, publish } = await setup();

    for (const [stageId, reason] of [
      [RETIRED_STAGE, 'retired'],
      [OME_STAGE, 'unsupported'],
      [UNKNOWN_STAGE, 'unknown'],
    ] as const) {
      const row = store.add(streamRow({ stage_id: stageId }));
      await assert.rejects(
        () => publish.publish(TEST_OPERATOR, row.id),
        (error: unknown) => error instanceof StageUnavailableError && error.reason === reason,
        reason,
      );
      assert.equal(store.get(row.id).status, 'draft', reason);
    }
    assert.deepEqual(audit.entries, []);
  });

  it('publishes a draft that holds a recording on a stage retired since, as that recording', async () => {
    const { store, publish } = await setup();
    const row = store.add(streamRow({ stage_id: RETIRED_STAGE, manifest_index: 7, duration_seconds: 61 }));

    const outcome = await publish.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.status, 'vod');
    assert.equal(outcome.stream.stage_id, RETIRED_STAGE);
  });

  it('publishes a draft on its stage', async () => {
    const { store, publish } = await setup();
    const row = store.add(streamRow());

    const outcome = await publish.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.status, 'published');
    assert.equal(outcome.stream.stage_id, STAGE_ID);
  });

  it('refuses a draft whose stage an edit took away between the read and the claim', async () => {
    const { store, publish } = await setup();
    const row = store.add(streamRow());
    const claim = store.claimForPublish.bind(store);
    store.claimForPublish = async (id, allowedFrom, draftNeedsStage) => {
      store.add({ ...store.get(id), stage_id: null });
      return claim(id, allowedFrom, draftNeedsStage);
    };

    await assert.rejects(() => publish.publish(TEST_OPERATOR, row.id), StageRequiredError);
    assert.equal(store.get(row.id).status, 'draft');
  });

  it('republishes a stream published before stages as it is', async () => {
    const { store, publish } = await setup();
    const row = store.add(streamRow({ stage_id: null }));
    store.add({ ...row, stage_id: STAGE_ID });
    await publish.publish(TEST_OPERATOR, row.id);
    store.add({ ...store.get(row.id), stage_id: null });

    const outcome = await publish.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.status, 'published');
    assert.equal(outcome.stream.stage_id, null);
  });

  it('unpublishes a draft with no stage, which was never on the feed', async () => {
    const { store, publish } = await setup();
    const row = store.add(streamRow({ stage_id: null }));

    assert.equal((await publish.unpublish(TEST_OPERATOR, row.id)).stream.status, 'draft');
  });
});
