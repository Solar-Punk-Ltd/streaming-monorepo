/**
 * The console's stream edits and the key rotation, against the in-memory
 * store and audit log. Unit test — no database. `pnpm test`.
 *
 * A stream belongs to the installation, so every signed-in operator can do
 * all of this to every stream. What is pinned here is that each of them leaves
 * a record of who did it: an audit entry per mutation, naming the operator,
 * the stream and what moved — and that an audit write that fails is only
 * logged, because the mutation it describes has already happened.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeStream } from '../../src/domain/actor.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { IngestService } from '../../src/domain/IngestService.js';
import { changedFields, StreamService, type StreamInputValues } from '../../src/domain/StreamService.js';
import type { IngestConfig } from '../../src/utils/config.js';

import { FakeStreamStore, InMemoryAuditLog, streamRow, TEST_OPERATOR, TEST_OWNER } from './support/fakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

const endpoint: IngestConfig = {
  host: 'ingest.example.com',
  srtPort: 10061,
  rtmpPort: 10062,
  rtmpPublic: false,
  srtPassphrase: null,
  keyVerified: true,
};

/** Another operator of the same installation, not the one who drafted the row. */
const MATE = { kind: 'operator', userId: '00000000-0000-4000-8000-0000000000ff', username: 'bob' } as const;

/** The form exactly as `streamRow()` holds it, so a save of it changes nothing. */
const UNCHANGED: StreamInputValues = {
  title: 'Opening keynote',
  description: 'The opening talk.',
  tags: ['swarm'],
  mediaType: 'video',
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
};

function setup() {
  const store = new FakeStreamStore();
  const audit = new InMemoryAuditLog();
  const service = new StreamService(store, feed, audit);
  return { store, audit, service };
}

describe('StreamService audit', () => {
  it('records the operator who created a stream, and stamps them on the row as its drafter', async () => {
    const { audit, service } = setup();

    const created = await service.create(TEST_OPERATOR, UNCHANGED);

    assert.equal(created.user_id, TEST_OPERATOR.userId, 'user_id comes from the actor');
    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'stream.create',
        streamId: created.id,
        topic: created.topic,
        statusBefore: null,
        statusAfter: 'draft',
        details: { title: 'Opening keynote', mediaType: 'video' },
      },
    ]);
  });

  it('records which fields an edit changed, and who made it', async () => {
    const { store, audit, service } = setup();
    const row = store.add(streamRow({ status: 'published' }));

    await service.update(MATE, row.id, { ...UNCHANGED, title: 'Keynote, day one', tags: ['swarm', 'day-1'] });

    assert.deepEqual(audit.entries, [
      {
        actor: MATE,
        action: 'stream.update',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'published',
        statusAfter: 'published',
        details: { changed: ['title', 'tags'] },
      },
    ]);
  });

  it('records nothing for a save that changed nothing', async () => {
    // The console PUTs the whole form on every save; a save that leaves the
    // row as it was is not a mutation, so it is logged but not audited.
    const { store, audit, service } = setup();
    const row = store.add(streamRow());

    await service.update(TEST_OPERATOR, row.id, UNCHANGED);

    assert.deepEqual(audit.entries, []);
  });

  it('records a delete with the title and topic, so the stream is still recognisable once the row is gone', async () => {
    const { store, audit, service } = setup();
    const row = store.add(streamRow());

    await service.remove(TEST_OPERATOR, row.id);

    assert.equal(await store.findById(row.id), null);
    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'stream.delete',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'draft',
        statusAfter: null,
        details: { title: 'Opening keynote' },
      },
    ]);
  });

  it('records nothing for a delete it refused', async () => {
    const { store, audit, service } = setup();
    const row = store.add(streamRow({ status: 'published' }));

    await assert.rejects(() => service.remove(TEST_OPERATOR, row.id));

    assert.deepEqual(audit.entries, []);
  });

  it('records a thumbnail set with its type and size, and a clear', async () => {
    const { store, audit, service } = setup();
    const row = store.add(streamRow());

    await service.setThumbnail(TEST_OPERATOR, row.id, 'image/png; charset=binary', Buffer.alloc(1234));
    await service.removeThumbnail(MATE, row.id);

    assert.deepEqual(
      audit.entries.map(({ actor, action, details }) => ({ actor, action, details })),
      [
        { actor: TEST_OPERATOR, action: 'stream.thumbnail.set', details: { mime: 'image/png', bytes: 1234 } },
        { actor: MATE, action: 'stream.thumbnail.clear', details: undefined },
      ],
    );
  });

  it('records nothing for clearing a thumbnail that was never set', async () => {
    // The console's "remove" on a stream without an image changes nothing,
    // so there is nothing to say anyone did.
    const { store, audit, service } = setup();
    const row = store.add(streamRow());

    const cleared = await service.removeThumbnail(TEST_OPERATOR, row.id);

    assert.equal(cleared.has_thumbnail, false);
    assert.deepEqual(audit.entries, []);
  });

  it('still creates the stream when the audit write fails', async () => {
    // The row is written before the audit entry is, so refusing now would
    // answer an error for a stream that exists.
    const { store, audit, service } = setup();
    audit.failNextWrite = new Error('connection terminated');

    const created = await service.create(TEST_OPERATOR, UNCHANGED);

    assert.ok(await store.findById(created.id), 'the stream exists');
    assert.deepEqual(audit.entries, []);
  });

  it('still applies an edit when the audit write fails', async () => {
    const { store, audit, service } = setup();
    const row = store.add(streamRow());
    audit.failNextWrite = new Error('connection terminated');

    const updated = await service.update(TEST_OPERATOR, row.id, { ...UNCHANGED, title: 'Renamed' });

    assert.equal(updated.title, 'Renamed');
    assert.equal(store.get(row.id).title, 'Renamed');
  });
});

describe('IngestService.rotateKey audit', () => {
  it('records who rotated the key, and never the key itself', async () => {
    const store = new FakeStreamStore();
    const audit = new InMemoryAuditLog();
    const ingest = new IngestService(store, endpoint, audit);
    const row = store.add(streamRow({ status: 'live' }));

    const details = await ingest.rotateKey(MATE, row.id);

    assert.notEqual(details.publishKey, row.publish_key, 'the key did change');
    assert.deepEqual(audit.entries, [
      {
        actor: MATE,
        action: 'stream.key.rotate',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'live',
        statusAfter: 'live',
      },
    ]);
    const recorded = JSON.stringify(audit.entries);
    assert.ok(!recorded.includes(details.publishKey), 'the new key is not in the entry');
    assert.ok(!recorded.includes(row.publish_key), 'nor is the old one');
  });
});

describe('changedFields', () => {
  const base = streamRow();

  it('names each field the form can change, and nothing for an identical row', () => {
    assert.deepEqual(changedFields(base, { ...base }), []);
    assert.deepEqual(changedFields(base, { ...base, description: 'Another talk.' }), ['description']);
    assert.deepEqual(changedFields(base, { ...base, media_type: 'audio' }), ['mediaType']);
    assert.deepEqual(changedFields(base, { ...base, scheduled_start_time: new Date('2026-10-02T09:00:00.000Z') }), [
      'scheduledStartTime',
    ]);
  });

  it('compares scheduled starts by instant, and sees null to a date and back', () => {
    const noStart = { ...base, scheduled_start_time: null };

    assert.deepEqual(
      changedFields(base, { ...base, scheduled_start_time: new Date(base.scheduled_start_time!.getTime()) }),
      [],
      'a different Date object for the same instant is no change',
    );
    assert.deepEqual(changedFields(noStart, base), ['scheduledStartTime']);
    assert.deepEqual(changedFields(base, noStart), ['scheduledStartTime']);
    assert.deepEqual(changedFields(noStart, { ...noStart }), []);
  });

  it('sees a reordered or shortened tag list as a change', () => {
    const tagged = { ...base, tags: ['swarm', 'keynote'] };
    assert.deepEqual(changedFields(tagged, { ...tagged, tags: ['keynote', 'swarm'] }), ['tags']);
    assert.deepEqual(changedFields(tagged, { ...tagged, tags: ['swarm'] }), ['tags']);
  });
});

describe('describeStream', () => {
  it('keeps a title with a newline in it on one line, so it cannot forge a log line', () => {
    const forged = describeStream({
      title: 'Talk\n[2026-09-28T10:00:00.000Z] [INFO] - [Auth] mallory added user eve',
      topic: '1867808f-7b1c-4e46-b437-f7423b466000',
    });

    assert.ok(!forged.includes('\n'), 'no raw newline');
    assert.equal(
      forged,
      '"Talk\\n[2026-09-28T10:00:00.000Z] [INFO] - [Auth] mallory added user eve" (topic 1867808f-7b1c-4e46-b437-f7423b466000)',
    );
  });
});
