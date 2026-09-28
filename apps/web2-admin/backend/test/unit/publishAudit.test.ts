/**
 * What publishing leaves in the audit log. Unit test — the in-memory feed
 * gateway, store and audit log. `pnpm test`.
 *
 * Every signed-in operator can publish, republish and unpublish every stream,
 * and reconcile rewrites the whole catalogue; these entries are the record of
 * who did which. A failure is recorded too, with the reason, because a publish
 * that did not happen is exactly what an operator will ask about. And an audit
 * write that fails never fails the publish: by then the feed is written.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PublishFailedError } from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { resetOrphanedPublishing } from '../../src/domain/resetOrphanedPublishing.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  streamRow,
  TEST_OPERATOR,
  TEST_OWNER,
} from './support/fakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

function setup() {
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const gateway = new FakeFeedGateway();
  const writes = new FakeFeedWriteLog();
  const audit = new InMemoryAuditLog();
  const service = new PublishService(store, renditions, writes, gateway, feed, audit);
  return { store, gateway, writes, audit, service };
}

describe('PublishService audit', () => {
  it('records a first publish as draft → published, with the feed index it landed at', async () => {
    const { store, audit, service } = setup();
    // Two entries already on the feed, so the index is not a coincidental 0.
    await service.publish(TEST_OPERATOR, store.add(streamRow()).id);
    await service.publish(TEST_OPERATOR, store.add(streamRow()).id);
    audit.entries.length = 0;
    const row = store.add(streamRow());

    const outcome = await service.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.feed.index, 2);
    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'stream.publish',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'draft',
        statusAfter: 'published',
        details: { feedIndex: 2, entryCount: 3 },
      },
    ]);
  });

  it('records the publish of a live stream as a republish that stays live', async () => {
    const { store, audit, service } = setup();
    const row = store.add(streamRow({ status: 'live', published_feed_index: 0 }));

    const outcome = await service.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.status, 'live');
    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'stream.republish',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'live',
        statusAfter: 'live',
        details: { feedIndex: outcome.feed.index, entryCount: 1 },
      },
    ]);
  });

  it('records an unpublish as published → draft', async () => {
    const { store, audit, service } = setup();
    const row = store.add(streamRow());
    await service.publish(TEST_OPERATOR, row.id);
    audit.entries.length = 0;

    const outcome = await service.unpublish(TEST_OPERATOR, row.id);

    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'stream.unpublish',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'published',
        statusAfter: 'draft',
        details: { feedIndex: outcome.feed.index, wasOnFeed: true },
      },
    ]);
  });

  it('records a failed publish with the reason, and still throws the failure', async () => {
    const { store, gateway, audit, service } = setup();
    const row = store.add(streamRow());
    gateway.failNextWrite = new Error('postage batch not usable');

    await assert.rejects(
      () => service.publish(TEST_OPERATOR, row.id),
      (err: unknown) => err instanceof PublishFailedError && err.reason === 'postage batch not usable',
    );

    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'stream.publish.failed',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'draft',
        statusAfter: 'draft',
        details: { error: 'postage batch not usable', feedIndex: null },
      },
    ]);
  });

  it('records a failed unpublish the same way', async () => {
    const { store, gateway, audit, service } = setup();
    const row = store.add(streamRow());
    await service.publish(TEST_OPERATOR, row.id);
    audit.entries.length = 0;
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(() => service.unpublish(TEST_OPERATOR, row.id), PublishFailedError);

    assert.deepEqual(
      audit.entries.map(({ action, statusBefore, statusAfter, details }) => ({
        action,
        statusBefore,
        statusAfter,
        details,
      })),
      [
        {
          action: 'stream.unpublish.failed',
          statusBefore: 'published',
          statusAfter: 'published',
          details: { error: 'bee unreachable', feedIndex: null },
        },
      ],
    );
  });

  it('names the feed index in a failed publish whose write the gateway had already taken', async () => {
    // The chunk is on the catalogue and the row says draft: the entry is the
    // one place that records the catalogue carries it.
    const { store, writes, audit, service } = setup();
    const row = store.add(streamRow());
    writes.record = async () => {
      throw new Error('connection terminated');
    };

    await assert.rejects(() => service.publish(TEST_OPERATOR, row.id), PublishFailedError);

    assert.deepEqual(audit.withAction('stream.publish.failed')[0]?.details, {
      error: 'connection terminated',
      feedIndex: 0,
    });
  });

  it('records that a failed publish left the row in publishing when putting it back failed too', async () => {
    const { store, gateway, audit, service } = setup();
    const row = store.add(streamRow());
    gateway.failNextWrite = new Error('postage batch not usable');
    store.failNextFailPublish = new Error('connection terminated');

    await assert.rejects(() => service.publish(TEST_OPERATOR, row.id), PublishFailedError);

    const [entry] = audit.withAction('stream.publish.failed');
    assert.equal(entry?.statusBefore, 'draft');
    assert.equal(entry?.statusAfter, 'publishing', 'what the row says until boot clears it');
    assert.equal(store.get(row.id).status, 'publishing');
  });

  it('records a failed hand republish of a live stream as a failed publish, marked as a republish', async () => {
    const { store, gateway, audit, service } = setup();
    const row = store.add(streamRow({ status: 'live', published_feed_index: 0 }));
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(() => service.publish(TEST_OPERATOR, row.id), PublishFailedError);

    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'stream.publish.failed',
        streamId: row.id,
        topic: row.topic,
        statusBefore: 'live',
        statusAfter: 'live',
        details: { error: 'bee unreachable', republish: true },
      },
    ]);
  });

  it('records an unpublish of a stream that was not on the feed, with no feed index', async () => {
    const { store, gateway, audit, service } = setup();
    const row = store.add(streamRow());

    await service.unpublish(TEST_OPERATOR, row.id);

    assert.equal(gateway.writes.length, 0, 'nothing was written');
    assert.deepEqual(
      audit.entries.map(({ action, statusBefore, statusAfter, details }) => ({
        action,
        statusBefore,
        statusAfter,
        details,
      })),
      [
        {
          action: 'stream.unpublish',
          statusBefore: 'draft',
          statusAfter: 'draft',
          details: { feedIndex: null, wasOnFeed: false },
        },
      ],
    );
  });

  it('records nothing for a publish it refused before claiming the row', async () => {
    // A refusal moved nothing and told the operator why; it is not a failure.
    const { store, audit, service } = setup();
    const row = store.add(streamRow({ status: 'publishing' }));

    await assert.rejects(() => service.publish(TEST_OPERATOR, row.id));

    assert.deepEqual(audit.entries, []);
  });

  it('records a reconcile that wrote, with what it removed, added and updated', async () => {
    const { store, audit, service } = setup();
    const ghost = store.add(streamRow());
    const kept = store.add(streamRow());
    await service.publish(TEST_OPERATOR, ghost.id);
    await service.publish(TEST_OPERATOR, kept.id);
    // The entry stays on the feed with no row behind it: the reconcile
    // removes it.
    store.rows.delete(ghost.id);
    // A row that says it is published but was never written: the reconcile
    // adds it.
    const missing = store.add(streamRow({ status: 'published', published_feed_index: 0 }));
    audit.entries.length = 0;

    const outcome = await service.reconcile(TEST_OPERATOR);

    assert.deepEqual(audit.entries, [
      {
        actor: TEST_OPERATOR,
        action: 'feed.reconcile',
        details: {
          feedIndex: 2,
          entryCount: 2,
          removed: [ghost.topic],
          added: [missing.topic],
          updated: [],
        },
      },
    ]);
    assert.equal(outcome.index, 2);
  });

  it('records nothing for a reconcile that found nothing to do', async () => {
    const { store, audit, service } = setup();
    await service.publish(TEST_OPERATOR, store.add(streamRow()).id);
    audit.entries.length = 0;

    const outcome = await service.reconcile(TEST_OPERATOR);

    assert.equal(outcome.index, null);
    assert.deepEqual(audit.entries, []);
  });

  it('still publishes when the audit write fails', async () => {
    // The feed is written and the row finished before the entry is recorded;
    // an error now would make the console retry a publish that happened.
    const { store, gateway, audit, service } = setup();
    const row = store.add(streamRow());
    audit.failNextWrite = new Error('connection terminated');

    const outcome = await service.publish(TEST_OPERATOR, row.id);

    assert.equal(outcome.stream.status, 'published');
    assert.equal(store.get(row.id).status, 'published');
    assert.equal(gateway.writes.length, 1);
    assert.deepEqual(audit.entries, []);
  });

  it('still throws the publish failure, not the audit one, when both fail', async () => {
    const { store, gateway, audit, service } = setup();
    const row = store.add(streamRow());
    gateway.failNextWrite = new Error('postage batch not usable');
    audit.failNextWrite = new Error('connection terminated');

    await assert.rejects(
      () => service.publish(TEST_OPERATOR, row.id),
      (err: unknown) => err instanceof PublishFailedError && err.reason === 'postage batch not usable',
    );
    assert.equal(store.get(row.id).status, 'draft');
  });
});

describe('resetOrphanedPublishing audit', () => {
  it('records each row the boot repair put back, as the system', async () => {
    const store = new FakeStreamStore();
    const audit = new InMemoryAuditLog();
    const fresh = store.add(streamRow({ status: 'publishing' }));
    const republish = store.add(streamRow({ status: 'publishing', published_feed_index: 4 }));
    store.add(streamRow({ status: 'published', published_feed_index: 3 }));

    await resetOrphanedPublishing(store, audit);

    const boot = { kind: 'system', reason: 'boot' } as const;
    const details = { publishError: 'backend restarted while publishing' };
    assert.deepEqual(audit.entries, [
      {
        actor: boot,
        action: 'stream.publishing.reset',
        streamId: fresh.id,
        topic: fresh.topic,
        statusBefore: 'publishing',
        statusAfter: 'draft',
        details,
      },
      {
        actor: boot,
        action: 'stream.publishing.reset',
        streamId: republish.id,
        topic: republish.topic,
        statusBefore: 'publishing',
        statusAfter: 'published',
        details,
      },
    ]);
  });
});
