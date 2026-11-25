/**
 * The stream's image under the archive stamps, against a node, a store and the image's upload in memory: an archive
 * job stamps the image the stream names under its stamp with its first quality on every pass, outside the quality's
 * counts, and a publish that names an image stamps it under every archive stamp that holds a copy of the stream, can
 * be written and has no record of it. Either way it is recorded only when the upload answers the stream's reference,
 * and a failure is said in the log and left out. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { MANAGER } from '../../src/domain/actor.js';
import type { ArchiveItemRow } from '../../src/domain/archive/ArchiveRepository.js';
import { ArchiveService } from '../../src/domain/archive/ArchiveService.js';
import { streamArchiveThumbnails } from '../../src/domain/archive/ArchiveThumbnails.js';
import { ChunkCopier } from '../../src/domain/archive/ChunkCopier.js';
import { Logger } from '../../src/domain/Logger.js';
import type { StreamRow } from '../../src/types/index.js';
import {
  archiveBatch,
  buildFile,
  FakeArchiveNode,
  FakeArchiveThumbnails,
  FakeCatalogue,
  InMemoryArchiveStore,
  playlistText,
  slotFor,
  type BuiltFile,
} from './support/archiveFakes.js';
import { FakeRenditions, FakeStreams } from './support/exportFakes.js';
import { InMemoryAuditLog, streamRow, TEST_OPERATOR } from './support/fakes.js';

const OWNER = '1234567890abcdef1234567890abcdef12345678';
const TOPIC = '0b7c3a1e-2f44-5d66-8a77-99aabbccddee';
const BATCH = 'a'.repeat(64);
const OTHER_BATCH = 'b'.repeat(64);
const IMAGE = 'd'.repeat(64);
const OLD_IMAGE = 'e'.repeat(64);
const FILE = { bytes: new Uint8Array([1, 2, 3]), filename: `${TOPIC}.png`, contentType: 'image/png' };

let streams: FakeStreams;
let store: InMemoryArchiveStore;
let catalogue: FakeCatalogue;
let node: FakeArchiveNode;
let thumbnails: FakeArchiveThumbnails;
let service: ArchiveService;
let own: BuiltFile[];

function makeService(): ArchiveService {
  return new ArchiveService(
    store,
    streams,
    new FakeRenditions(),
    catalogue,
    node,
    new ChunkCopier(node, { retryDelaysMs: [1] }),
    thumbnails,
    null,
    { republishWithState: async () => undefined },
    { exportHoldingPlace: async () => null },
    new InMemoryAuditLog(),
    {
      settings: {
        parallelChunks: 4,
        pushWindowChunks: 100,
        chequebookFloorPlur: '0',
        ttlWarningDays: 30,
        buyDefaultDays: 30,
      },
      watchIntervalMs: 60_000,
      statusCheckMs: 0,
      fundsCheckMs: 0,
      pollMs: 1,
      tagStallMs: 20_000,
      purchaseTimeoutMs: 60_000,
      purchaseAnswerWaitMs: 50,
    },
  );
}

/** A finished single-quality recording of three segments, its slot and chunks on the network. */
function recorded(over: Partial<StreamRow> = {}): StreamRow {
  const stream = streamRow({
    id: 'stream-1',
    title: 'Alps',
    owner: OWNER,
    topic: TOPIC,
    status: 'vod',
    manifest_index: 5,
    duration_seconds: 6,
    has_thumbnail: true,
    thumbnail_mime: 'image/png',
    thumbnail_ref: IMAGE,
    ...over,
  });
  streams.rows.set(stream.id, stream);
  own = [0, 1, 2].map(() => buildFile(new Uint8Array(randomBytes(100 * 1024)), 1));
  for (const file of own) for (const [address, chunk] of file.chunks) node.network.set(address, chunk);
  slotFor(OWNER, TOPIC, 5, playlistText(own.map((file) => file.root)), node.network);
  return stream;
}

async function archive(): Promise<void> {
  await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['source'], target: { batchId: BATCH } });
}

async function jobState(): Promise<string> {
  return (await service.current(TEST_OPERATOR.userId))!.state;
}

async function item(): Promise<ArchiveItemRow> {
  return (await store.items(store.job!.id))[0]!;
}

/** The quality's counts hold its own chunks alone, and every post counted under its tag. */
function assertOwnCounts(row: ArchiveItemRow): void {
  const mine = new Set(node.posts.filter((post) => post.tag === row.tag_uid).map((post) => post.address));
  assert.equal(row.chunks_copied, mine.size, 'its own chunks, each once');
  assert.equal(row.posts_under_tag, node.tags.get(row.tag_uid!)!.split, 'every post under its tag');
}

/** A complete copy of the stream's one quality on the stamp, as a job leaves it. */
async function copyOn(batchId: string): Promise<void> {
  await store.startArchive({
    stream_id: 'stream-1',
    rendition: 'source',
    batch_id: batchId,
    feed_owner: OWNER,
    feed_topic: TOPIC,
    manifest_index: 5,
    parity_missing: 0,
    segments: 3,
    chunks: 90,
    bytes: 300 * 1024,
    chunks_rebuilt: 0,
    bucket_sum_before: 0,
    bucket_sum_after: null,
    bzz_spent_estimate_plur: null,
  });
  await store.completeArchive('stream-1', 'source', batchId, TEST_OPERATOR.userId, TEST_OPERATOR.username);
}

async function recordOn(batchId: string, reference: string): Promise<void> {
  await store.recordThumbnail({
    stream_id: 'stream-1',
    batch_id: batchId,
    thumbnail_ref: reference,
    stamped_by_user_id: null,
    stamped_by: 'an earlier job',
  });
}

function recordedOn(batchId: string): string | undefined {
  return store.thumbnails.get(`stream-1:${batchId}`)?.thumbnail_ref;
}

function stampsUploaded(): string[] {
  return thumbnails.restamped.map((upload) => upload.target.batchId);
}

/** The lines the logger was told at `level` while `run` ran that name the image. */
async function imageLines(level: 'warn' | 'info', run: () => Promise<void>): Promise<string[]> {
  const said = mock.method(Logger.getInstance(), level, () => undefined);
  try {
    await run();
  } finally {
    said.mock.restore();
  }
  return said.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('image'));
}

beforeEach(() => {
  streams = new FakeStreams();
  store = new InMemoryArchiveStore((id) => streams.rows.get(id)?.title ?? null);
  catalogue = new FakeCatalogue();
  catalogue.batches = [archiveBatch(BATCH), archiveBatch(OTHER_BATCH, { label: 'archive two' })];
  node = new FakeArchiveNode();
  thumbnails = new FakeArchiveThumbnails();
  thumbnails.files.set('stream-1', FILE);
  service = makeService();
});

afterEach(async () => {
  node.release();
  thumbnails.release();
  await service.shutdown();
});

describe('ArchiveService, the image in an archive job', () => {
  it("stamps the image under the job's stamp from the row's file, records who started the job, outside the counts", async () => {
    recorded();
    await archive();
    await service.settled();

    assert.equal(await jobState(), 'done');
    assert.deepEqual(thumbnails.restamped, [
      { reference: IMAGE, file: FILE, target: { beeApiUrl: catalogue.beeApiUrl, batchId: BATCH } },
    ]);
    const record = store.thumbnails.get(`stream-1:${BATCH}`)!;
    assert.equal(record.thumbnail_ref, IMAGE);
    assert.equal(record.stamped_by_user_id, TEST_OPERATOR.userId);
    assert.equal(record.stamped_by, TEST_OPERATOR.username);
    const row = await item();
    assert.equal(row.result, 'complete');
    assert.equal(row.segments_total, own.length);
    assertOwnCounts(row);
  });

  it('reads the image from the network when the row holds no bytes of it', async () => {
    recorded();
    thumbnails.files.clear();
    await archive();
    await service.settled();

    assert.equal(thumbnails.restamped.length, 1);
    assert.equal(thumbnails.restamped[0]!.file, null);
    assert.equal(recordedOn(BATCH), IMAGE);
  });

  it('stamps it again on every pass, and keeps it out of the counts across a pause', async () => {
    recorded();
    node.holdAfter = 60;
    await archive();
    for (let attempt = 0; attempt < 2_000 && !node.held; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(node.held, 'a copy in the middle');
    const pausing = service.act(TEST_OPERATOR, store.job!.id, { action: 'pause' });
    node.release();
    await pausing;
    await service.act(TEST_OPERATOR, store.job!.id, { action: 'resume' });
    await service.settled();

    assert.equal(await jobState(), 'done');
    assert.equal(thumbnails.restamped.length, 2, 'once on each pass');
    assert.equal(recordedOn(BATCH), IMAGE);
    const row = await item();
    assert.equal(row.segments_done, own.length);
    assertOwnCounts(row);
  });

  it('logs an upload that failed, records nothing, and completes the job', async () => {
    recorded();
    thumbnails.failing.add(BATCH);
    const said = await imageLines('warn', async () => {
      await archive();
      await service.settled();
    });

    assert.equal(await jobState(), 'done');
    assert.equal((await item()).result, 'complete');
    assert.equal(recordedOn(BATCH), undefined);
    assert.equal(said.length, 1);
    assert.match(said[0]!, /the image of "Alps" is not stamped under aaaaaaaa…: the node refused the upload/);
  });

  it('logs an upload that answered another reference, and records nothing', async () => {
    recorded();
    thumbnails.answers.set(IMAGE, OLD_IMAGE);
    const said = await imageLines('warn', async () => {
      await archive();
      await service.settled();
    });

    assert.equal(await jobState(), 'done');
    assert.equal(recordedOn(BATCH), undefined);
    assert.equal(said.length, 1);
    assert.match(said[0]!, new RegExp(`the image ${IMAGE} of "Alps" came out as ${OLD_IMAGE}`));
  });

  it('stamps nothing for a stream with no image', async () => {
    recorded({ has_thumbnail: false, thumbnail_mime: null, thumbnail_ref: null });
    await archive();
    await service.settled();

    assert.equal(await jobState(), 'done');
    assert.equal(thumbnails.restamped.length, 0);
    assert.equal(store.thumbnails.size, 0);
  });

  it('leaves an image with no reference yet to its publish', async () => {
    recorded({ thumbnail_ref: null });
    const said = await imageLines('info', async () => {
      await archive();
      await service.settled();
    });

    assert.equal(await jobState(), 'done');
    assert.equal(thumbnails.restamped.length, 0);
    assert.equal(store.thumbnails.size, 0);
    assert.ok(said.some((line) => line.includes('the image of "Alps" is not published yet; its publish stamps it')));
  });
});

describe('ArchiveService.imagePublished', () => {
  it('stamps a new image under every stamp that holds a copy, with who published', async () => {
    const stream = recorded();
    await copyOn(BATCH);
    await copyOn(OTHER_BATCH);
    await recordOn(BATCH, OLD_IMAGE);

    service.imagePublished(stream, TEST_OPERATOR);
    await service.settled();

    assert.deepEqual(stampsUploaded(), [BATCH, OTHER_BATCH]);
    assert.ok(thumbnails.restamped.every((upload) => upload.reference === IMAGE && upload.file === FILE));
    for (const batchId of [BATCH, OTHER_BATCH]) {
      const record = store.thumbnails.get(`stream-1:${batchId}`)!;
      assert.equal(record.thumbnail_ref, IMAGE);
      assert.equal(record.stamped_by_user_id, TEST_OPERATOR.userId);
      assert.equal(record.stamped_by, TEST_OPERATOR.username);
    }
  });

  it('returns at once, and settled() waits for the stamping', async () => {
    const stream = recorded();
    await copyOn(BATCH);
    thumbnails.hold();

    service.imagePublished(stream, TEST_OPERATOR);
    assert.equal(recordedOn(BATCH), undefined, 'nothing stamped yet');
    const settling = service.settled();
    thumbnails.release();
    await settling;

    assert.equal(recordedOn(BATCH), IMAGE);
  });

  it('leaves out a stamp that holds the image already', async () => {
    const stream = recorded();
    await copyOn(BATCH);
    await copyOn(OTHER_BATCH);
    await recordOn(BATCH, IMAGE.toUpperCase());

    service.imagePublished(stream, TEST_OPERATOR);
    await service.settled();

    assert.deepEqual(stampsUploaded(), [OTHER_BATCH]);
  });

  for (const [what, batch] of [
    ['has run out', { state: 'expired' }],
    ['is full', { state: 'full' }],
    ['sits on a former catalogue node', { writable: false }],
  ] as const) {
    it(`leaves out a stamp that ${what}, and its record stays`, async () => {
      const stream = recorded();
      catalogue.batches = [archiveBatch(BATCH, batch), archiveBatch(OTHER_BATCH, { label: 'archive two' })];
      await copyOn(BATCH);
      await copyOn(OTHER_BATCH);
      await recordOn(BATCH, OLD_IMAGE);

      const said = await imageLines('info', async () => {
        service.imagePublished(stream, TEST_OPERATOR);
        await service.settled();
      });

      assert.deepEqual(stampsUploaded(), [OTHER_BATCH]);
      assert.equal(recordedOn(BATCH), OLD_IMAGE);
      assert.equal(recordedOn(OTHER_BATCH), IMAGE);
      assert.ok(said.some((line) => line.includes('the image of "Alps" is not stamped under archive one')));
    });
  }

  it('leaves out a stamp the manager lists no longer', async () => {
    const stream = recorded();
    catalogue.batches = [archiveBatch(OTHER_BATCH)];
    await copyOn(BATCH);
    await copyOn(OTHER_BATCH);

    service.imagePublished(stream, TEST_OPERATOR);
    await service.settled();

    assert.deepEqual(stampsUploaded(), [OTHER_BATCH]);
    assert.equal(recordedOn(BATCH), undefined);
  });

  it('goes on to the next stamp past a failure, and never throws', async () => {
    const stream = recorded();
    await copyOn(BATCH);
    await copyOn(OTHER_BATCH);
    await recordOn(BATCH, OLD_IMAGE);
    thumbnails.failing.add(BATCH);

    const said = await imageLines('warn', async () => {
      assert.doesNotThrow(() => service.imagePublished(stream, TEST_OPERATOR));
      await service.settled();
    });

    assert.equal(recordedOn(BATCH), OLD_IMAGE, 'its record stays');
    assert.equal(recordedOn(OTHER_BATCH), IMAGE);
    assert.equal(said.length, 1);
    assert.match(said[0]!, /the image of "Alps" is not stamped under archive one: the node refused the upload/);
  });

  it('records nothing on a stamp whose upload answered another reference', async () => {
    const stream = recorded();
    await copyOn(BATCH);
    thumbnails.answers.set(IMAGE, OLD_IMAGE);

    await imageLines('warn', async () => {
      service.imagePublished(stream, TEST_OPERATOR);
      await service.settled();
    });

    assert.equal(thumbnails.restamped.length, 1);
    assert.equal(recordedOn(BATCH), undefined);
  });

  it('stamps nothing for a stream with no copy', async () => {
    const stream = recorded();

    service.imagePublished(stream, TEST_OPERATOR);
    await service.settled();

    assert.equal(thumbnails.restamped.length, 0);
    assert.equal(store.thumbnails.size, 0);
  });

  it('stamps nothing when there is no catalogue node, and says so', async () => {
    const stream = recorded();
    await copyOn(BATCH);
    catalogue.designated = false;

    const said = await imageLines('warn', async () => {
      service.imagePublished(stream, TEST_OPERATOR);
      await service.settled();
    });

    assert.equal(thumbnails.restamped.length, 0);
    assert.equal(said.length, 1);
  });

  it('stamps nothing for a stream that names no image, and records no user for a caller that is none', async () => {
    const stream = recorded();
    await copyOn(BATCH);

    service.imagePublished({ ...stream, thumbnail_ref: null }, TEST_OPERATOR);
    await service.settled();
    assert.equal(thumbnails.restamped.length, 0);

    service.imagePublished(stream, MANAGER);
    await service.settled();
    const record = store.thumbnails.get(`stream-1:${BATCH}`)!;
    assert.equal(record.stamped_by_user_id, null);
    assert.equal(record.stamped_by, 'the manager');
  });

  it('stamps one publish after another, the later image last', async () => {
    const stream = recorded();
    await copyOn(BATCH);
    thumbnails.hold();

    service.imagePublished({ ...stream, thumbnail_ref: OLD_IMAGE }, TEST_OPERATOR);
    service.imagePublished(stream, TEST_OPERATOR);
    thumbnails.release();
    await service.settled();

    assert.deepEqual(
      thumbnails.restamped.map((upload) => upload.reference),
      [OLD_IMAGE, IMAGE],
    );
    assert.equal(recordedOn(BATCH), IMAGE);
  });
});

describe('streamArchiveThumbnails', () => {
  const rows = new Map([['stream-1', { thumbnail: Buffer.from([1, 2, 3]), thumbnail_mime: 'image/webp' }]]);
  const streamsOf = {
    findById: async (id: string) => (id === 'missing' ? null : { topic: TOPIC }),
    findThumbnail: async (id: string) => rows.get(id) ?? null,
  };
  const uploads: unknown[] = [];
  const images = streamArchiveThumbnails(streamsOf, {
    restampThumbnail: async (reference, file, target) => {
      uploads.push({ reference, file, target });
      return reference;
    },
  });

  it('names the file by the topic and type, as a publish and a catalogue move name it', async () => {
    assert.deepEqual(await images.fileOf('stream-1'), {
      bytes: new Uint8Array([1, 2, 3]),
      filename: `${TOPIC}.webp`,
      contentType: 'image/webp',
    });
  });

  it('answers null for a row that holds no bytes, or no row', async () => {
    assert.equal(await images.fileOf('stream-2'), null);
    assert.equal(await images.fileOf('missing'), null);
  });

  it("restamps through the catalogue move's upload", async () => {
    const target = { beeApiUrl: 'http://catalogue-node.test:1633', batchId: BATCH };
    assert.equal(await images.restamp(IMAGE, null, target), IMAGE);
    assert.deepEqual(uploads, [{ reference: IMAGE, file: null, target }]);
  });
});
