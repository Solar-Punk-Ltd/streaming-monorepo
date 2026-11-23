/**
 * A test stream's life in the services, against the in-memory ports. Unit test — no Bee, no database. `pnpm test`.
 *
 * A test stream is created with a title, a media type and a stage, is a draft the stage's uploader is answered about,
 * goes live and is recorded on the uploader's reports, and writes nothing to the catalogue at any step. Its quality
 * reports are answered with the stream's order number as `feed.index`, so the uploader keeps the newest merge.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Rendition, TestStreamInput } from '@streaming-monorepo/web2-admin-common';

import {
  InvalidStateError,
  StageUnavailableError,
  StreamLiveError,
  StreamNotFoundError,
  TestStreamError,
} from '../../src/domain/errors/index.js';
import { NotTestStreamError } from '../../src/domain/errors/NotTestStreamError.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import { IngestService } from '../../src/domain/IngestService.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { LadderService } from '../../src/domain/LadderService.js';
import { Mutex } from '../../src/domain/Mutex.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { StreamFinishService } from '../../src/domain/StreamFinishService.js';
import { StreamService } from '../../src/domain/StreamService.js';
import { StreamStateService } from '../../src/domain/StreamStateService.js';

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
import { ON_STAGE, STAGE_ID, stagesWithMain } from './support/stageFakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

function rung(name: string, height: number, final?: { index: number; duration: number }): Rendition {
  return {
    name,
    width: Math.round((height * 16) / 9),
    height,
    topic: `bbbbbbbb-0000-4000-8000-0000000${String(height).padStart(5, '0')}`,
    bandwidth: height * 4000,
    avgBandwidth: height * 3000,
    ...(final ?? {}),
  };
}

const INPUT: TestStreamInput = { title: 'Sound check', mediaType: 'video', stageId: STAGE_ID };

function setup() {
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const gateway = new FakeFeedGateway();
  const feedWrites = new FakeFeedWriteLog();
  const audit = new InMemoryAuditLog();
  const stages = stagesWithMain();
  const mutex = new Mutex();
  const publishService = new PublishService(
    store,
    renditions,
    stages,
    feedWrites,
    gateway,
    noCatalogueStamp(),
    feed,
    audit,
    mutex,
  );
  const testStreams = { feed, mutex };
  const streams = new StreamService(store, stages, feed, audit);
  const state = new StreamStateService(store, publishService, audit, undefined, testStreams);
  const ladder = new LadderService(store, renditions, publishService, audit, testStreams);
  const ingest = new IngestService(store, stages, audit);
  const finish = new StreamFinishService(store, ingest, audit, 30);
  return { store, renditions, gateway, feedWrites, audit, streams, state, ladder, ingest, finish };
}

describe('creating a test stream', () => {
  it('marks it a test, on its stage, with an empty description, no tags and no scheduled start', async () => {
    const { streams, audit } = setup();

    const created = await streams.createTest(TEST_OPERATOR, INPUT);

    assert.equal(created.test, true);
    assert.equal(created.status, 'draft');
    assert.equal(created.title, 'Sound check');
    assert.equal(created.media_type, 'video');
    assert.equal(created.stage_id, STAGE_ID);
    assert.equal(created.description, '');
    assert.deepEqual(created.tags, []);
    assert.equal(created.scheduled_start_time, null);
    assert.equal(created.viewer_url, null);
    const [entry] = audit.withAction('stream.create');
    assert.equal(entry?.streamId, created.id);
    assert.equal(entry?.details?.test, true);
  });

  it('refuses a stage that takes no streams, as for any stream', async () => {
    const { streams } = setup();

    await assert.rejects(
      () => streams.createTest(TEST_OPERATOR, { ...INPUT, stageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
      (err: unknown) => err instanceof StageUnavailableError && err.reason === 'unknown',
    );
  });
});

describe('what a test stream refuses', () => {
  it('refuses an edit with the test stream refusal, and leaves the row as it was', async () => {
    const { streams, store } = setup();
    const test = await streams.createTest(TEST_OPERATOR, INPUT);

    await assert.rejects(
      () =>
        streams.update(TEST_OPERATOR, test.id, {
          title: 'Renamed',
          description: 'Now with a description.',
          tags: [],
          mediaType: 'audio',
          scheduledStartTime: '2026-12-01T09:00:00.000Z',
        }),
      (err: unknown) => err instanceof TestStreamError && err.action === 'edit',
    );
    assert.equal(store.get(test.id).title, 'Sound check');
  });

  it('refuses an image with the test stream refusal', async () => {
    const { streams, store } = setup();
    const test = await streams.createTest(TEST_OPERATOR, INPUT);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

    await assert.rejects(
      () => streams.setThumbnail(TEST_OPERATOR, test.id, 'image/png', png),
      (err: unknown) => err instanceof TestStreamError && err.action === 'thumbnail',
    );
    assert.equal(store.get(test.id).has_thumbnail, false);
  });
});

describe('deleting a test stream', () => {
  it('deletes a recorded one, which has nothing to unpublish', async () => {
    const { streams, store, audit } = setup();
    const test = store.add(streamRow({ test: true, status: 'vod', description: '', manifest_index: 4 }));

    await streams.remove(TEST_OPERATOR, test.id);

    assert.equal(store.rows.has(test.id), false);
    const [entry] = audit.withAction('stream.delete');
    assert.equal(entry?.statusBefore, 'vod');
    assert.equal(entry?.details?.test, true);
  });

  it('refuses a live one', async () => {
    const { streams, store } = setup();
    const test = store.add(streamRow({ test: true, status: 'live', description: '' }));

    await assert.rejects(() => streams.remove(TEST_OPERATOR, test.id), StreamLiveError);
    assert.equal(store.rows.has(test.id), true);
  });

  it('still refuses a recorded stream that is no test until it is unpublished', async () => {
    const { streams, store } = setup();
    const listed = store.add(streamRow({ status: 'vod', manifest_index: 4, published_feed_index: 3 }));

    await assert.rejects(() => streams.remove(TEST_OPERATOR, listed.id));
    assert.equal(store.rows.has(listed.id), true);
  });
});

describe("a test stream's viewer address", () => {
  it('is stored as given, changed, and cleared, and each set is audited', async () => {
    const { streams, audit } = setup();
    const test = await streams.createTest(TEST_OPERATOR, INPUT);

    const set = await streams.setViewerUrl(TEST_OPERATOR, test.id, '  http://203.0.113.7:10004/#/  ');
    assert.equal(set.viewer_url, 'http://203.0.113.7:10004/#/');
    const changed = await streams.setViewerUrl(TEST_OPERATOR, test.id, 'https://team.example.com/viewer');
    assert.equal(changed.viewer_url, 'https://team.example.com/viewer');
    const cleared = await streams.setViewerUrl(TEST_OPERATOR, test.id, '');
    assert.equal(cleared.viewer_url, null);

    const entries = audit.withAction('stream.viewer_url.set');
    assert.deepEqual(
      entries.map((entry) => entry.details?.viewerUrl),
      ['http://203.0.113.7:10004/#/', 'https://team.example.com/viewer', null],
    );
    assert.ok(entries.every((entry) => entry.details?.test === true && entry.streamId === test.id));
  });

  it('is taken while the test stream is a draft, live and recorded', async () => {
    const { streams, store } = setup();
    for (const status of ['draft', 'live', 'vod'] as const) {
      const test = store.add(streamRow({ test: true, status, description: '' }));
      const set = await streams.setViewerUrl(TEST_OPERATOR, test.id, 'http://203.0.113.7:10004');
      assert.equal(set.viewer_url, 'http://203.0.113.7:10004', status);
    }
  });

  it('is refused for a stream that is no test stream', async () => {
    const { streams, store, audit } = setup();
    const listed = store.add(streamRow());

    await assert.rejects(
      () => streams.setViewerUrl(TEST_OPERATOR, listed.id, 'http://203.0.113.7:10004'),
      NotTestStreamError,
    );
    assert.equal(store.get(listed.id).viewer_url, null);
    assert.deepEqual(audit.withAction('stream.viewer_url.set'), []);
  });

  it('is 404 for a stream that does not exist', async () => {
    const { streams } = setup();

    await assert.rejects(
      () => streams.setViewerUrl(TEST_OPERATOR, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'http://203.0.113.7'),
      StreamNotFoundError,
    );
  });
});

describe("a test stream's life on its stage", () => {
  it('is looked up as a draft, and while another stream on its stage is live', async () => {
    const { streams, state, store } = setup();
    const test = await streams.createTest(TEST_OPERATOR, INPUT);
    store.add(streamRow({ status: 'live' }));

    const found = await state.lookupByIngest('video', test.topic, ON_STAGE);

    assert.equal(found.id, test.id);
  });

  it('still refuses a draft that is no test stream', async () => {
    const { state, store } = setup();
    const draft = store.add(streamRow());

    await assert.rejects(() => state.lookupByIngest('video', draft.topic, ON_STAGE), StreamNotFoundError);
  });

  it('goes from draft to live to recorded and back to live, with no catalogue write at any step', async () => {
    const { streams, state, ladder, store, gateway, feedWrites, audit } = setup();
    const test = await streams.createTest(TEST_OPERATOR, INPUT);

    const live = await state.report(test.id, { state: 'live' }, ON_STAGE);
    assert.equal(live.stream.status, 'live');
    assert.equal(live.written, false);
    assert.equal(live.feed.index, 1);
    assert.equal(live.feed.entryCount, 0);
    assert.deepEqual([live.feed.owner, live.feed.topic, live.feed.topicHex], [feed.owner, feed.topic, feed.topicHex]);

    const first = await ladder.report(test.id, rung('360p', 360), ON_STAGE);
    assert.equal(first.publish.feed.index, 2);
    assert.equal(first.publish.written, false);
    assert.deepEqual(
      first.renditions.map((r) => r.name),
      ['360p'],
    );
    const final = await ladder.report(test.id, rung('360p', 360, { index: 9, duration: 30 }), ON_STAGE);
    assert.equal(final.ladder.finished, true);
    assert.equal(final.ladder.flippedToFinished, true);
    assert.equal(final.ladder.duration, 30);

    const vod = await state.report(test.id, { state: 'vod', index: 5, duration: 30 }, ON_STAGE);
    assert.equal(vod.stream.status, 'vod');
    assert.equal(vod.stream.manifest_index, 5);
    assert.equal(vod.feed.index, 4);
    const after = await ladder.report(test.id, rung('360p', 360, { index: 9, duration: 30 }), ON_STAGE);
    assert.equal(after.publish.stream.status, 'vod', 'its quality reports are answered as recorded from then on');

    const again = await state.report(test.id, { state: 'live' }, ON_STAGE);
    assert.equal(again.stream.status, 'live');

    assert.deepEqual(gateway.writes, [], 'nothing was written to the catalogue');
    assert.equal(await feedWrites.lastWrite(feed.owner, feed.topicHex), null);
    const row = store.get(test.id);
    assert.equal(row.published_feed_index, null);
    assert.equal(row.published_at, null);
    assert.equal(row.report_order, 6);
    for (const action of ['stream.state.live', 'stream.state.vod', 'stream.rendition.report'] as const) {
      for (const entry of audit.withAction(action)) {
        assert.equal(entry.details?.test, true, action);
        assert.equal(entry.details?.written, false, action);
      }
    }
  });

  it('answers concurrent quality reports in merge order: a higher order number never holds an older merge', async () => {
    const { streams, state, ladder } = setup();
    const test = await streams.createTest(TEST_OPERATOR, INPUT);
    await state.report(test.id, { state: 'live' }, ON_STAGE);

    const rungs = [rung('360p', 360), rung('480p', 480), rung('720p', 720), rung('1080p', 1080)];
    const answers = await Promise.all(rungs.map((r) => ladder.report(test.id, r, ON_STAGE)));

    const byOrder = [...answers].sort((a, b) => a.publish.feed.index - b.publish.feed.index);
    assert.deepEqual(
      byOrder.map((answer) => answer.publish.feed.index),
      [2, 3, 4, 5],
      'every report takes its own number',
    );
    for (let i = 1; i < byOrder.length; i++) {
      const before = new Set(byOrder[i - 1]!.renditions.map((r) => r.name));
      const later = new Set(byOrder[i]!.renditions.map((r) => r.name));
      assert.ok(
        [...before].every((name) => later.has(name)),
        'a later number holds every rung an earlier one did',
      );
      assert.equal(later.size, before.size + 1);
    }
  });

  it('refuses the reports of a test stream on another stage, and of one with no stage', async () => {
    const { state, ladder, store } = setup();
    const elsewhere = store.add(
      streamRow({ test: true, description: '', stage_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    );
    const stageless = store.add(streamRow({ test: true, description: '', stage_id: null }));

    for (const row of [elsewhere, stageless]) {
      await assert.rejects(() => state.report(row.id, { state: 'live' }, ON_STAGE), StreamNotFoundError);
      await assert.rejects(() => ladder.report(row.id, rung('360p', 360), ON_STAGE), StreamNotFoundError);
    }
  });

  it('still refuses a quality report of a draft that is no test stream', async () => {
    const { ladder, store } = setup();
    const draft = store.add(streamRow());

    await assert.rejects(() => ladder.report(draft.id, rung('360p', 360), ON_STAGE), InvalidStateError);
  });
});

describe("a test stream's audit rows", () => {
  it("say it is a test on a key rotation, a Finish and the key change at the restart window's end", async () => {
    const { store, ingest, finish, audit } = setup();
    const rotated = store.add(streamRow({ test: true, status: 'draft', description: '' }));
    const finished = store.add(streamRow({ test: true, status: 'vod', description: '', manifest_index: 3 }));
    const windowRanOut = store.add(
      streamRow({ test: true, status: 'vod', description: '', manifest_index: 4, ended_at: new Date(0) }),
    );

    await ingest.rotateKey(TEST_OPERATOR, rotated.id);
    await finish.finish(TEST_OPERATOR, finished.id);
    await finish.finishEnded();

    assert.equal(audit.withAction('stream.key.rotate')[0]?.details?.test, true);
    assert.equal(audit.withAction('stream.finish')[0]?.details?.test, true);
    const [swept] = audit.withAction('stream.finish.window');
    assert.equal(swept?.streamId, windowRanOut.id);
    assert.equal(swept?.details?.test, true);
  });

  it('carry no test mark for a stream that is no test stream', async () => {
    const { store, ingest, audit } = setup();
    const listed = store.add(streamRow());

    await ingest.rotateKey(TEST_OPERATOR, listed.id);

    assert.equal(audit.withAction('stream.key.rotate')[0]?.details?.test, undefined);
  });
});
