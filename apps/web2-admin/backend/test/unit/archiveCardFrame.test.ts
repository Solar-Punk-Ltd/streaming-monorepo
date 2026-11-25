/**
 * The stream card's frame in an archive, against a node and a store in memory: the quality the master playlist lists
 * first, its playlist slot and its first segment that is not a gap, posted with the master slot on every pass whether
 * or not that quality is one of the job's own, kept outside the quality's counts, and left out with a line in the log
 * when it cannot be copied. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { ArchiveService } from '../../src/domain/archive/ArchiveService.js';
import { ChunkCopier } from '../../src/domain/archive/ChunkCopier.js';
import { Logger } from '../../src/domain/Logger.js';
import type { ArchiveItemRow } from '../../src/domain/archive/ArchiveRepository.js';
import type { StreamRenditionRow } from '../../src/types/index.js';
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
const STREAM_TOPIC = '0b7c3a1e-2f44-5d66-8a77-99aabbccddee';
const RUNG_480 = '9a7b6c5d-1111-5222-8333-777788889999';
const RUNG_360 = '9a7b6c5d-1111-5222-8333-444455556666';
const BATCH = 'a'.repeat(64);

let streams: FakeStreams;
let renditions: FakeRenditions;
let store: InMemoryArchiveStore;
let node: FakeArchiveNode;
let service: ArchiveService;

function makeService(): ArchiveService {
  const catalogue = new FakeCatalogue();
  catalogue.batches = [archiveBatch(BATCH)];
  return new ArchiveService(
    store,
    streams,
    renditions,
    catalogue,
    node,
    new ChunkCopier(node, { retryDelaysMs: [1] }),
    new FakeArchiveThumbnails(),
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

interface Ladder {
  /** The 480p rung's segments. */
  own: BuiltFile[];
  /** The 360p rung's segments, the first of them the frame. */
  frame: BuiltFile[];
  /** The 360p playlist slot. */
  frameSlot: string;
  /** Every chunk of the frame: the 360p playlist slot, root and tree, and its first segment. */
  frameChunks: Set<string>;
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
  const text = playlistText(frame.map((file) => file.root)).replace(
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-GAP\n#EXTINF:2.000000,\ngap-0',
  );
  const slot = slotFor(OWNER, RUNG_360, 5, text, node.network);
  const tree = buildFile(new TextEncoder().encode(text));
  assert.equal(slot.root, tree.root, 'the 360p playlist is wrapped');
  slotFor(OWNER, STREAM_TOPIC, 7, masterText([RUNG_360, RUNG_480]), node.network);
  return {
    own,
    frame,
    frameSlot: slot.address,
    frameChunks: new Set([slot.address, ...tree.chunks.keys(), ...frame[0]!.chunks.keys()]),
  };
}

function jobId(): string {
  return store.job!.id;
}

async function jobState(): Promise<string> {
  return (await service.current(TEST_OPERATOR.userId))!.state;
}

async function item(rendition: string): Promise<ArchiveItemRow> {
  return (await store.items(jobId())).find((candidate) => candidate.rendition === rendition)!;
}

/**
 * The quality's counts hold its own chunks alone, each once: what was posted under its tag, the frame left out, and
 * every post counted under the tag.
 */
function assertOwnCounts(row: ArchiveItemRow, frameChunks: ReadonlySet<string> = new Set()): void {
  const own = new Set(
    node.posts.filter((post) => post.tag === row.tag_uid && !frameChunks.has(post.address)).map((post) => post.address),
  );
  assert.equal(row.chunks_copied, own.size, `${row.rendition}: its own chunks, each once`);
  assert.equal(row.posts_under_tag, node.tags.get(row.tag_uid!)!.split, `${row.rendition}: every post under its tag`);
}

function postedUnder(row: ArchiveItemRow, address: string): number {
  return node.posts.filter((post) => post.tag === row.tag_uid && post.address === address).length;
}

/** Waits until the node holds its posts in the middle of the copy. */
async function untilHeld(): Promise<void> {
  for (let attempt = 0; attempt < 2_000 && !node.held; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(node.held, 'a copy in the middle');
}

beforeEach(() => {
  streams = new FakeStreams();
  renditions = new FakeRenditions();
  store = new InMemoryArchiveStore((id) => streams.rows.get(id)?.title ?? null);
  node = new FakeArchiveNode();
  service = makeService();
});

afterEach(async () => {
  node.release();
  await service.shutdown();
});

describe('ArchiveService, the card frame', () => {
  it("copies the frame's playlist slot and first segment with the master slot, outside the quality's counts", async () => {
    const ladder = recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
    await service.settled();

    assert.equal(await jobState(), 'done');
    const stamped = node.stamped.get(BATCH)!;
    for (const address of ladder.frameChunks) assert.ok(stamped.has(address), 'every chunk of the frame');
    assert.ok(ladder.frame[0]!.parity.length > 0, 'parity included');
    for (const file of ladder.frame.slice(1)) {
      for (const address of file.chunks.keys()) assert.ok(!stamped.has(address), 'no other segment');
    }
    const row = await item('480p');
    assert.equal(row.result, 'complete');
    assert.equal(row.segments_total, ladder.own.length);
    assertOwnCounts(row, ladder.frameChunks);
  });

  it("copies the frame though its quality is archived too, and that quality's counts are its own chunks", async () => {
    const ladder = recorded();
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p', '360p'], target: { batchId: BATCH } });
    await service.settled();

    assert.equal(await jobState(), 'done');
    const first = await item('480p');
    const frameQuality = await item('360p');
    assert.equal(postedUnder(first, ladder.frameSlot), 1, 'with the master slot');
    assert.equal(postedUnder(frameQuality, ladder.frameSlot), 1, 'and with its own quality');
    assertOwnCounts(first, ladder.frameChunks);
    assertOwnCounts(frameQuality);
    assert.equal(frameQuality.segments_total, ladder.frame.length);
  });

  for (const [cause, spoil] of [
    [
      'a chunk of it can be neither read nor rebuilt',
      (ladder: Ladder) => node.network.delete(ladder.frame[0]!.data[1]!),
    ],
    ['its quality has no recorded slot', null],
  ] as const) {
    it(`logs the frame and completes the job when ${cause}`, async () => {
      const ladder = recorded({ frameIndex: spoil ? 5 : null });
      spoil?.(ladder);
      const warn = mock.method(Logger.getInstance(), 'warn', () => undefined);
      try {
        await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
        await service.settled();
      } finally {
        warn.mock.restore();
      }

      assert.equal(await jobState(), 'done');
      const row = await item('480p');
      assert.equal(row.result, 'complete');
      for (const file of ladder.own)
        for (const address of file.chunks.keys()) assert.ok(node.stamped.get(BATCH)!.has(address));
      const said = warn.mock.calls
        .map((call) => String(call.arguments[0]))
        .filter((line) => line.includes('card frame'));
      assert.equal(said.length, 1);
      assert.match(said[0]!, /the card frame of "Alps" is not copied: /);
      assertOwnCounts(row, ladder.frameChunks);
    });
  }

  it('keeps the frame out of the counts across a pause, though Resume posts it again', async () => {
    const ladder = recorded();
    node.holdAfter = 60;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
    await untilHeld();
    const pausing = service.act(TEST_OPERATOR, jobId(), { action: 'pause' });
    node.release();
    await pausing;
    assert.ok((await store.segmentsDone(jobId(), '480p')).size > 0, 'paused after a segment of its own');
    await service.act(TEST_OPERATOR, jobId(), { action: 'resume' });
    await service.settled();

    assert.equal(await jobState(), 'done');
    const row = await item('480p');
    assert.ok(postedUnder(row, ladder.frameSlot) > 1, 'Resume posted the frame again');
    assert.equal(row.segments_done, ladder.own.length);
    assertOwnCounts(row, ladder.frameChunks);
  });

  it('keeps the frame out of the counts across a restart', async () => {
    const ladder = recorded();
    node.holdAfter = 60;
    await service.start(TEST_OPERATOR, 'stream-1', { renditions: ['480p'], target: { batchId: BATCH } });
    await untilHeld();
    const stopping = service.shutdown();
    node.release();
    await stopping;

    service = makeService();
    await service.boot();
    await service.settled();
    assert.equal(await jobState(), 'done');
    const row = await item('480p');
    assert.ok(postedUnder(row, ladder.frameSlot) > 1, 'the restart posted the frame again');
    assert.equal(row.segments_done, ladder.own.length);
    assertOwnCounts(row, ladder.frameChunks);
  });
});
