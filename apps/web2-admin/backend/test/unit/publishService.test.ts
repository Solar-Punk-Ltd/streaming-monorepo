/**
 * Publishing, against the in-memory FeedGateway. Unit test — no Bee, no
 * database. `pnpm test`.
 *
 * This is the part of the backend with the most ways to be quietly wrong: the
 * feed is a single-writer, read-modify-write structure whose payload is the
 * whole catalog. So the tests below pin, in order: that an entry is appended,
 * that republishing replaces it instead of duplicating it, that indexes only
 * ever go forward (including when two requests overlap), that entries this
 * backend did not write survive a rewrite byte for byte, that unpublishing
 * removes exactly one entry, and that a failed write leaves the row where it
 * was with the reason recorded rather than half-published.
 *
 * The last three suites are the ones added after the catalogue was found
 * forked in production: that a feed lookup which lags its own writes no longer
 * decides the next index, that the boot check notices a head it did not write,
 * and that `reconcile` can take an entry off the feed that no request can name.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeedStreamEntry } from '@streaming-monorepo/web2-admin-common';

import {
  FeedOwnerMismatchError,
  PublishFailedError,
  StreamBusyError,
  StreamLiveError,
  StreamNotFoundError,
  ThumbnailCheckError,
} from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { hasUnpublishedEdits } from '../../src/domain/unpublishedEdits.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  streamRow,
  TEST_OWNER,
  TEST_USER_ID,
} from './support/fakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

/** One rung of a ladder, as the uploader reports it; `index` set marks it finished. */
const rung = (name: string, height: number, index?: number) => ({
  name,
  width: (height * 16) / 9,
  height,
  topic: `bbbbbbbb-0000-4000-8000-0000000${String(height).padStart(5, '0')}`,
  bandwidth: height * 4000,
  avgBandwidth: height * 3000,
  ...(index === undefined ? {} : { index, duration: 61 }),
});

function setup(gateway = new FakeFeedGateway()) {
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const writes = new FakeFeedWriteLog();
  const service = new PublishService(store, renditions, writes, gateway, feed);
  return { store, renditions, writes, gateway, service };
}

const entriesOf = (gateway: FakeFeedGateway): FeedStreamEntry[] =>
  (gateway.writes.at(-1)?.entries ?? []) as FeedStreamEntry[];

describe('PublishService.publish', () => {
  it('appends an entry at index 0 on an empty feed', async () => {
    const { store, writes, gateway, service } = setup();
    const row = store.add(streamRow());

    const outcome = await service.publish(row.id, TEST_USER_ID);

    assert.equal(outcome.feed.index, 0);
    assert.equal(outcome.feed.entryCount, 1);
    assert.equal(outcome.feed.owner, TEST_OWNER);
    assert.equal(outcome.feed.topic, 'swarm-stream');
    assert.equal(outcome.stream.status, 'published');
    assert.equal(outcome.stream.published_feed_index, 0);
    assert.equal(outcome.stream.publish_error, null);
    assert.ok(outcome.stream.published_at);

    assert.equal(gateway.writes.length, 1);
    const [entry] = entriesOf(gateway);
    assert.deepEqual(entry, {
      owner: TEST_OWNER,
      topic: row.topic,
      title: 'Pilot keynote',
      description: 'The opening talk.',
      tags: ['swarm'],
      state: 'scheduled',
      mediatype: 'video',
      thumbnail: '',
      scheduledStartTime: '2026-10-01T09:00:00.000Z',
      timestamp: entry!.timestamp,
    });
    assert.ok(entry!.timestamp > 0, 'timestamp is ms since epoch');

    // The log row now names the feed it belongs to and the chunk the node
    // returned: since the next index is read back out of this table, a row
    // that cannot say which feed key it was written under is useless.
    assert.deepEqual(writes.records, [
      {
        owner: TEST_OWNER,
        topic: feed.topicHex,
        feedIndex: 0,
        entryCount: 1,
        payload: gateway.writes[0]!.entries,
        reference: gateway.writes[0]!.reference,
      },
    ]);
  });

  it('replaces its own entry in place on a republish, and advances the index', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow());

    await service.publish(row.id, TEST_USER_ID);
    const republished = await service.publish(row.id, TEST_USER_ID);

    assert.equal(republished.feed.index, 1);
    assert.equal(republished.feed.entryCount, 1, 'not duplicated');
    assert.equal(gateway.writes.length, 2);
    assert.equal(entriesOf(gateway).length, 1);
  });

  it('picks up edits made between two publishes', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);

    store.add({ ...store.get(row.id), title: 'Pilot closing', status: 'published' });
    await service.publish(row.id, TEST_USER_ID);

    assert.equal(entriesOf(gateway)[0]!.title, 'Pilot closing');
  });

  it('keeps entries it did not write, including ones it cannot parse', async () => {
    const foreign = {
      owner: 'ffffffffffffffffffffffffffffffffffffffff',
      topic: '9c1ac0de-0000-4000-8000-000000000001',
      title: 'Someone else',
      state: 'live',
    };
    const nonsense = 'not an entry at all';
    const gateway = new FakeFeedGateway({
      index: 7,
      entries: [foreign, nonsense],
    });
    const { store, service } = setup(gateway);
    const row = store.add(streamRow());

    const outcome = await service.publish(row.id, TEST_USER_ID);

    assert.equal(outcome.feed.index, 8, 'continues the existing feed');
    assert.equal(outcome.feed.entryCount, 3);
    const written = gateway.writes[0]!.entries;
    assert.deepEqual(written[0], foreign, 'foreign entry untouched');
    assert.equal(written[1], nonsense, 'unparseable element untouched');
    assert.equal((written[2] as FeedStreamEntry).topic, row.topic);
  });

  it('serialises overlapping publishes onto consecutive indexes', async () => {
    // Without the mutex both would read the same head and write the same
    // index, which forks the feed.
    const { store, gateway, service } = setup();
    const first = store.add(streamRow());
    const second = store.add(streamRow());

    const [a, b] = await Promise.all([
      service.publish(first.id, TEST_USER_ID),
      service.publish(second.id, TEST_USER_ID),
    ]);

    assert.deepEqual([a.feed.index, b.feed.index].sort(), [0, 1]);
    assert.equal(gateway.writes.length, 2);
    assert.equal(entriesOf(gateway).length, 2, 'both streams on the feed');
  });

  it('uploads a stored thumbnail once and reuses the reference', async () => {
    const { store, gateway, service } = setup();
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const row = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), {
      thumbnail: bytes,
      thumbnail_mime: 'image/png',
    });

    const first = await service.publish(row.id, TEST_USER_ID);
    assert.equal(gateway.thumbnails.length, 1);
    assert.deepEqual(gateway.thumbnails[0], {
      filename: `${row.topic}.png`,
      contentType: 'image/png',
      size: bytes.length,
    });
    assert.match(first.stream.thumbnail_ref ?? '', /^[0-9a-f]{64}$/);
    assert.equal(entriesOf(gateway)[0]!.thumbnail, first.stream.thumbnail_ref);

    const second = await service.publish(row.id, TEST_USER_ID);
    assert.equal(gateway.thumbnails.length, 1, 'not uploaded again');
    assert.equal(second.stream.thumbnail_ref, first.stream.thumbnail_ref);
  });

  it('re-uploads a thumbnail the gateway no longer holds', async () => {
    // How production broke: a reference minted under FEED_GATEWAY=fake was
    // persisted, and every republish under `bee` carried that fabrication onto
    // the feed, where it resolves to a 404 for every viewer.
    const { store, gateway, service } = setup();
    const stale = 'a'.repeat(64);
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const row = store.add(
      streamRow({
        has_thumbnail: true,
        thumbnail_mime: 'image/png',
        thumbnail_ref: stale,
        status: 'published',
        published_feed_index: 0,
      }),
      { thumbnail: bytes, thumbnail_mime: 'image/png' },
    );

    const outcome = await service.publish(row.id, TEST_USER_ID);

    assert.equal(gateway.thumbnails.length, 1, 're-uploaded');
    const fresh = outcome.stream.thumbnail_ref;
    assert.match(fresh ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(fresh, stale);
    assert.equal(entriesOf(gateway)[0]!.thumbnail, fresh, 'the feed gets the new one');
    assert.equal(store.get(row.id).thumbnail_ref, fresh, 'persisted');
    assert.ok(await gateway.hasReference(fresh!));
  });

  it('fails the publish when the gateway cannot say whether it holds the thumbnail', async () => {
    // "Unreachable" is not "missing": re-uploading on every hiccup spends a
    // stamp for nothing, so the publish stops and the operator retries.
    const { store, writes, gateway, service } = setup();
    const stale = 'b'.repeat(64);
    const row = store.add(
      streamRow({
        has_thumbnail: true,
        thumbnail_mime: 'image/png',
        thumbnail_ref: stale,
        status: 'published',
        published_feed_index: 2,
      }),
      { thumbnail: Buffer.from([1, 2, 3]), thumbnail_mime: 'image/png' },
    );
    gateway.failNextHasReference = new ThumbnailCheckError(stale, 'fetch failed');

    await assert.rejects(
      () => service.publish(row.id, TEST_USER_ID),
      (err: unknown) =>
        err instanceof PublishFailedError && err.reason.includes(stale) && err.reason.includes('fetch failed'),
    );

    const after = store.get(row.id);
    assert.equal(after.status, 'published', 'previous status restored');
    assert.equal(after.thumbnail_ref, stale, 'not cleared on a check that failed');
    assert.equal(gateway.thumbnails.length, 0, 'nothing re-uploaded');
    assert.equal(gateway.writes.length, 0, 'nothing written to the feed');
    assert.equal(writes.records.length, 0);
  });

  it('keeps an uploaded thumbnail reference when the feed write fails', async () => {
    // The chunk is paid for the moment the upload returns, so a publish that
    // fails afterwards must not make the retry upload the same image again.
    const { store, gateway, service } = setup();
    const row = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), {
      thumbnail: Buffer.from([1, 2, 3]),
      thumbnail_mime: 'image/png',
    });
    gateway.failNextWrite = new Error('postage batch not usable');

    await assert.rejects(() => service.publish(row.id, TEST_USER_ID), PublishFailedError);
    assert.equal(gateway.thumbnails.length, 1);
    const afterFailure = store.get(row.id);
    assert.match(afterFailure.thumbnail_ref ?? '', /^[0-9a-f]{64}$/);

    await service.publish(row.id, TEST_USER_ID);
    assert.equal(gateway.thumbnails.length, 1, 'not uploaded again on the retry');
  });

  it('refuses a stream that is already publishing', async () => {
    const { store, service } = setup();
    const row = store.add(streamRow({ status: 'publishing' }));

    await assert.rejects(
      () => service.publish(row.id, TEST_USER_ID),
      (err: unknown) => err instanceof StreamBusyError && err.currentStatus === 'publishing',
    );
  });

  it('refuses a stream that belongs to someone else', async () => {
    const { store, service } = setup();
    const row = store.add(streamRow());

    await assert.rejects(() => service.publish(row.id, '00000000-0000-4000-8000-0000000000ff'), StreamNotFoundError);
  });

  it('refuses a stream created under a different feed owner', async () => {
    // The entry carries the row's owner while the gateway signs with the
    // configured key; after a key rotation, publishing would advertise an
    // owner the feed is not published under.
    const { store, gateway, service } = setup();
    const row = store.add(streamRow({ owner: 'f'.repeat(40) }));

    await assert.rejects(
      () => service.publish(row.id, TEST_USER_ID),
      (err: unknown) =>
        err instanceof FeedOwnerMismatchError && err.streamOwner === 'f'.repeat(40) && err.feedOwner === TEST_OWNER,
    );
    assert.equal(gateway.writes.length, 0);
    assert.equal(store.get(row.id).status, 'draft', 'never even claimed');
  });

  it('matches the owner case-insensitively', async () => {
    const { store, service } = setup();
    const row = store.add(streamRow({ owner: TEST_OWNER.toUpperCase() }));
    const outcome = await service.publish(row.id, TEST_USER_ID);
    assert.equal(outcome.stream.status, 'published');
  });

  it('restores the previous status and records why, on a failed feed write', async () => {
    const { store, writes, gateway, service } = setup();
    const row = store.add(streamRow());
    gateway.failNextWrite = new Error('postage batch not usable');

    await assert.rejects(
      () => service.publish(row.id, TEST_USER_ID),
      (err: unknown) => err instanceof PublishFailedError && err.reason === 'postage batch not usable',
    );

    const after = store.get(row.id);
    assert.equal(after.status, 'draft');
    assert.equal(after.publish_error, 'postage batch not usable');
    assert.equal(after.published_feed_index, null);
    assert.equal(gateway.writes.length, 0);
    assert.equal(writes.records.length, 0, 'nothing logged for a write that failed');
  });

  it('restores `published`, not `draft`, when a republish fails', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow({ status: 'published', published_feed_index: 3 }));
    gateway.failNextRead = new Error('bee unreachable');

    await assert.rejects(() => service.publish(row.id, TEST_USER_ID), PublishFailedError);

    const after = store.get(row.id);
    assert.equal(after.status, 'published');
    assert.equal(after.publish_error, 'bee unreachable');
  });

  it('reports the original failure even when the status cannot be restored', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow());
    gateway.failNextWrite = new Error('postage batch not usable');
    store.failNextFailPublish = new Error('connection terminated');

    await assert.rejects(
      () => service.publish(row.id, TEST_USER_ID),
      (err: unknown) => err instanceof PublishFailedError && err.reason === 'postage batch not usable',
    );
    assert.equal(store.get(row.id).status, 'publishing', 'boot clears this');
  });

  it('does not leave the mutex held after a failure', async () => {
    const { store, gateway, service } = setup();
    const failing = store.add(streamRow());
    const fine = store.add(streamRow());
    gateway.failNextWrite = new Error('postage batch not usable');

    await assert.rejects(() => service.publish(failing.id, TEST_USER_ID));
    const outcome = await service.publish(fine.id, TEST_USER_ID);
    assert.equal(outcome.feed.index, 0);
  });
});

describe('PublishService republishing a stream that has gone live', () => {
  it('rewrites the entry as live without touching the status', async () => {
    // The state is already on the row: the report wrote it, and this call only
    // makes the catalogue say the same thing. A `publishing` claim here would
    // come back as `published` and tell every viewer the broadcast stopped.
    const { store, gateway, service } = setup();
    const row = store.add(
      streamRow({
        status: 'live',
        published_feed_index: 3,
        live_since: new Date('2026-10-01T09:01:00.000Z'),
      }),
    );

    const outcome = await service.republishWithState(store.get(row.id));

    assert.equal(outcome.stream.status, 'live');
    assert.equal(outcome.stream.published_feed_index, outcome.feed.index);
    assert.equal(outcome.stream.publish_error, null);
    assert.equal(entriesOf(gateway)[0]!.state, 'live');
    assert.equal(store.get(row.id).status, 'live', 'never claimed');
  });

  it('carries the manifest index and duration onto a vod entry', async () => {
    const { store, service, gateway } = setup();
    const row = store.add(
      streamRow({
        status: 'vod',
        manifest_index: 412,
        duration_seconds: 3725.5,
        published_feed_index: 3,
      }),
    );

    await service.republishWithState(store.get(row.id));

    const [entry] = entriesOf(gateway);
    assert.equal(entry!.state, 'vod');
    assert.equal(entry!.index, 412);
    assert.equal(entry!.duration, 3725.5);
  });

  it('keeps the reported state when the feed write fails', async () => {
    // This is the whole reason the report persists the state first: Bee being
    // down must cost the feed write and nothing else. The uploader retries,
    // and the retry has only the write left to do.
    const { store, writes, gateway, service } = setup();
    const row = store.add(
      streamRow({
        status: 'live',
        published_feed_index: 3,
        live_since: new Date('2026-10-01T09:01:00.000Z'),
      }),
    );
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(
      () => service.republishWithState(store.get(row.id)),
      (err: unknown) => err instanceof PublishFailedError && err.reason === 'bee unreachable',
    );

    const after = store.get(row.id);
    assert.equal(after.status, 'live', 'the stream is still live');
    assert.ok(after.live_since, 'and still knows since when');
    assert.equal(after.publish_error, 'bee unreachable');
    assert.equal(after.published_feed_index, 3, 'no write, no new index');
    assert.equal(writes.records.length, 0);

    gateway.failNextWrite = null;
    const retried = await service.republishWithState(store.get(row.id));
    assert.equal(retried.stream.status, 'live');
    assert.equal(retried.stream.publish_error, null);
    assert.equal(entriesOf(gateway)[0]!.state, 'live');
  });

  it('leaves the status as the row has it when the write fails, even after the row moved', async () => {
    // A `live` report lands while a rung's write waits for the mutex. The
    // caller of this republish read the row before that, as `published`; a
    // failure that put that back would tell every viewer the broadcast never
    // started, on the strength of a row nobody has since.
    const { store, gateway, service } = setup();
    const asCallerReadIt = store.add(streamRow({ status: 'published', published_feed_index: 3 }));
    store.add({
      ...asCallerReadIt,
      status: 'live',
      live_since: new Date('2026-10-01T09:01:00.000Z'),
    });
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(
      () => service.republishWithState(asCallerReadIt),
      (err: unknown) => err instanceof PublishFailedError && err.reason === 'bee unreachable',
    );

    const after = store.get(asCallerReadIt.id);
    assert.equal(after.status, 'live', 'not put back to what the caller saw');
    assert.ok(after.live_since);
    assert.equal(after.publish_error, 'bee unreachable');
    assert.equal(after.published_feed_index, 3, 'no write, no new index');
  });

  it('writes the entry from the row as it is at write time, not as the caller read it', async () => {
    const { store, gateway, service } = setup();
    const asCallerReadIt = store.add(streamRow({ status: 'published', published_feed_index: 3 }));
    store.add({ ...asCallerReadIt, status: 'live' });

    const outcome = await service.republishWithState(asCallerReadIt);

    assert.equal(entriesOf(gateway)[0]!.state, 'live');
    assert.equal(outcome.stream.status, 'live');
    assert.equal(store.get(asCallerReadIt.id).status, 'live');
  });

  it('takes the same route when the operator republishes by hand', async () => {
    // A title fixed mid-broadcast: POST /streams/:id/publish on a live stream
    // must reach the feed without the stream leaving `live`.
    const { store, gateway, service } = setup();
    const row = store.add(streamRow({ status: 'live', published_feed_index: 0 }));

    const outcome = await service.publish(row.id, TEST_USER_ID);

    assert.equal(outcome.stream.status, 'live');
    assert.equal(entriesOf(gateway)[0]!.state, 'live');
  });

  it('republishes a recording as vod, by hand, with its index intact', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(
      streamRow({
        status: 'vod',
        manifest_index: 7,
        duration_seconds: 61,
        published_feed_index: 1,
      }),
    );

    const outcome = await service.publish(row.id, TEST_USER_ID);

    assert.equal(outcome.stream.status, 'vod');
    assert.equal(entriesOf(gateway)[0]!.index, 7);
    assert.equal(entriesOf(gateway)[0]!.duration, 61);
  });

  it('publishes a draft that still holds a recording as that recording', async () => {
    // An unpublish keeps the recording, so the next publish has to list the
    // stream as what it is, never as one that has not started.
    const { store, renditions, gateway, service } = setup();
    const row = store.add(
      streamRow({
        manifest_index: 7,
        duration_seconds: 61,
        live_since: new Date('2026-09-11T10:01:00.000Z'),
        ended_at: new Date('2026-09-11T10:02:01.000Z'),
      }),
    );
    await renditions.upsert(row.id, rung('720p', 720, 12));

    const outcome = await service.publish(row.id, TEST_USER_ID);

    assert.equal(outcome.stream.status, 'vod');
    assert.equal(outcome.stream.published_feed_index, outcome.feed.index);
    assert.equal(outcome.stream.manifest_index, 7);
    const [entry] = entriesOf(gateway);
    assert.equal(entry!.state, 'vod');
    assert.equal(entry!.index, 7);
    assert.equal(entry!.duration, 61);
    assert.equal(entry!.renditions?.[0]?.index, 12);
  });

  it('puts a draft holding a recording back to draft, recording intact, when the write fails', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow({ manifest_index: 7, duration_seconds: 61 }));
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(() => service.publish(row.id, TEST_USER_ID), PublishFailedError);

    const after = store.get(row.id);
    assert.equal(after.status, 'draft');
    assert.equal(after.manifest_index, 7);
    assert.equal(after.duration_seconds, 61);
    assert.equal(after.publish_error, 'bee unreachable');
  });

  it('serialises a state report against a concurrent publish', async () => {
    // Two feed writes, one index each: the report does not hold the row's
    // `publishing` claim, so the mutex is all that keeps them apart.
    const { store, gateway, service } = setup();
    const live = store.add(streamRow({ status: 'live' }));
    const draft = store.add(streamRow());

    const [a, b] = await Promise.all([
      service.republishWithState(store.get(live.id)),
      service.publish(draft.id, TEST_USER_ID),
    ]);

    assert.deepEqual([a.feed.index, b.feed.index].sort(), [0, 1]);
    assert.equal(entriesOf(gateway).length, 2);
  });
});

describe('PublishService and the ABR ladder', () => {
  it('carries the ladder onto the entry, ascending by height', async () => {
    const { store, renditions, gateway, service } = setup();
    const row = store.add(streamRow());
    await renditions.upsert(row.id, rung('720p', 720));
    await renditions.upsert(row.id, rung('360p', 360));

    await service.publish(row.id, TEST_USER_ID);

    const [entry] = entriesOf(gateway);
    assert.equal(entry!.group, row.topic, 'the master feed is the declared topic');
    assert.deepEqual(
      entry!.renditions?.map((r) => r.name),
      ['360p', '720p'],
    );
    assert.equal(entry!.renditions?.[1]?.avgBandwidth, 720 * 3000);
  });

  it('rewrites the ladder on a state report, not only on a publish', async () => {
    // The rungs are read on every write: a report that did not carry them
    // would take the ladder off the entry until the next rung reported.
    const { store, renditions, gateway, service } = setup();
    const row = store.add(streamRow({ status: 'live', published_feed_index: 0 }));
    await renditions.upsert(row.id, rung('1080p', 1080));

    await service.republishWithState(store.get(row.id));

    const [entry] = entriesOf(gateway);
    assert.equal(entry!.state, 'live');
    assert.equal(entry!.renditions?.length, 1);
  });

  it('leaves a single-rendition entry exactly as it was', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow());

    const outcome = await service.publish(row.id, TEST_USER_ID);

    const [entry] = entriesOf(gateway);
    assert.ok(!('group' in entry!), 'no group without a ladder');
    assert.ok(!('renditions' in entry!), 'and no renditions');
    assert.deepEqual(outcome.renditions, []);
    assert.deepEqual(outcome.previousRenditions, []);
  });

  it('hands back the ladder it wrote and the one the entry carried before', async () => {
    // A rendition report answers from these two rather than reading the rungs
    // again: what this write put on the catalogue and what it took off, both
    // read under the mutex, so overlapping reports answer in the order their
    // entries landed.
    const { store, renditions, gateway, service } = setup();
    const row = store.add(streamRow());
    await renditions.upsert(row.id, rung('720p', 720));
    await renditions.upsert(row.id, rung('360p', 360));

    const first = await service.publish(row.id, TEST_USER_ID);
    assert.deepEqual(
      first.renditions.map((r) => r.name),
      ['360p', '720p'],
      'ascending by height',
    );
    assert.deepEqual(first.renditions, entriesOf(gateway)[0]!.renditions);
    assert.deepEqual(first.previousRenditions, [], 'nothing on the feed yet');

    await renditions.upsert(row.id, rung('720p', 720, 12));
    const second = await service.publish(row.id, TEST_USER_ID);
    assert.deepEqual(second.previousRenditions, first.renditions);
    assert.equal(second.renditions[1]!.index, 12);

    const gone = await service.unpublish(row.id, TEST_USER_ID);
    assert.deepEqual(gone.renditions, [], 'nothing written for the stream');
    assert.deepEqual(gone.previousRenditions, second.renditions);
  });

  it('keeps the ladder when a recording is unpublished, and publishes it back with it', async () => {
    // An unpublish takes the entry off the catalogue and keeps what the stream
    // has, so the next publish lists the same recording, ladder and all.
    const { store, renditions, gateway, service } = setup();
    const row = store.add(
      streamRow({
        status: 'vod',
        manifest_index: 9,
        duration_seconds: 61,
        published_feed_index: 0,
      }),
    );
    await renditions.upsert(row.id, rung('360p', 360, 10));
    await renditions.upsert(row.id, rung('720p', 720, 12));
    await service.publish(row.id, TEST_USER_ID);
    const listed = entriesOf(gateway)[0]!;

    await service.unpublish(row.id, TEST_USER_ID);
    assert.equal((await renditions.listByStream(row.id)).length, 2, 'the rungs stay');
    assert.deepEqual(entriesOf(gateway), [], 'the entry is off the catalogue');

    await service.publish(row.id, TEST_USER_ID);
    assert.equal(store.get(row.id).status, 'vod');
    assert.deepEqual(
      { ...entriesOf(gateway)[0]!, timestamp: 0 },
      { ...listed, timestamp: 0 },
      'the same recording as before the unpublish',
    );
  });
});

describe('PublishService.unpublish', () => {
  it('removes the entry, writes the next index and returns the stream to draft', async () => {
    const { store, writes, gateway, service } = setup();
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);

    const outcome = await service.unpublish(row.id, TEST_USER_ID);

    assert.equal(outcome.feed.index, 1);
    assert.equal(outcome.feed.entryCount, 0);
    assert.equal(outcome.stream.status, 'draft');
    assert.equal(outcome.stream.published_at, null);
    assert.equal(outcome.stream.published_feed_index, null);
    assert.deepEqual(entriesOf(gateway), []);
    assert.equal(writes.records.length, 2);
  });

  it('removes only its own entry', async () => {
    const foreign = {
      owner: 'ffffffffffffffffffffffffffffffffffffffff',
      topic: '9c1ac0de-0000-4000-8000-000000000001',
    };
    const gateway = new FakeFeedGateway({ index: 2, entries: [foreign] });
    const { store, service } = setup(gateway);
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);

    const outcome = await service.unpublish(row.id, TEST_USER_ID);

    assert.equal(outcome.feed.entryCount, 1);
    assert.deepEqual(gateway.writes.at(-1)!.entries, [foreign]);
  });

  it('keeps the thumbnail reference, which is still paid for', async () => {
    const { store, service } = setup();
    const row = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), {
      thumbnail: Buffer.from([1, 2, 3]),
      thumbnail_mime: 'image/png',
    });
    const published = await service.publish(row.id, TEST_USER_ID);

    const outcome = await service.unpublish(row.id, TEST_USER_ID);
    assert.equal(outcome.stream.thumbnail_ref, published.stream.thumbnail_ref);
  });

  it('skips the write when the stream was never on the feed', async () => {
    const { store, writes, gateway, service } = setup();
    const row = store.add(streamRow());

    const outcome = await service.unpublish(row.id, TEST_USER_ID);

    assert.equal(gateway.writes.length, 0, 'no stamp spent on an identical list');
    assert.equal(writes.records.length, 0);
    assert.equal(outcome.stream.status, 'draft');
    assert.equal(outcome.feed.entryCount, 0);
  });

  it('still unpublishes a stream created under a different feed owner', async () => {
    // The asymmetry is deliberate: the entry is removed by the owner stored on
    // the row, so refusing here would strand it on the feed forever.
    const stale = 'f'.repeat(40);
    const gateway = new FakeFeedGateway({
      index: 4,
      entries: [{ owner: stale, topic: 'aaaaaaaa-0000-4000-8000-000000000001' }],
    });
    const { store, service } = setup(gateway);
    const row = store.add(
      streamRow({
        owner: stale,
        topic: 'aaaaaaaa-0000-4000-8000-000000000001',
        status: 'published',
        published_feed_index: 4,
      }),
    );

    const outcome = await service.unpublish(row.id, TEST_USER_ID);

    assert.equal(outcome.stream.status, 'draft');
    assert.equal(outcome.feed.index, 5);
    assert.deepEqual(gateway.writes.at(-1)!.entries, []);
  });

  it('takes a recording off the feed and keeps what the uploader reported', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow({ status: 'live' }));
    await service.republishWithState(store.get(row.id));
    const liveSince = new Date('2026-09-11T10:01:00.000Z');
    const endedAt = new Date('2026-09-11T11:00:00.000Z');
    store.add({
      ...store.get(row.id),
      status: 'vod',
      manifest_index: 4,
      duration_seconds: 3540,
      live_since: liveSince,
      ended_at: endedAt,
    });

    const outcome = await service.unpublish(row.id, TEST_USER_ID);

    assert.equal(outcome.stream.status, 'draft');
    assert.deepEqual(entriesOf(gateway), []);
    assert.equal(outcome.stream.published_feed_index, null, 'off the catalogue');
    assert.equal(outcome.stream.manifest_index, 4, 'where the recording is');
    assert.equal(outcome.stream.duration_seconds, 3540, 'how long it runs');
    assert.deepEqual(outcome.stream.live_since, liveSince);
    assert.deepEqual(outcome.stream.ended_at, endedAt);
  });

  it('refuses to unpublish a live stream', async () => {
    // Nothing here can stop the encoder that is still pushing to it, and the
    // viewer would lose the entry it is playing from.
    const { store, gateway, service } = setup();
    const row = store.add(streamRow({ status: 'live' }));

    await assert.rejects(
      () => service.unpublish(row.id, TEST_USER_ID),
      (err: unknown) => err instanceof StreamLiveError && err.streamId === row.id,
    );
    assert.equal(store.get(row.id).status, 'live', 'never claimed');
    assert.equal(gateway.writes.length, 0);
  });

  it('restores the status when the removing write fails', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(() => service.unpublish(row.id, TEST_USER_ID), PublishFailedError);
    const after = store.get(row.id);
    assert.equal(after.status, 'published');
    assert.equal(after.publish_error, 'bee unreachable');
  });
});

describe('FakeFeedGateway', () => {
  it('continues a feed it has no memory of, and only then insists on +1', async () => {
    // The dev loop: `tsx watch` restarts the backend on every save, the fake
    // forgets every write, and `feed_writes` does not. Refusing to continue
    // where the database says the feed is would break publishing until the
    // table was emptied by hand.
    const gateway = new FakeFeedGateway();
    await gateway.write([], 41);
    assert.equal((await gateway.readLatest()).index, 41);

    await gateway.write([], 42);
    await assert.rejects(() => gateway.write([], 42), /expected 43/, 'within one process the check still stands');
  });
});

describe('FakeFeedGateway.hasReference', () => {
  it('knows only the references it handed out', async () => {
    const gateway = new FakeFeedGateway();
    const reference = await gateway.uploadThumbnail(Buffer.from([1, 2, 3]), 'a.png', 'image/png');

    assert.equal(await gateway.hasReference(reference), true);
    assert.equal(await gateway.hasReference('c'.repeat(64)), false);
    assert.equal(
      await new FakeFeedGateway().hasReference(reference),
      false,
      'a fresh process knows nothing, which is the honest answer',
    );
  });
});

/**
 * The bug this whole scheme exists for: Bee's feed lookup answers with the
 * head as it was seconds ago, so `head + 1` read from the network put two
 * different writes on one index and the later chunk replaced the earlier one.
 * `FakeFeedGateway`'s `readLagWrites` is that node, without the node.
 */
describe('PublishService against a feed lookup that lags its own writes', () => {
  it('writes consecutive indices anyway, and the unpublish still removes the entry', async () => {
    const gateway = new FakeFeedGateway(undefined, { readLagWrites: 1 });
    const { store, service } = setup(gateway);
    const first = store.add(streamRow());
    const second = store.add(streamRow());

    const a = await service.publish(first.id, TEST_USER_ID);
    const b = await service.publish(second.id, TEST_USER_ID);

    // What the old code would have read for the second publish: still index 0,
    // and a list without the first entry on it. Both writes would have gone to
    // index 0, the second overwriting the first.
    const stale = await gateway.readLatest();
    assert.equal(stale.index, 0, 'the network is a write behind');

    assert.equal(a.feed.index, 0);
    assert.equal(b.feed.index, 1, 'not the stale head + 1');
    assert.equal(b.feed.entryCount, 2, 'the base carried the first entry');

    // And the entry really comes off again: the removal reads the same
    // authoritative base, not the payload from before the publish that put it
    // there, so `removed` is true and the write happens.
    const off = await service.unpublish(first.id, TEST_USER_ID);
    assert.equal(off.feed.index, 2);
    assert.deepEqual(
      entriesOf(gateway).map((e) => e.topic),
      [second.topic],
    );
  });

  it('falls back to the network head only while nothing is recorded', async () => {
    // A feed this backend has written before (index 7) but has no row for:
    // a fresh install against an existing catalogue, or rows that predate
    // migration 003. The first write has to trust the network; from then on
    // the log leads, even though this node never stops answering 7.
    const gateway = new FakeFeedGateway({ index: 7, entries: [] }, { readLagWrites: 99 });
    const { store, writes, service } = setup(gateway);
    const first = store.add(streamRow());
    const second = store.add(streamRow());

    assert.equal((await service.publish(first.id, TEST_USER_ID)).feed.index, 8);
    assert.equal((await service.publish(second.id, TEST_USER_ID)).feed.index, 9);
    assert.equal((await gateway.readLatest()).index, 7, 'still stuck');
    assert.deepEqual(
      writes.records.map((r) => r.feedIndex),
      [8, 9],
    );
  });
});

describe('PublishService.checkFeedOnBoot', () => {
  it('adopts a network head that is ahead of everything recorded here', async () => {
    // Something else wrote under this key, or this is not the database that
    // wrote the feed. Either way the next write must go *after* what is on the
    // network, not over it — and the payload there is the only base there is.
    const foreign = {
      owner: 'ffffffffffffffffffffffffffffffffffffffff',
      topic: '9c1ac0de-0000-4000-8000-000000000001',
    };
    const gateway = new FakeFeedGateway();
    const { store, writes, service } = setup(gateway);
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);

    // The network moves on without us: two more updates under our key.
    await gateway.write([foreign], 1);
    await gateway.write([foreign], 2);

    const check = await service.checkFeedOnBoot();

    assert.equal(check.recorded, 0);
    assert.equal(check.network, 2);
    assert.equal(check.adopted, true);
    assert.deepEqual(writes.records.at(-1)!.payload, [foreign]);
    assert.equal(writes.records.at(-1)!.reference, null, 'not ours to name');

    // The next publish continues after the adopted head and keeps what was
    // found there.
    const next = await service.publish(row.id, TEST_USER_ID);
    assert.equal(next.feed.index, 3);
    assert.deepEqual(gateway.writes.at(-1)!.entries[0], foreign);
  });

  it('says nothing is wrong when the network is merely behind', async () => {
    const gateway = new FakeFeedGateway(undefined, { readLagWrites: 5 });
    const { store, writes, service } = setup(gateway);
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);

    const before = writes.records.length;
    const check = await service.checkFeedOnBoot();

    assert.equal(check.recorded, 0);
    assert.equal(check.network, null, 'the lookup has not caught up at all');
    assert.equal(check.adopted, false);
    assert.equal(writes.records.length, before, 'nothing recorded');
  });

  it('carries on when the gateway cannot answer at all', async () => {
    const { store, service, gateway } = setup();
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);
    gateway.failNextRead = new Error('bee unreachable');

    const check = await service.checkFeedOnBoot();
    assert.equal(check.network, null);
    assert.equal(check.adopted, false);
  });

  it('reports ghosts without writing anything', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);
    store.rows.delete(row.id); // unpublished, then deleted, entry left behind

    const check = await service.checkFeedOnBoot();

    assert.deepEqual(check.ghosts, [row.topic]);
    assert.equal(gateway.writes.length, 1, 'the dry run writes nothing');
  });
});

describe('PublishService.reconcile', () => {
  it('drops an entry with no row behind it', async () => {
    // A2-2 / A4-1: the row was unpublished and then deleted while a stale
    // write put the entry back, so no request can name it any more — topics
    // are server-minted and `unpublish` needs a row.
    const { store, gateway, service } = setup();
    const ghost = store.add(streamRow());
    const kept = store.add(streamRow());
    await service.publish(ghost.id, TEST_USER_ID);
    await service.publish(kept.id, TEST_USER_ID);
    store.rows.delete(ghost.id);

    const outcome = await service.reconcile(TEST_USER_ID);

    assert.deepEqual(outcome.removed, [ghost.topic]);
    assert.deepEqual(outcome.added, []);
    assert.deepEqual(outcome.updated, []);
    assert.equal(outcome.index, 2);
    assert.equal(outcome.entryCount, 1);
    assert.deepEqual(
      entriesOf(gateway).map((e) => e.topic),
      [kept.topic],
    );
  });

  it('adds a published row that is missing from the feed', async () => {
    // The other half of the collision: the write that carried this entry was
    // overwritten, so the row says `published` and the catalogue does not.
    const { store, gateway, service } = setup(new FakeFeedGateway({ index: 4, entries: [] }));
    const row = store.add(streamRow({ status: 'published', published_feed_index: 4 }));

    const outcome = await service.reconcile(TEST_USER_ID);

    assert.deepEqual(outcome.added, [row.topic]);
    assert.equal(outcome.index, 5);
    const [entry] = entriesOf(gateway);
    assert.equal(entry!.topic, row.topic);
    assert.equal(entry!.state, 'scheduled');
  });

  it('rebuilds an entry that no longer matches its row, keeping vod numbers', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);
    store.add({
      ...store.get(row.id),
      title: 'Edited after the entry was written',
      status: 'vod',
      manifest_index: 412,
      duration_seconds: 61,
    });

    const outcome = await service.reconcile(TEST_USER_ID);

    assert.deepEqual(outcome.updated, [row.topic]);
    const [entry] = entriesOf(gateway);
    assert.equal(entry!.title, 'Edited after the entry was written');
    assert.equal(entry!.state, 'vod');
    assert.equal(entry!.index, 412);
    assert.equal(entry!.duration, 61);
  });

  it('keeps a ladder′s renditions on the entry, and does not count them as drift', async () => {
    // A reconcile rebuilds every entry of ours from its row. The rungs are not
    // on the row, so a rebuild that did not read them would strip `renditions`
    // and `group` from every ladder stream, write that as a repair, and take
    // the ladder off the catalogue until its next rung report.
    const { store, renditions, gateway, service } = setup();
    const row = store.add(streamRow());
    await renditions.upsert(row.id, rung('720p', 720));
    await renditions.upsert(row.id, rung('360p', 360));
    await service.publish(row.id, TEST_USER_ID);
    const writesBefore = gateway.writes.length;

    const untouched = await service.reconcile(TEST_USER_ID);

    assert.deepEqual(untouched.updated, [], 'a ladder entry that matches its rows is not drift');
    assert.equal(gateway.writes.length, writesBefore, 'a clean catalogue costs no write');

    // And when the row really did drift, the rebuilt entry still carries the ladder.
    store.add({ ...store.get(row.id), title: 'Retitled mid-ladder' });
    const repaired = await service.reconcile(TEST_USER_ID);

    assert.deepEqual(repaired.updated, [row.topic]);
    const [entry] = entriesOf(gateway);
    assert.equal(entry!.title, 'Retitled mid-ladder');
    assert.equal(entry!.group, row.topic);
    assert.deepEqual(
      entry!.renditions?.map((r) => r.name),
      ['360p', '720p'],
    );
  });

  it('leaves entries written by someone else exactly where they are', async () => {
    const foreign = {
      owner: 'ffffffffffffffffffffffffffffffffffffffff',
      topic: '9c1ac0de-0000-4000-8000-000000000001',
      title: 'Someone else',
      state: 'live',
    };
    const nonsense = 'not an entry at all';
    const gateway = new FakeFeedGateway({
      index: 3,
      entries: [foreign, nonsense],
    });
    const { store, service } = setup(gateway);
    const ghost = store.add(streamRow());
    await service.publish(ghost.id, TEST_USER_ID);
    store.rows.delete(ghost.id);

    const outcome = await service.reconcile(TEST_USER_ID);

    assert.deepEqual(outcome.removed, [ghost.topic]);
    const written = gateway.writes.at(-1)!.entries;
    assert.deepEqual(written[0], foreign, 'foreign entry untouched');
    assert.equal(written[1], nonsense, 'unparseable element untouched');
    assert.equal(written.length, 2);
  });

  it('writes nothing when the catalogue already matches the database', async () => {
    const { store, writes, gateway, service } = setup();
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);

    const outcome = await service.reconcile(TEST_USER_ID);

    assert.equal(outcome.index, null, 'no index spent');
    assert.deepEqual([outcome.removed, outcome.added, outcome.updated], [[], [], []]);
    assert.equal(outcome.entryCount, 1);
    assert.equal(gateway.writes.length, 1, 'no stamp spent either');
    assert.equal(writes.records.length, 1);
  });
});

/**
 * The console warns "Edited since it was published" while the row holds an
 * edit the catalogue entry does not carry. Every write that rebuilds this
 * stream's entry from its row has to say which edit it carried, and nothing
 * else may: the uploader's reports move the row but edit nothing, and a write
 * for another stream copies this one's entry as it was.
 */
describe('PublishService and the edited-since-published notice', () => {
  const REBUILT_AT = new Date('2026-09-24T10:00:00.000Z');
  const EDITED_AT = new Date('2026-09-24T10:05:00.000Z');

  it('records the edit a first publish put on the feed', async () => {
    const { store, service } = setup();
    const row = store.add(streamRow({ content_edited_at: EDITED_AT }));

    const outcome = await service.publish(row.id, TEST_USER_ID);

    assert.equal(outcome.stream.entry_content_edited_at?.getTime(), EDITED_AT.getTime());
    assert.equal(hasUnpublishedEdits(outcome.stream), false);
  });

  it('clears on a republish of a recording, which leaves published_at alone', async () => {
    // The live finding: a recording was edited and republished, the catalogue
    // was rewritten at a new index, and the console still warned.
    const { store, gateway, service } = setup();
    const row = store.add(
      streamRow({
        status: 'vod',
        manifest_index: 7,
        duration_seconds: 61,
        published_at: REBUILT_AT,
        published_feed_index: 1,
        title: 'Retitled after the broadcast',
        content_edited_at: EDITED_AT,
        entry_content_edited_at: REBUILT_AT,
      }),
    );
    assert.equal(hasUnpublishedEdits(store.get(row.id)), true, 'not on the feed yet');

    const outcome = await service.publish(row.id, TEST_USER_ID);

    assert.equal(entriesOf(gateway)[0]!.title, 'Retitled after the broadcast');
    assert.equal(outcome.stream.published_at?.getTime(), REBUILT_AT.getTime(), 'still the first announcement');
    assert.equal(hasUnpublishedEdits(outcome.stream), false);
    assert.equal(hasUnpublishedEdits(store.get(row.id)), false);
  });

  it('clears when a state report rebuilds the entry with the edit on it', async () => {
    // A report rewrites the entry from the row, so an edit waiting for a
    // republish reaches the feed with it, and nothing is left to republish.
    const { store, gateway, service } = setup();
    const row = store.add(
      streamRow({
        status: 'live',
        published_feed_index: 0,
        title: 'Fixed before the report',
        content_edited_at: EDITED_AT,
        entry_content_edited_at: REBUILT_AT,
      }),
    );

    await service.republishWithState(store.get(row.id));

    assert.equal(entriesOf(gateway)[0]!.title, 'Fixed before the report');
    assert.equal(hasUnpublishedEdits(store.get(row.id)), false);
  });

  it('keeps warning about an edit that lands while the entry is being written', async () => {
    // A live stream stays editable while a report's write is on its way to
    // Bee. That edit is not on the entry, so the notice must survive the write.
    const { store, gateway, service } = setup();
    const row = store.add(
      streamRow({
        status: 'live',
        published_feed_index: 0,
        content_edited_at: REBUILT_AT,
        entry_content_edited_at: REBUILT_AT,
      }),
    );
    const write = gateway.write.bind(gateway);
    gateway.write = async (entries: unknown[], index: number) => {
      store.add({
        ...store.get(row.id),
        title: 'Saved mid-write',
        content_edited_at: EDITED_AT,
      });
      return write(entries, index);
    };

    await service.republishWithState(store.get(row.id));

    assert.notEqual(entriesOf(gateway)[0]!.title, 'Saved mid-write');
    assert.equal(store.get(row.id).title, 'Saved mid-write', 'the edit stands');
    assert.equal(hasUnpublishedEdits(store.get(row.id)), true);
  });

  it('does not count a write made for another stream', async () => {
    // Publishing the second stream copies the first one's entry as it was.
    const { store, gateway, service } = setup();
    const edited = store.add(streamRow());
    const other = store.add(streamRow());
    await service.publish(edited.id, TEST_USER_ID);
    store.add({
      ...store.get(edited.id),
      title: 'Not republished',
      content_edited_at: EDITED_AT,
    });

    await service.publish(other.id, TEST_USER_ID);

    const onFeed = entriesOf(gateway).find((e) => e.topic === edited.topic);
    assert.equal(onFeed?.title, 'Pilot keynote');
    assert.equal(hasUnpublishedEdits(store.get(edited.id)), true);
  });

  it('counts a reconcile that rewrote the entry from the edited row', async () => {
    const { store, gateway, service } = setup();
    const row = store.add(streamRow());
    await service.publish(row.id, TEST_USER_ID);
    store.add({
      ...store.get(row.id),
      title: 'Edited, then reconciled',
      content_edited_at: EDITED_AT,
    });

    const outcome = await service.reconcile(TEST_USER_ID);

    assert.deepEqual(outcome.updated, [row.topic]);
    assert.equal(entriesOf(gateway)[0]!.title, 'Edited, then reconciled');
    assert.equal(hasUnpublishedEdits(store.get(row.id)), false);
  });

  it('keeps warning when a reconcile could not carry a replaced thumbnail', async () => {
    // A reconcile uploads nothing, so an image that replaced the published one
    // goes out as no thumbnail at all, and only a republish uploads it.
    const { store, gateway, service } = setup();
    const row = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), {
      thumbnail: Buffer.from([1, 2, 3]),
      thumbnail_mime: 'image/png',
    });
    await service.publish(row.id, TEST_USER_ID);
    store.add({
      ...store.get(row.id),
      thumbnail_ref: null,
      content_edited_at: EDITED_AT,
    });

    const outcome = await service.reconcile(TEST_USER_ID);

    assert.deepEqual(outcome.updated, [row.topic]);
    assert.equal(entriesOf(gateway)[0]!.thumbnail, '');
    assert.equal(hasUnpublishedEdits(store.get(row.id)), true);

    await service.publish(row.id, TEST_USER_ID);
    assert.match(entriesOf(gateway)[0]!.thumbnail, /^[0-9a-f]{64}$/);
    assert.equal(hasUnpublishedEdits(store.get(row.id)), false);
  });
});
