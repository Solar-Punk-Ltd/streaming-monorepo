/**
 * A test stream and the catalogue. Unit test: PublishService against the in-memory FeedGateway and stores, no Bee and
 * no database. `pnpm test`.
 *
 * Pinned here (docs/architecture/test-streams.md, "Off the catalogue"): a test stream is never on the catalogue. A
 * publish, a republish and an unpublish of one are refused with `test_stream`, and so is a republish with its state.
 * The rows on the feed leave test streams out, so a reconcile adds no entry for a live or a recorded one and takes off
 * one an older admin left, the boot check counts such an entry as a ghost, and the rewrite a catalogue move makes after
 * its switch rebuilds none. The writer refuses a list that names a test stream it builds from, even when the rows on
 * the feed hold one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeedStreamEntry } from '@streaming-monorepo/web2-admin-common';

import { UPLOADER } from '../../src/domain/actor.js';
import { TestStreamError } from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { PublishService } from '../../src/domain/PublishService.js';
import type { StreamRow } from '../../src/types/index.js';

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
import { stagesWithMain } from './support/stageFakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

/** The rows on the feed by status alone, as they were chosen before there were test streams. */
class StatusOnlyFeedStore extends FakeStreamStore {
  override async listOnFeed(): Promise<StreamRow[]> {
    return [...this.rows.values()]
      .filter((row) => ['published', 'live', 'vod'].includes(row.status))
      .map((row) => ({ ...row }));
  }
}

function setup(makeStore: (renditions: FakeRenditionStore) => FakeStreamStore = (r) => new FakeStreamStore(r)) {
  const renditions = new FakeRenditionStore();
  const store = makeStore(renditions);
  const gateway = new FakeFeedGateway();
  const audit = new InMemoryAuditLog();
  const stages = stagesWithMain(undefined, { owner: `0x${TEST_OWNER}` });
  const service = new PublishService(
    store,
    renditions,
    stages,
    new FakeFeedWriteLog(),
    gateway,
    noCatalogueStamp(),
    feed,
    audit,
  );
  return { store, gateway, audit, service };
}

/** A test stream as the uploader's reports leave it: live, or recorded with its recording's place and length. */
function testStream(status: 'draft' | 'live' | 'vod'): StreamRow {
  return streamRow({
    test: true,
    status,
    description: '',
    tags: [],
    scheduled_start_time: null,
    ...(status === 'draft' ? {} : { live_since: new Date('2026-09-11T10:30:00.000Z') }),
    ...(status === 'vod'
      ? { manifest_index: 4, duration_seconds: 61, ended_at: new Date('2026-09-11T10:31:01.000Z') }
      : {}),
  });
}

/** As an older admin that knows no test streams leaves one it listed: its entry on the feed, its row a test stream. */
function markedTest(store: FakeStreamStore, id: string, status: 'live' | 'vod'): StreamRow {
  const row = store.get(id);
  return store.add({
    ...testStream(status),
    id: row.id,
    topic: row.topic,
    owner: row.owner,
    title: row.title,
  });
}

const entriesOf = (gateway: FakeFeedGateway): FeedStreamEntry[] =>
  (gateway.writes.at(-1)?.entries ?? []) as FeedStreamEntry[];

async function refused(work: Promise<unknown>, streamId: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof TestStreamError, `refused as a test stream, got ${String(error)}`);
    assert.equal(error.action, 'publish');
    assert.equal(error.streamId, streamId);
    return true;
  });
}

describe('a publish of a test stream', () => {
  it('is refused, as a republish and an unpublish are, with nothing written and no row changed', async () => {
    const { store, gateway, audit, service } = setup();
    const rows = [store.add(testStream('draft')), store.add(testStream('live')), store.add(testStream('vod'))];

    for (const row of rows) {
      await refused(service.publish(TEST_OPERATOR, row.id), row.id);
      await refused(service.unpublish(TEST_OPERATOR, row.id), row.id);
      assert.deepEqual(store.get(row.id), row, `the ${row.status} test stream is as it was`);
    }
    assert.equal(gateway.writes.length, 0, 'nothing was written');
    assert.deepEqual(audit.entries, [], 'and nothing audited');
  });

  it('is refused as a republish with its state, as a report or the archive switch would ask, recording nothing', async () => {
    const { store, gateway, service } = setup();
    const live = store.add(testStream('live'));
    const recorded = store.add(testStream('vod'));

    await refused(service.republishWithState(UPLOADER, live), live.id);
    await refused(service.republishWithState(TEST_OPERATOR, recorded), recorded.id);

    assert.equal(gateway.writes.length, 0, 'nothing was written');
    assert.deepEqual(store.get(live.id), live, 'no publish error was recorded on it');
    assert.deepEqual(store.get(recorded.id), recorded);
  });
});

describe('the rows on the feed', () => {
  it('leave a live and a recorded test stream out of a reconcile, which writes no entry for them', async () => {
    const { store, gateway, service } = setup();
    const listed = store.add(streamRow({ status: 'published', published_feed_index: 0 }));
    const live = store.add(testStream('live'));
    const recorded = store.add(testStream('vod'));

    const outcome = await service.reconcile(TEST_OPERATOR);

    assert.deepEqual(outcome.added, [listed.topic]);
    assert.deepEqual(
      entriesOf(gateway).map((entry) => entry.topic),
      [listed.topic],
    );
    assert.deepEqual(store.get(live.id), live, 'the live test stream is not recorded as on the catalogue');
    assert.deepEqual(store.get(recorded.id), recorded, 'nor the recorded one');
  });

  it('make the boot check count the entry an older admin left for a test stream as a ghost, writing nothing', async () => {
    const { store, gateway, service } = setup();
    const left = store.add(streamRow());
    await service.publish(TEST_OPERATOR, left.id);
    markedTest(store, left.id, 'vod');

    const check = await service.checkFeedOnBoot();

    assert.deepEqual(check.ghosts, [left.topic]);
    assert.equal(gateway.writes.length, 1, 'the dry run writes nothing');
  });

  it('let a reconcile take off the entry an older admin left for a test stream', async () => {
    const { store, gateway, service } = setup();
    const kept = store.add(streamRow());
    const left = store.add(streamRow());
    await service.publish(TEST_OPERATOR, kept.id);
    await service.publish(TEST_OPERATOR, left.id);
    const live = markedTest(store, left.id, 'live');

    const outcome = await service.reconcile(TEST_OPERATOR);

    assert.deepEqual(outcome.removed, [left.topic]);
    assert.deepEqual(outcome.added, []);
    assert.deepEqual(
      entriesOf(gateway).map((entry) => entry.topic),
      [kept.topic],
    );
    assert.deepEqual(store.get(left.id), live, 'the test stream is not recorded as on the catalogue');
  });

  it('rebuild no entry for a test stream when a catalogue move rewrites entries after its switch', async () => {
    const { store, gateway, service } = setup();
    const listed = store.add(streamRow());
    const left = store.add(streamRow());
    await service.publish(TEST_OPERATOR, listed.id);
    await service.publish(TEST_OPERATOR, left.id);
    const entryLeft = entriesOf(gateway).find((entry) => entry.topic === left.topic);
    const live = markedTest(store, left.id, 'live');
    // An edit the entry does not carry yet, so the rewrite has one entry to rebuild.
    store.add({ ...store.get(listed.id), title: 'Opening keynote, moved' });

    const index = await service.rewriteEntriesHeld(TEST_OPERATOR, [left.id, listed.id]);

    assert.equal(index, 2);
    const entries = entriesOf(gateway);
    assert.equal(entries.find((entry) => entry.topic === listed.topic)?.title, 'Opening keynote, moved');
    assert.deepEqual(
      entries.find((entry) => entry.topic === left.topic),
      entryLeft,
      'the entry the older admin left is not rebuilt from the test stream',
    );
    assert.deepEqual(store.get(left.id), live, 'and the test stream is not recorded as on the catalogue');
  });
});

describe('the catalogue writer', () => {
  it('refuses a list that names a test stream, even when the rows on the feed hold one, and writes nothing', async () => {
    const { store, gateway, service } = setup((renditions) => new StatusOnlyFeedStore(renditions));
    store.add(streamRow({ status: 'published', published_feed_index: 0 }));
    const live = store.add(testStream('live'));

    await refused(service.reconcile(TEST_OPERATOR), live.id);

    assert.equal(gateway.writes.length, 0, 'nothing was written');
    assert.deepEqual(store.get(live.id), live);
  });
});
