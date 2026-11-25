/**
 * What a publish tells the archive (`PublishArchiveImages`), against the in-memory FeedGateway: a first publish and a
 * republish by hand whose entry names an image tell it once the entry is on the feed and the publish is finished,
 * whether the image was uploaded or reused, and nothing else does. Whatever the archive does with it leaves the
 * publish's answer as it is. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { UPLOADER, type Actor } from '../../src/domain/actor.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { Logger } from '../../src/domain/Logger.js';
import { PublishService, type PublishArchiveImages } from '../../src/domain/PublishService.js';
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

const IMAGE = { thumbnail: Buffer.from([1, 2, 3]), thumbnail_mime: 'image/png' };

interface Told {
  stream: StreamRow;
  actor: Actor;
  /** The feed's writes, and the row's status in the store, when the archive was told. */
  writes: number;
  status: string;
}

/** The archive's side: every image told, with what the feed and the row said then. */
class RecordingImages implements PublishArchiveImages {
  readonly told: Told[] = [];
  throws: Error | null = null;
  constructor(
    private readonly gateway: FakeFeedGateway,
    private readonly store: FakeStreamStore,
  ) {}

  imagePublished(stream: StreamRow, actor: Actor): void {
    this.told.push({
      stream,
      actor,
      writes: this.gateway.writes.length,
      status: this.store.get(stream.id).status,
    });
    if (this.throws) throw this.throws;
  }
}

function setup() {
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const gateway = new FakeFeedGateway();
  const stages = stagesWithMain(undefined, { owner: `0x${TEST_OWNER}` });
  const service = new PublishService(
    store,
    renditions,
    stages,
    new FakeFeedWriteLog(),
    gateway,
    noCatalogueStamp(),
    feed,
    new InMemoryAuditLog(),
  );
  const images = new RecordingImages(gateway, store);
  service.stampArchiveImagesWith(images);
  return { store, gateway, service, images };
}

describe('PublishService, the image told to the archive', () => {
  it('tells the archive the image a first publish uploaded, once the entry is on the feed, with who published', async () => {
    const { store, gateway, service, images } = setup();
    const row = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), IMAGE);

    const outcome = await service.publish(TEST_OPERATOR, row.id);

    assert.equal(gateway.thumbnails.length, 1, 'uploaded');
    assert.equal(images.told.length, 1);
    const [told] = images.told;
    assert.equal(told!.stream.id, row.id);
    assert.match(told!.stream.thumbnail_ref ?? '', /^[0-9a-f]{64}$/);
    assert.equal(told!.stream.thumbnail_ref, outcome.stream.thumbnail_ref);
    assert.deepEqual(told!.actor, TEST_OPERATOR);
    assert.equal(told!.writes, 1, 'the entry was on the feed');
    assert.equal(told!.status, 'published', 'the publish was finished');
  });

  it('tells it on a republish by hand that reused the image and wrote nothing', async () => {
    const { store, gateway, service, images } = setup();
    const row = store.add(
      streamRow({
        status: 'vod',
        manifest_index: 7,
        duration_seconds: 61,
        published_feed_index: 0,
        has_thumbnail: true,
        thumbnail_mime: 'image/png',
      }),
      IMAGE,
    );
    const first = await service.publish(TEST_OPERATOR, row.id);

    const again = await service.publish(TEST_OPERATOR, row.id);

    assert.equal(again.written, false, 'the head carries the entry already');
    assert.equal(gateway.thumbnails.length, 1, 'the image was reused');
    assert.equal(images.told.length, 2, 'told on both');
    assert.equal(images.told[1]!.stream.thumbnail_ref, first.stream.thumbnail_ref);
  });

  it('tells it nothing for an entry with no image', async () => {
    const { store, service, images } = setup();
    const row = store.add(streamRow());

    await service.publish(TEST_OPERATOR, row.id);

    assert.equal(images.told.length, 0);
  });

  it('tells it nothing for a state report, a reconcile, an unpublish or a publish that failed', async () => {
    const { store, gateway, service, images } = setup();
    const live = store.add(streamRow({ status: 'live', has_thumbnail: true, thumbnail_mime: 'image/png' }), IMAGE);
    await service.republishWithState(UPLOADER, store.get(live.id));
    await service.reconcile(TEST_OPERATOR);
    const draft = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), IMAGE);
    gateway.failNextWrite = new Error('postage batch not usable');
    await assert.rejects(() => service.publish(TEST_OPERATOR, draft.id));
    assert.equal(images.told.length, 0);

    await service.publish(TEST_OPERATOR, draft.id);
    assert.equal(images.told.length, 1, 'the publish that went through');
    await service.unpublish(TEST_OPERATOR, draft.id);
    assert.equal(images.told.length, 1);
  });

  it("leaves the publish's answer as it is when the archive throws, and says so in the log", async () => {
    const { store, service, images } = setup();
    images.throws = new Error('the archive is not ready');
    const row = store.add(streamRow({ has_thumbnail: true, thumbnail_mime: 'image/png' }), IMAGE);
    const warn = mock.method(Logger.getInstance(), 'warn', () => undefined);
    try {
      const outcome = await service.publish(TEST_OPERATOR, row.id);
      assert.equal(outcome.stream.status, 'published');
      assert.equal(store.get(row.id).publish_error, null);
    } finally {
      warn.mock.restore();
    }
    assert.equal(images.told.length, 1);
    assert.ok(
      warn.mock.calls.some((call) => /the archive was not told the image of/.test(String(call.arguments[0]))),
      'said in the log',
    );
  });
});
