/**
 * Archiving a recording, against a node, a store and a manager in memory: a whole archive from measuring to done, the
 * completion rule on the tag, every pause and what a user does about it, the place shared with the export, a resume
 * after a pause and after a restart, a tag the node forgot, the push window, purchases, and the listing switch.
 * `pnpm test`.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  archiveBatchCostPlur,
  archiveChunksWithMargin,
  smallestArchiveDepthFor,
  type FundingInventory,
  FundingStampPurchaseAnswer,
  FundingStampPurchaseRequest,
  FundingStampPurchaseStatus,
} from '@streaming-monorepo/contracts';
import { ARCHIVE_PURCHASES_NOT_OFFERED, type ArchiveJobSummary } from '@streaming-monorepo/web2-admin-common';

import { ArchiveService, tagComplete, type ArchiveServiceOptions } from '../../src/domain/archive/ArchiveService.js';
import { ChunkCopier } from '../../src/domain/archive/ChunkCopier.js';
import { ArchiveRefusedError } from '../../src/domain/errors/index.js';
import { ManagerFundingError } from '../../src/domain/funding/ManagerFundingClient.js';
import type { StreamRenditionRow, StreamRow } from '../../src/types/index.js';
import type { ArchiveSettings } from '../../src/utils/archiveSettings.js';
import {
  archiveBatch,
  buildFile,
  FakeArchiveNode,
  FakeCatalogue,
  InMemoryArchiveStore,
  playlistText,
  slotFor,
  type BuiltFile,
} from './support/archiveFakes.js';
import { FakeRenditions, FakeStreams } from './support/exportFakes.js';
import { InMemoryAuditLog, streamRow, TEST_OPERATOR } from './support/fakes.js';

const OWNER = '1234567890abcdef1234567890abcdef12345678';
const STREAM_TOPIC = '0b7c3a1e-2f44-5d66-8a77-99aabbccddee';
const RUNG_720 = '9a7b6c5d-1111-5222-8333-777788889999';
const RUNG_360 = '9a7b6c5d-1111-5222-8333-444455556666';
const BATCH = 'a'.repeat(64);
const OTHER_BATCH = 'b'.repeat(64);
const NEW_BATCH = 'e'.repeat(64);
const OTHER_OPERATOR = {
  kind: 'operator',
  userId: '00000000-0000-4000-8000-000000000002',
  username: 'other-operator',
} as const;
/** What 30 days of postage cost per chunk at the fake price: 518,400 blocks of 24,000 PLUR. */
const THIRTY_DAYS = (518_400n * 24_000n).toString();

/** A buy choice of `depth` for 30 days, at the cost the fake price gives. */
function choice(depth: number, label: string | null = null) {
  return { depth, days: 30, label, costPlur: archiveBatchCostPlur(depth, THIRTY_DAYS) };
}

const SETTINGS: ArchiveSettings = {
  parallelChunks: 4,
  pushWindowChunks: 100,
  chequebookFloorPlur: '1000000000000000',
  ttlWarningDays: 30,
  buyDefaultDays: 30,
};

/** A push window wider than any recording here, for the tests that hold Bee's pushes back. */
const WIDE = { settings: { ...SETTINGS, pushWindowChunks: 100_000 } };

class FakeManager {
  readonly inventoryValue: FundingInventory;
  readonly requests: FundingStampPurchaseRequest[] = [];
  readonly statuses = new Map<string, FundingStampPurchaseStatus | 'unknown_request'>();

  constructor(chequebookPlur: string) {
    this.inventoryValue = {
      observedAt: new Date().toISOString(),
      chain: {
        chainId: 100,
        bzzToken: `0x${'1'.repeat(40)}`,
        postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
      },
      stages: [],
      catalogue: {
        nodeId: 'catalogue-node',
        label: 'catalogue',
        role: 'uploader',
        walletAddress: `0x${'2'.repeat(40)}`,
        xdaiWei: '1000000000000000000',
        xbzzPlur: '10000000000000000000',
        readError: null,
        chequebook: {
          address: `0x${'3'.repeat(40)}`,
          availablePlur: chequebookPlur,
          totalPlur: chequebookPlur,
          readError: null,
        },
      },
    } as unknown as FundingInventory;
  }

  async inventory(): Promise<FundingInventory> {
    return this.inventoryValue;
  }

  /** What the manager answers a purchase with instead, as a refusal. */
  refusal: ManagerFundingError | null = null;

  /**
   * Holds a purchase's answer until it settles, then ends the call as the admin's own deadline does: the manager is
   * still waiting on the node, and no answer came.
   */
  late: Promise<void> | null = null;

  async stampPurchase(request: FundingStampPurchaseRequest): Promise<FundingStampPurchaseAnswer> {
    this.requests.push(request);
    if (this.late) {
      await this.late;
      throw new ManagerFundingError('timeout', null, 'The manager did not answer in time.');
    }
    if (this.refusal) throw this.refusal;
    return { requestId: request.requestId, state: 'unknown', batchId: null, txHash: null };
  }

  async stampPurchaseStatus(requestId: string): Promise<FundingStampPurchaseStatus> {
    const status = this.statuses.get(requestId);
    if (status === 'unknown_request') throw new ManagerFundingError('unknown_request', 404, 'No such purchase.');
    return status ?? { requestId, state: 'unknown', batchId: null, txHash: null, usable: null, error: null };
  }

  setChequebook(plur: string): void {
    this.inventoryValue.catalogue!.chequebook!.availablePlur = plur;
  }
}

let streams: FakeStreams;
let renditions: FakeRenditions;
let store: InMemoryArchiveStore;
let catalogue: FakeCatalogue;
let node: FakeArchiveNode;
let manager: FakeManager;
let audit: InMemoryAuditLog;
let republished: StreamRow[];
let exportBusy: string | null;
let service: ArchiveService;
let segments: Map<string, BuiltFile[]>;

function makeService(over: Partial<ArchiveServiceOptions> = {}): ArchiveService {
  return new ArchiveService(
    store,
    streams,
    renditions,
    catalogue,
    node,
    new ChunkCopier(node, { retryDelaysMs: [1] }),
    manager,
    { republishWithState: async (_actor, stream) => void republished.push(stream) },
    { exportHoldingPlace: async () => exportBusy },
    audit,
    {
      settings: SETTINGS,
      watchIntervalMs: 60_000,
      statusCheckMs: 0,
      fundsCheckMs: 0,
      pollMs: 1,
      tagStallMs: 20_000,
      purchaseTimeoutMs: 60_000,
      purchaseAnswerWaitMs: 50,
      ...over,
    },
  );
}

function rung(name: string, topic: string, height: number): StreamRenditionRow {
  return {
    stream_id: 'stream-1',
    name,
    width: Math.round((height * 16) / 9),
    height,
    topic,
    bandwidth: 800_000,
    avg_bandwidth: 600_000,
    manifest_index: 5,
    duration_seconds: 6,
    updated_at: new Date(),
  };
}

/** A finished recording with a 720p and a 360p rung, three segments each, its slots and chunks on the network. */
function recorded(): StreamRow {
  const stream = streamRow({
    id: 'stream-1',
    title: 'Alps',
    owner: OWNER,
    topic: STREAM_TOPIC,
    status: 'vod',
    manifest_index: 7,
    duration_seconds: 6,
    live_since: new Date('2026-11-12T09:52:00.000Z'),
    ended_at: new Date('2026-11-12T09:53:00.000Z'),
  });
  streams.rows.set(stream.id, stream);
  renditions.rows.set(stream.id, [rung('720p', RUNG_720, 720), rung('360p', RUNG_360, 360)]);
  segments = new Map();
  for (const [name, topic, kilobytes] of [
    ['720p', RUNG_720, 300],
    ['360p', RUNG_360, 120],
  ] as const) {
    // Random bytes, as video is: no two data chunks alike.
    const files = [0, 1, 2].map(() => buildFile(new Uint8Array(randomBytes(kilobytes * 1024)), 1));
    for (const file of files) for (const [address, chunk] of file.chunks) node.network.set(address, chunk);
    slotFor(OWNER, topic, 5, playlistText(files.map((file) => file.root)), node.network);
    segments.set(name, files);
  }
  slotFor(OWNER, STREAM_TOPIC, 7, '#EXTM3U\n720p\n360p', node.network);
  return stream;
}

/** Every chunk of one quality's segments. */
function chunksOf(rendition: string): Set<string> {
  const all = new Set<string>();
  for (const file of segments.get(rendition)!) for (const address of file.chunks.keys()) all.add(address);
  return all;
}

async function until(test: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`never: ${what}`);
}

async function job(): Promise<ArchiveJobSummary> {
  const current = await service.current(TEST_OPERATOR.userId);
  assert.ok(current, 'an archive is on the server');
  return current;
}

function jobId(): string {
  return store.job!.id;
}

beforeEach(() => {
  streams = new FakeStreams();
  renditions = new FakeRenditions();
  store = new InMemoryArchiveStore((id) => streams.rows.get(id)?.title ?? null);
  catalogue = new FakeCatalogue();
  catalogue.batches = [archiveBatch(BATCH), archiveBatch(OTHER_BATCH, { label: 'archive two' })];
  node = new FakeArchiveNode();
  manager = new FakeManager('50000000000000000');
  audit = new InMemoryAuditLog();
  republished = [];
  exportBusy = null;
  service = makeService();
});

afterEach(async () => {
  node.release();
  await service.shutdown();
});

describe('ArchiveService', () => {
  it('copies every chosen quality onto the stamp, then completes each once Bee reports every post synced', async () => {
    recorded();
    const started = await service.start(TEST_OPERATOR, 'stream-1', {
      renditions: ['720p', '360p'],
      target: { batchId: BATCH },
    });
    assert.equal(started.state, 'measuring');
    await service.settled();

    const done = await job();
    assert.equal(done.state, 'done');
    assert.deepEqual(
      done.items.map((item) => [item.rendition, item.state, item.result]),
      [
        ['720p', 'done', 'complete'],
        ['360p', 'done', 'complete'],
      ],
    );
    const stamped = node.stamped.get(BATCH)!;
    for (const address of [...chunksOf('720p'), ...chunksOf('360p')]) assert.ok(stamped.has(address));
    const archives = await store.archivesOf(['stream-1']);
    assert.deepEqual(archives.map((row) => [row.rendition, row.state]).sort(), [
      ['360p', 'complete'],
      ['720p', 'complete'],
    ]);
    assert.ok(archives.every((row) => row.batch_id === BATCH && row.completed_by === 'test-operator'));
    const summary = (await service.summaries([streams.rows.get('stream-1')!])).get('stream-1');
    assert.deepEqual(summary, { state: 'complete', archived: ['720p', '360p'], archivedOnly: false });
    assert.ok(audit.entries.some((entry) => entry.action === 'archive.done'));
    assert.equal(audit.entries.filter((entry) => entry.action === 'archive.quality.done').length, 2);
  });

  it("copies the master slot with the first quality, and each quality under that quality's own tag", async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p', '720p'], target: { batchId: BATCH } });
    await service.settled();
    assert.equal(node.posts.filter((post) => post.kind === 'soc').length, 3, 'the master slot and each quality slot');
    const items = await store.items(jobId());
    assert.notEqual(items[0]!.tag_uid, items[1]!.tag_uid);
    for (const item of items) {
      assert.equal(node.posts.filter((post) => post.tag === item.tag_uid).length, item.posts_under_tag);
    }
  });

  it('holds the completion back while Bee lags, and completes once it pushes', async () => {
    recorded();
    node.autoPush = false;
    service = makeService(WIDE);
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await until(async () => (await job()).state === 'verifying', 'verifying');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await job()).state, 'verifying', 'nothing completes while the tag lags');
    assert.equal(store.archives.get('stream-1:360p')!.state, 'partial');
    for (const uid of node.tags.keys()) node.push(uid);
    await service.settled();
    assert.equal((await job()).state, 'done');
  });

  it('counts a re-post of a chunk still queued as seen, and completes with the first post', async () => {
    recorded();
    node.autoPush = false;
    service = makeService(WIDE);
    node.holdAfter = 20;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['720p'], target: { batchId: BATCH } });
    await until(() => node.held, 'a copy in the middle of a segment');
    const pausing = service.act(TEST_OPERATOR, jobId(), { action: 'pause' });
    node.release();
    await pausing;
    assert.equal(store.job!.state, 'paused');
    await service.act(TEST_OPERATOR, jobId(), { action: 'resume' });
    await until(async () => (await job()).state === 'verifying', 'verifying');
    const uid = (await store.items(jobId()))[0]!.tag_uid!;
    for (const tag of node.tags.keys()) node.push(tag);
    await service.settled();
    const tag = (await node.readTag('', uid))!;
    assert.ok(tag.seen > 0, 'the segment copied again found its chunks still queued');
    assert.ok(tagComplete(tag, tag.split));
    const item = (await job()).items[0]!;
    assert.equal(item.postsMade, tag.split);
    assert.equal(item.chunksSynced, tag.synced + tag.seen, 'settled: synced and seen together');
    assert.equal((await store.items(jobId()))[0]!.chunks_seen, tag.seen);
    assert.equal((await job()).state, 'done');
  });

  it('completes a quality with reduced protection when a parity chunk was lost, and says so on the stream', async () => {
    recorded();
    node.network.delete(segments.get('360p')![1]!.parity[0]!);
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    const item = (await job()).items[0]!;
    assert.equal(item.result, 'reduced');
    assert.equal(item.parityMissing, 1);
    assert.equal(store.archives.get('stream-1:360p')!.parity_missing, 1);
    const summary = (await service.summaries([streams.rows.get('stream-1')!])).get('stream-1');
    assert.equal(summary?.state, 'reduced');
  });

  it('pauses with the node when a parity read goes unanswered, and completes in full on Resume once it answers', async () => {
    recorded();
    const parity = segments.get('360p')![1]!.parity[0]!;
    node.unreachable.add(parity);
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    let current = await job();
    assert.equal(current.state, 'paused');
    assert.equal(current.pauseReason, 'node');
    assert.equal(current.items[0]!.parityMissing, 0, 'an outage loses no parity');

    node.unreachable.delete(parity);
    await service.act(TEST_OPERATOR, current.id, { action: 'resume' });
    await service.settled();
    current = await job();
    assert.equal(current.state, 'done');
    assert.equal(current.items[0]!.result, 'complete');
    assert.equal(store.archives.get('stream-1:360p')!.parity_missing, 0);
  });

  it('pauses with the node, not as unreadable, when a segment read goes unanswered while measuring', async () => {
    recorded();
    node.unreachable.add(segments.get('360p')![0]!.root);
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    const current = await job();
    assert.equal(current.state, 'paused');
    assert.equal(current.pauseReason, 'node');
  });

  it('pauses on a data chunk neither read nor rebuilt, completes nothing, and copies it on Resume once it is back', async () => {
    recorded();
    const lost = segments.get('360p')![2]!.data[1]!;
    const bytes = node.network.get(lost)!;
    node.network.delete(lost);
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    let current = await job();
    assert.equal(current.state, 'paused');
    assert.equal(current.pauseReason, 'unreadable');
    assert.equal(store.archives.get('stream-1:360p')!.state, 'partial');
    assert.deepEqual(current.actions, ['resume', 'cancel']);

    node.network.set(lost, bytes);
    await service.act(TEST_OPERATOR, current.id, { action: 'resume' });
    await service.settled();
    current = await job();
    assert.equal(current.state, 'done');
  });

  it('pauses when the stream goes live, waits on Wait, and archives the recording once it finishes', async () => {
    const stream = recorded();
    streams.rows.set(stream.id, { ...stream, status: 'live' });
    await assert.rejects(
      () => service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } }),
      (error) => error instanceof ArchiveRefusedError && error.problem === 'not_finished',
    );
    streams.rows.set(stream.id, stream);
    node.holdAfter = 5;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await until(() => node.held, 'copying');
    streams.rows.set(stream.id, { ...stream, status: 'live' });
    node.release();
    await service.settled();
    let current = await job();
    assert.equal(current.pauseReason, 'live');
    assert.deepEqual(current.actions, ['wait', 'cancel']);

    await service.act(TEST_OPERATOR, current.id, { action: 'wait' });
    assert.equal((await job()).state, 'waiting');
    streams.rows.set(stream.id, stream);
    await service.tick();
    await service.settled();
    current = await job();
    assert.equal(current.state, 'done');
  });

  it('pauses when the stamp is full, and copies onto another stamp the user picks, from the start', async () => {
    recorded();
    node.refusing.set(BATCH, 'batch_full');
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    let current = await job();
    assert.equal(current.pauseReason, 'batch');
    assert.deepEqual(current.actions, ['resume', 'use_stamp', 'buy_new', 'cancel']);

    await service.act(TEST_OPERATOR, current.id, { action: 'use_stamp', batchId: OTHER_BATCH });
    await service.settled();
    current = await job();
    assert.equal(current.state, 'done');
    assert.equal(store.archives.get('stream-1:360p')!.batch_id, OTHER_BATCH);
    for (const address of chunksOf('360p')) assert.ok(node.stamped.get(OTHER_BATCH)!.has(address));
  });

  it('pauses before copying when the stamp has no room for the recording', async () => {
    recorded();
    node.used.set(BATCH, 1_000_000_000);
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['720p'], target: { batchId: BATCH } });
    await service.settled();
    const current = await job();
    assert.equal(current.pauseReason, 'batch');
    assert.match(current.pauseMessage!, /room for about 0 more chunks/);
    assert.equal(node.posts.length, 0);
  });

  it('pauses for funds when the catalogue chequebook is under the floor, and carries on once it is funded', async () => {
    recorded();
    manager.setChequebook('1');
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    let current = await job();
    assert.equal(current.pauseReason, 'funds');
    manager.setChequebook('50000000000000000');
    await service.act(TEST_OPERATOR, current.id, { action: 'resume' });
    await service.settled();
    current = await job();
    assert.equal(current.state, 'done');
  });

  it('shares the place with the export: no start while an export holds it, and it holds it while it runs', async () => {
    recorded();
    exportBusy = 'The export of "Alps" (720p) is running, started by other-operator. One export runs at a time.';
    await assert.rejects(
      () => service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } }),
      (error) => error instanceof ArchiveRefusedError && error.problem === 'busy' && error.message === exportBusy,
    );
    exportBusy = null;
    node.holdAfter = 3;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await until(() => node.held, 'copying');
    assert.match((await service.archiveHoldingPlace())!, /The archive of "Alps" is copying, started by test-operator/);
    node.release();
    await service.settled();
    assert.equal(await service.archiveHoldingPlace(), null, 'a finished archive holds nothing');
  });

  it('gives the place up on a user pause, and takes it again on Resume only once no export holds it', async () => {
    recorded();
    node.holdAfter = 30;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['720p'], target: { batchId: BATCH } });
    await until(() => node.held, 'copying');
    const pausing = service.act(OTHER_OPERATOR, jobId(), { action: 'pause' });
    node.release();
    const paused = await pausing;
    assert.equal(paused!.pauseReason, 'user');
    assert.equal(paused!.holdsPlace, false);
    assert.equal(await service.archiveHoldingPlace(), null, 'an export can start meanwhile');
    const done = await store.segmentsDone(jobId(), '720p');
    assert.ok(done.size > 0);

    store.exportHolds = true;
    exportBusy = 'The export of "Other" (1080p) is running, started by other-operator. One export runs at a time.';
    await assert.rejects(
      () => service.act(TEST_OPERATOR, jobId(), { action: 'resume' }),
      (error) => error instanceof ArchiveRefusedError && error.problem === 'busy' && error.message === exportBusy,
    );
    store.exportHolds = false;
    exportBusy = null;
    await service.act(TEST_OPERATOR, jobId(), { action: 'resume' });
    await service.settled();
    assert.equal((await job()).state, 'done');
    for (const reference of done) {
      assert.equal(
        node.posts.filter((post) => post.address === reference).length,
        1,
        'a segment in the ledger is not copied again',
      );
    }
  });

  it('carries on after a restart from its ledger, taking the posts the stopped process made from the tag', async () => {
    recorded();
    node.holdAfter = 25;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['720p'], target: { batchId: BATCH } });
    await until(() => node.held, 'copying');
    const stopping = service.shutdown();
    node.release();
    await stopping;
    assert.equal(store.job!.state, 'copying', 'a stopped process leaves the job as it was');

    service = makeService();
    await service.boot();
    await service.settled();
    assert.equal((await job()).state, 'done');
    const item = (await store.items(jobId()))[0]!;
    assert.equal(item.posts_under_tag, node.tags.get(item.tag_uid!)!.split);
  });

  it('copies a quality again under a new tag when the node forgot its tag', async () => {
    recorded();
    node.autoPush = false;
    service = makeService(WIDE);
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await until(async () => (await job()).state === 'verifying', 'verifying');
    const forgotten = (await store.items(jobId()))[0]!.tag_uid!;
    node.tags.delete(forgotten);
    node.autoPush = true;
    await service.settled();
    const item = (await store.items(jobId()))[0]!;
    assert.equal((await job()).state, 'done');
    assert.notEqual(item.tag_uid, forgotten);
    assert.equal(item.posts_under_tag, node.tags.get(item.tag_uid!)!.split);
  });

  it('holds its posts while the tag runs a push window ahead of what Bee pushed', async () => {
    recorded();
    node.autoPush = false;
    let ahead = 0;
    node.onPost = () => {
      for (const tag of node.tags.values()) ahead = Math.max(ahead, tag.split - tag.synced - tag.seen);
    };
    const pusher = setInterval(() => {
      for (const uid of node.tags.keys()) node.push(uid);
    }, 5);
    try {
      await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['720p'], target: { batchId: BATCH } });
      await service.settled();
    } finally {
      clearInterval(pusher);
    }
    assert.equal((await job()).state, 'done');
    assert.ok(node.posts.length > SETTINGS.pushWindowChunks, 'the copy is longer than the window');
    assert.ok(ahead <= SETTINGS.pushWindowChunks + SETTINGS.parallelChunks, `at most the window ahead, was ${ahead}`);
  });

  it('pauses when Bee pushes nothing of the copy for the stall time', async () => {
    recorded();
    node.autoPush = false;
    service = makeService({ tagStallMs: 30 });
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    const current = await job();
    assert.equal(current.pauseReason, 'problem');
    assert.match(current.pauseMessage!, /pushed none of the copy's chunks/);
  });

  it('measures before a new stamp is bought, posting nothing, and gives the place up while a user confirms', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { buyNew: true } });
    await service.settled();
    const current = await job();
    assert.equal(current.state, 'awaiting_purchase');
    assert.ok(current.chunksTotal! >= chunksOf('360p').size);
    assert.equal(node.posts.length, 0);
    assert.equal(current.holdsPlace, false);
    assert.deepEqual(current.actions, ['use_stamp', 'cancel'], 'the purchase is confirmed on its own route');
    assert.ok(BigInt(current.bzzEstimateLowPlur!) > 0n);
    const depth = smallestArchiveDepthFor(current.chunksTotal!);
    assert.deepEqual(current.proposal, {
      chunkCount: current.chunksTotal,
      depth,
      days: 30,
      costPlur: archiveBatchCostPlur(depth!, THIRTY_DAYS),
      shortfallPlur: null,
      terms: {
        postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
        walletXbzzPlur: '10000000000000000000',
        walletXdaiWei: '1000000000000000000',
        defaultDays: 30,
        minimumDays: 2,
      },
    });
  });

  it('buys the confirmed stamp once, waits until it is usable and listed, then copies onto it', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { buyNew: true } });
    await service.settled();
    const depth = smallestArchiveDepthFor(store.job!.chunks_total!)!;
    assert.ok(archiveChunksWithMargin(store.job!.chunks_total!) > 10, 'more than the shallowest stamp holds');
    const confirmed = await service.confirmPurchase(TEST_OPERATOR, choice(depth, 'Alps archive'));
    assert.equal(confirmed?.state, 'buying');
    await until(() => manager.requests.length === 1, 'the manager asked');
    const { requestId } = manager.requests[0]!;
    assert.equal(manager.requests[0]!.nodeId, 'catalogue-node');
    assert.equal(manager.requests[0]!.label, 'Alps archive');

    const bought = {
      requestId,
      state: 'confirmed' as const,
      batchId: NEW_BATCH,
      txHash: `0x${'f'.repeat(64)}`,
      error: null,
    };
    manager.statuses.set(requestId, { ...bought, usable: false });
    await until(async () => (await job()).state === 'waiting_usable', 'waiting to be usable');
    manager.statuses.set(requestId, { ...bought, usable: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await job()).state, 'waiting_usable', 'not before the manager lists it');
    catalogue.batches = [...catalogue.batches, archiveBatch(NEW_BATCH, { label: 'Alps archive', depth })];
    await service.settled();
    assert.equal((await job()).state, 'done');
    assert.equal(store.archives.get('stream-1:360p')!.batch_id, NEW_BATCH);
    assert.equal(manager.requests.length, 1, 'never bought twice');
    assert.equal(store.purchases.get(requestId)!.state, 'usable');
  });

  it('pauses on a purchase that failed, and on Resume waits for a user to confirm another', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { buyNew: true } });
    await service.settled();
    const depth = smallestArchiveDepthFor(store.job!.chunks_total!)!;
    await service.confirmPurchase(TEST_OPERATOR, choice(depth));
    await until(() => manager.requests.length === 1, 'the manager asked');
    const { requestId } = manager.requests[0]!;
    manager.statuses.set(requestId, {
      requestId,
      state: 'failed',
      batchId: null,
      txHash: null,
      usable: null,
      error: 'The node refused the purchase.',
    });
    await service.settled();
    let current = await job();
    assert.equal(current.pauseReason, 'problem');
    assert.match(current.pauseMessage!, /The node refused the purchase/);
    await service.act(TEST_OPERATOR, current.id, { action: 'resume' });
    current = await job();
    assert.equal(current.state, 'awaiting_purchase');
    assert.equal(current.holdsPlace, false);
    assert.equal(store.purchases.get(requestId)!.state, 'failed');
  });

  it('follows a purchase the manager answers late: never failed by the wait, a pause not held up, bought once', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { buyNew: true } });
    await service.settled();
    const depth = smallestArchiveDepthFor(store.job!.chunks_total!)!;
    let answer!: () => void;
    manager.late = new Promise<void>((resolve) => (answer = resolve));

    const confirmed = await service.confirmPurchase(TEST_OPERATOR, choice(depth, 'Alps archive'));
    assert.equal(confirmed?.state, 'buying', 'no answer yet is no refusal');
    const [request] = manager.requests;
    assert.equal(store.purchases.get(request!.requestId)!.state, 'buying');

    const started = Date.now();
    await service.act(TEST_OPERATOR, jobId(), { action: 'pause' });
    assert.ok(Date.now() - started < 1_000, 'a pause does not wait for the manager');
    assert.equal(store.job!.state, 'paused');

    answer();
    await service.settled();
    const purchase = store.purchases.get(request!.requestId)!;
    assert.equal(purchase.state, 'buying', "the admin's own timeout leaves the purchase to be read");
    assert.ok(purchase.relayed_at, 'marked asked, so it is read by its id rather than asked again');

    manager.late = null;
    manager.statuses.set(request!.requestId, {
      requestId: request!.requestId,
      state: 'confirmed',
      batchId: NEW_BATCH,
      txHash: `0x${'f'.repeat(64)}`,
      usable: true,
      error: null,
    });
    catalogue.batches = [...catalogue.batches, archiveBatch(NEW_BATCH, { depth })];
    await service.act(TEST_OPERATOR, jobId(), { action: 'resume' });
    await service.settled();
    assert.equal((await job()).state, 'done');
    assert.equal(store.purchases.get(request!.requestId)!.state, 'usable');
    assert.equal(manager.requests.length, 1, 'bought once');
  });

  it('refuses a confirm whose cost the price no longer gives, with the new cost, and keeps waiting for one', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { buyNew: true } });
    await service.settled();
    const depth = smallestArchiveDepthFor(store.job!.chunks_total!)!;
    manager.inventoryValue.chain.postage!.pricePerChunkPerBlockPlur = '25000';
    const newCost = archiveBatchCostPlur(depth, (518_400n * 25_000n).toString());
    await assert.rejects(
      () => service.confirmPurchase(TEST_OPERATOR, choice(depth)),
      (error) =>
        error instanceof ArchiveRefusedError && error.problem === 'price_moved' && error.message.includes(newCost),
    );
    assert.equal(store.job!.state, 'awaiting_purchase');
    assert.equal(manager.requests.length, 0, 'nothing asked of the manager');
    assert.equal(store.purchases.size, 0, 'nothing recorded');
  });

  it('answers a manager that offers no purchases, and a node busy with another operation, and keeps waiting', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { buyNew: true } });
    await service.settled();
    const depth = smallestArchiveDepthFor(store.job!.chunks_total!)!;
    manager.refusal = new ManagerFundingError('bad_answer', 404, 'The manager answered with status 404.');
    await assert.rejects(
      () => service.confirmPurchase(TEST_OPERATOR, choice(depth)),
      (error) =>
        error instanceof ArchiveRefusedError &&
        error.problem === 'purchases_not_offered' &&
        error.message === ARCHIVE_PURCHASES_NOT_OFFERED,
    );
    assert.equal(store.job!.state, 'awaiting_purchase');
    assert.equal(store.job!.purchase_id, null);

    manager.refusal = new ManagerFundingError('conflict', 409, 'Another operation is under way.');
    await assert.rejects(
      () => service.buy(TEST_OPERATOR, choice(depth)),
      (error) =>
        error instanceof ArchiveRefusedError &&
        error.problem === 'not_now' &&
        /under way on the catalogue node/.test(error.message),
    );
    assert.ok(
      [...store.purchases.values()].every((row) => row.state === 'failed'),
      'nothing left under way',
    );
  });

  it("names each stamp's holder from the manager's inventory, and its room", async () => {
    recorded();
    manager.inventoryValue.archiveBatches = [
      {
        batchId: BATCH,
        depth: 20,
        immutable: true,
        usable: true,
        ttlSeconds: 90 * 86_400,
        fillRatio: 0,
        readError: null,
        nodeId: 'catalogue-node',
        nodeLabel: 'catalogue',
        label: 'archive one',
        writable: true,
      },
    ];
    node.used.set(BATCH, 100);
    const { stamps } = await service.stamps();
    const one = stamps.find((stamp) => stamp.batchId === BATCH)!;
    assert.deepEqual([one.nodeId, one.nodeLabel, one.chunksStamped], ['catalogue-node', 'catalogue', 100]);
    const two = stamps.find((stamp) => stamp.batchId === OTHER_BATCH)!;
    assert.deepEqual([two.nodeId, two.nodeLabel], [null, null], 'one the inventory does not list names none');
  });

  it('estimates each quality before any copy: chunks, a cost range, and the time from the last rate', async () => {
    recorded();
    store.rate = 100;
    const options = await service.optionsFor('stream-1', TEST_OPERATOR.userId);
    const quality = options.qualities.find((one) => one.rendition === '720p')!;
    assert.ok(quality.estimatedChunks! > 0);
    assert.equal(quality.estimatedSeconds, Math.round(quality.estimatedChunks! / 100));
    assert.ok(BigInt(quality.estimatedBzzLowPlur!) < BigInt(quality.estimatedBzzHighPlur!));
  });

  it("answers the catalogue chequebook's reading before a start, and none when the manager cannot be read", async () => {
    recorded();
    manager.setChequebook('4000000000000000');
    let options = await service.optionsFor('stream-1', TEST_OPERATOR.userId);
    assert.equal(options.chequebookAvailablePlur, '4000000000000000');

    manager.inventoryValue.catalogue!.chequebook = null;
    options = await service.optionsFor('stream-1', TEST_OPERATOR.userId);
    assert.equal(options.chequebookAvailablePlur, null, 'a node without a chequebook reads as none');

    manager.inventory = async () => {
      throw new ManagerFundingError('timeout', null, 'The manager did not answer in time.');
    };
    options = await service.optionsFor('stream-1', TEST_OPERATOR.userId);
    assert.equal(options.chequebookAvailablePlur, null, 'an unread manager reads as none');
    assert.ok(options.qualities.length > 0, 'the options answer all the same');
  });

  it('asks the manager again, under the same id, for a purchase it never received', async () => {
    const purchase = await service.buy(TEST_OPERATOR, choice(17));
    await service.settled();
    assert.equal(manager.requests.length, 1);
    manager.statuses.set(purchase.id, 'unknown_request');
    await service.tick();
    await service.settled();
    manager.statuses.delete(purchase.id);
    await service.tick();
    await service.settled();
    assert.deepEqual(
      manager.requests.map((request) => request.requestId),
      [purchase.id, purchase.id],
    );
  });

  it('refuses a purchase the wallet cannot pay, and a second while one is under way', async () => {
    await assert.rejects(
      () => service.buy(TEST_OPERATOR, choice(40)),
      (error) =>
        error instanceof ArchiveRefusedError &&
        error.problem === 'purchase_refused' &&
        /short of the stamp's cost/.test(error.message),
    );
    await service.buy(TEST_OPERATOR, choice(17));
    await assert.rejects(
      () => service.buy(TEST_OPERATOR, choice(17)),
      (error) => error instanceof ArchiveRefusedError && error.problem === 'not_now',
    );
  });

  it('refuses a start for a quality archived at its recording already, and onto a stamp that cannot be written', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    await assert.rejects(
      () => service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } }),
      (error) => error instanceof ArchiveRefusedError && error.problem === 'nothing_to_archive',
    );
    catalogue.batches = [archiveBatch(BATCH), archiveBatch(OTHER_BATCH, { state: 'expired' })];
    await assert.rejects(
      () => service.start(TEST_OPERATOR, 'stream-1', { renditions: ['720p'], target: { batchId: OTHER_BATCH } }),
      (error) => error instanceof ArchiveRefusedError && error.problem === 'stamp_unusable',
    );
  });

  it('shows a copy as outdated once the stream recorded again, and as expired once its stamp did', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    const stream = streams.rows.get('stream-1')!;
    renditions.rows.set('stream-1', [
      rung('720p', RUNG_720, 720),
      { ...rung('360p', RUNG_360, 360), manifest_index: 9 },
    ]);
    assert.equal((await service.summaries([stream])).get('stream-1')?.state, 'outdated');
    renditions.rows.set('stream-1', [rung('720p', RUNG_720, 720), rung('360p', RUNG_360, 360)]);
    catalogue.batches = [archiveBatch(BATCH, { state: 'expired' })];
    assert.equal((await service.summaries([stream])).get('stream-1')?.state, 'expired');
  });

  it('turns the listing switch on only with an archived quality, and rewrites the entry with the archived ones', async () => {
    const stream = recorded();
    await assert.rejects(
      () => service.setListing(TEST_OPERATOR, 'stream-1', true),
      (error) => error instanceof ArchiveRefusedError && error.problem === 'not_now',
    );
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    await service.setListing(TEST_OPERATOR, 'stream-1', true);
    assert.equal(store.archivedOnly.get('stream-1'), true);
    assert.equal(republished.length, 1, 'the entry is rewritten');
    assert.deepEqual([...(await service.listedRenditions({ ...stream, archived_only: true }))!], ['360p']);
    assert.equal(await service.listedRenditions(stream), null, 'off, every rung is listed');
    assert.ok(audit.entries.some((entry) => entry.action === 'archive.listing'));
  });

  it('closes the widget of a finished archive for the user who asks only, and cancels a running one', async () => {
    recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['360p'], target: { batchId: BATCH } });
    await service.settled();
    await service.act(TEST_OPERATOR, jobId(), { action: 'dismiss' });
    assert.equal((await service.current(TEST_OPERATOR.userId))!.dismissed, true);
    assert.equal((await service.current(OTHER_OPERATOR.userId))!.dismissed, false);

    node.holdAfter = node.posts.length + 3;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['720p'], target: { batchId: BATCH } });
    await until(() => node.held, 'copying');
    const cancelling = service.act(TEST_OPERATOR, jobId(), { action: 'cancel' });
    node.release();
    assert.equal(await cancelling, null);
    assert.equal(await service.current(TEST_OPERATOR.userId), null);
    assert.equal(store.archives.get('stream-1:720p')!.state, 'partial', 'what was copied stays, as partial');
  });
});
