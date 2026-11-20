/**
 * The stream card's frame in an archive, against a node and a store in memory: the quality the master playlist lists
 * first, its playlist slot and its first segment that is not a gap, copied with the master slot when that quality is
 * not one of the job's own, left out with a line in the log when it cannot be copied, and counted once across a pause
 * and a restart. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { ArchiveService } from '../../src/domain/archive/ArchiveService.js';
import { ChunkCopier } from '../../src/domain/archive/ChunkCopier.js';
import { Logger } from '../../src/domain/Logger.js';
import type { StreamRenditionRow } from '../../src/types/index.js';
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
const RUNG_480 = '9a7b6c5d-1111-5222-8333-777788889999';
const RUNG_360 = '9a7b6c5d-1111-5222-8333-444455556666';
const BATCH = 'a'.repeat(64);

let streams: FakeStreams;
let renditions: FakeRenditions;
let store: InMemoryArchiveStore;
let catalogue: FakeCatalogue;
let node: FakeArchiveNode;
let service: ArchiveService;

function makeService(): ArchiveService {
  return new ArchiveService(
    store,
    streams,
    renditions,
    catalogue,
    node,
    new ChunkCopier(node, { retryDelaysMs: [1] }),
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

function rung(name: string, topic: string, height: number, manifestIndex: number | null = 5): StreamRenditionRow {
  return {
    stream_id: 'stream-1',
    name,
    width: Math.round((height * 16) / 9),
    height,
    topic,
    bandwidth: 800_000,
    avg_bandwidth: 600_000,
    manifest_index: manifestIndex,
    duration_seconds: 6,
    updated_at: new Date(),
  };
}

/** A master playlist as the uploader writes it, its rungs in the order given. */
function masterText(topics: readonly string[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const topic of topics) {
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=600000,RESOLUTION=854x480');
    lines.push(`swarm://${OWNER}/${topic}`);
  }
  return lines.join('\n') + '\n';
}

/** A recording playlist that opens on a gap entry, so its first segment is the second entry. */
function openingOnAGap(refs: readonly string[]): string {
  return playlistText(refs).replace(
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-GAP\n#EXTINF:2.000000,\ngap-0',
  );
}

interface Ladder {
  /** The 480p rung's segments. */
  own: BuiltFile[];
  /** The 360p rung's segments, the first of them the frame. */
  frame: BuiltFile[];
  /** The 360p playlist slot, and the tree its payload is wrapped in. */
  frameSlot: string;
  frameTree: Set<string>;
}

/**
 * A finished recording with a 480p and a 360p rung, whose master lists 360p first. The 360p playlist names enough
 * segments to be wrapped in a tree of its own, and opens on a gap entry.
 */
function recorded(over: { frameIndex?: number | null } = {}): Ladder {
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
  renditions.rows.set(stream.id, [
    rung('480p', RUNG_480, 480),
    rung('360p', RUNG_360, 360, over.frameIndex === undefined ? 5 : over.frameIndex),
  ]);
  const own = [0, 1, 2].map(() => buildFile(new Uint8Array(randomBytes(100 * 1024)), 1));
  const frame = Array.from({ length: 55 }, () => buildFile(new Uint8Array(randomBytes(8 * 1024)), 1));
  for (const file of [...own, ...frame]) for (const [address, chunk] of file.chunks) node.network.set(address, chunk);
  slotFor(OWNER, RUNG_480, 5, playlistText(own.map((file) => file.root)), node.network);
  const text = openingOnAGap(frame.map((file) => file.root));
  const slot = slotFor(OWNER, RUNG_360, 5, text, node.network);
  const tree = buildFile(new TextEncoder().encode(text));
  assert.equal(slot.root, tree.root, 'the 360p playlist is wrapped');
  slotFor(OWNER, STREAM_TOPIC, 7, masterText([RUNG_360, RUNG_480]), node.network);
  return { own, frame, frameSlot: slot.address, frameTree: new Set(tree.chunks.keys()) };
}

async function until(test: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`never: ${what}`);
}

function jobId(): string {
  return store.job!.id;
}

async function jobState(): Promise<string> {
  return (await service.current(TEST_OPERATOR.userId))!.state;
}

/** Every post of the job's first quality counted once, under its tag, and its segment counts its own. */
async function assertCountedOnce(ladder: Ladder): Promise<void> {
  const item = (await store.items(jobId()))[0]!;
  const underTag = node.posts.filter((post) => post.tag === item.tag_uid);
  assert.equal(item.chunks_copied, new Set(underTag.map((post) => post.address)).size, 'each chunk counted once');
  assert.equal(item.posts_under_tag, node.tags.get(item.tag_uid!)!.split, 'every post counted under the tag');
  assert.equal(item.segments_done, ladder.own.length);
  assert.equal(item.segments_total, ladder.own.length);
}

beforeEach(() => {
  streams = new FakeStreams();
  renditions = new FakeRenditions();
  store = new InMemoryArchiveStore((id) => streams.rows.get(id)?.title ?? null);
  catalogue = new FakeCatalogue();
  catalogue.batches = [archiveBatch(BATCH)];
  node = new FakeArchiveNode();
  service = makeService();
});

afterEach(async () => {
  node.release();
  await service.shutdown();
});

describe('ArchiveService, the card frame', () => {
  it("copies the frame's playlist slot and its first segment with the master slot, and none of its other segments", async () => {
    const ladder = recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
    await service.settled();

    assert.equal(await jobState(), 'done');
    assert.equal((await store.items(jobId()))[0]!.result, 'complete');
    const stamped = node.stamped.get(BATCH)!;
    assert.ok(stamped.has(ladder.frameSlot), "the frame's playlist slot");
    for (const address of ladder.frameTree) assert.ok(stamped.has(address), "the frame playlist's root and tree");
    const [first, ...others] = ladder.frame;
    assert.ok(first!.parity.length > 0);
    for (const address of first!.chunks.keys()) {
      assert.ok(stamped.has(address), "the frame's first segment, parity included");
    }
    for (const file of others) for (const address of file.chunks.keys()) assert.ok(!stamped.has(address));
    assert.equal(node.posts.filter((post) => post.kind === 'soc').length, 3, 'the master, the frame and the 480p slot');
    await assertCountedOnce(ladder);
  });

  it('copies nothing more when the frame is one of the qualities archived', async () => {
    const ladder = recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p', '360p'], target: { batchId: BATCH } });
    await service.settled();

    assert.equal(await jobState(), 'done');
    assert.equal(node.posts.filter((post) => post.kind === 'soc').length, 3, 'the master and each quality slot');
    const [first, second] = await store.items(jobId());
    assert.equal(first!.rendition, '480p');
    const frameChunks = new Set([ladder.frameSlot, ...ladder.frameTree, ...ladder.frame[0]!.chunks.keys()]);
    assert.ok(
      node.posts.every((post) => post.tag !== first!.tag_uid || !frameChunks.has(post.address)),
      "the frame is copied with its own quality, under that quality's tag",
    );
    for (const address of ladder.frame[0]!.chunks.keys()) {
      assert.equal(node.posts.filter((post) => post.address === address).length, 1);
    }
    assert.equal(second!.posts_under_tag, node.tags.get(second!.tag_uid!)!.split);
  });

  it('completes the job and says so in the log when a chunk of the frame cannot be read or rebuilt', async () => {
    const ladder = recorded();
    node.network.delete(ladder.frame[0]!.data[1]!);
    const warn = mock.method(Logger.getInstance(), 'warn', () => undefined);
    try {
      await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
      await service.settled();
    } finally {
      warn.mock.restore();
    }

    assert.equal(await jobState(), 'done');
    assert.equal((await store.items(jobId()))[0]!.result, 'complete');
    const stamped = node.stamped.get(BATCH)!;
    for (const file of ladder.own) for (const address of file.chunks.keys()) assert.ok(stamped.has(address));
    const said = warn.mock.calls.filter((call) => String(call.arguments[0]).includes('card frame'));
    assert.equal(said.length, 1);
    assert.match(String(said[0]!.arguments[0]), /"Alps".*could not be read/);
    await assertCountedOnce(ladder);
  });

  it('completes the job and says so in the log when the frame quality has no recorded slot', async () => {
    const ladder = recorded({ frameIndex: null });
    const warn = mock.method(Logger.getInstance(), 'warn', () => undefined);
    try {
      await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
      await service.settled();
    } finally {
      warn.mock.restore();
    }

    assert.equal(await jobState(), 'done');
    assert.ok(!node.stamped.get(BATCH)!.has(ladder.frameSlot));
    assert.equal(warn.mock.calls.filter((call) => String(call.arguments[0]).includes('card frame')).length, 1);
  });

  it('costs the quality nothing when the frame lost a parity chunk', async () => {
    const ladder = recorded();
    node.network.delete(ladder.frame[0]!.parity[0]!);
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
    await service.settled();

    const item = (await store.items(jobId()))[0]!;
    assert.equal(item.result, 'complete');
    assert.equal(item.parity_missing, 0);
    assert.ok(node.stamped.get(BATCH)!.has(ladder.frame[0]!.root), 'the frame is copied all the same');
  });

  it('counts the frame once across a pause, though Resume posts it again', async () => {
    const ladder = recorded();
    node.holdAfter = 60;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
    await until(() => node.held, 'copying');
    const pausing = service.act(TEST_OPERATOR, jobId(), { action: 'pause' });
    node.release();
    await pausing;
    assert.ok((await store.segmentsDone(jobId(), '480p')).size > 0, 'paused after a segment of its own');
    await service.act(TEST_OPERATOR, jobId(), { action: 'resume' });
    await service.settled();

    assert.equal(await jobState(), 'done');
    const framePosts = node.posts.filter((post) => post.address === ladder.frameSlot).length;
    assert.ok(framePosts > 1, 'Resume posted the frame again');
    await assertCountedOnce(ladder);
  });

  it('counts the frame once across a restart', async () => {
    const ladder = recorded();
    node.holdAfter = 60;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
    await until(() => node.held, 'copying');
    const stopping = service.shutdown();
    node.release();
    await stopping;

    service = makeService();
    await service.boot();
    await service.settled();
    assert.equal(await jobState(), 'done');
    const framePosts = node.posts.filter((post) => post.address === ladder.frameSlot).length;
    assert.ok(framePosts > 1, 'the restart posted it again');
    await assertCountedOnce(ladder);
  });
});
