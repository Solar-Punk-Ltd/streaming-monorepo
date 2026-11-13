/**
 * The archive's chunk copy against a node in memory: every chunk of a tree read and posted under the batch and the
 * tag, parity copied and never opened, a lost data chunk rebuilt from its file, a lost parity chunk counted and left
 * out, a feed slot posted with its signature and its wrapped root, and a post stored elsewhere refused. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ArchiveNodeError } from '../../src/domain/archive/ArchiveNode.js';
import {
  ChunkCopier,
  emptyCounters,
  SlotMissingError,
  UnreadableChunkError,
  type CopyContext,
} from '../../src/domain/archive/ChunkCopier.js';
import { buildFile, FakeArchiveNode, playlistText, slotFor } from './support/archiveFakes.js';

const URL = 'http://catalogue-node.test:1633';
const BATCH = 'a'.repeat(64);
const OWNER = '1234567890abcdef1234567890abcdef12345678';
const TOPIC = '0b7c3a1e-2f44-5d66-8a77-99aabbccddee';

let node: FakeArchiveNode;
let copier: ChunkCopier;

async function context(): Promise<CopyContext> {
  return {
    writer: URL,
    readers: [URL],
    batchId: BATCH,
    tagUid: await node.createTag(),
    signal: new AbortController().signal,
    parallel: 4,
    admit: async () => undefined,
    counters: emptyCounters(),
  };
}

function segment(kilobytes: number, fill: string) {
  const file = buildFile(new Uint8Array(Buffer.alloc(kilobytes * 1024, fill)), 1);
  for (const [address, chunk] of file.chunks) node.network.set(address, chunk);
  return file;
}

beforeEach(() => {
  node = new FakeArchiveNode();
  copier = new ChunkCopier(node, { retryDelaysMs: [1] });
});

describe('copying chunks onto an archive stamp', () => {
  it('posts every chunk of a tree, parity included, under the batch and the tag', async () => {
    const file = segment(600, 'a');
    const ctx = await context();
    const copy = await copier.copyTree(ctx, file.root);
    const posted = new Set(node.posts.map((post) => post.address));
    for (const address of file.chunks.keys()) assert.ok(posted.has(address), `posted ${address.slice(0, 8)}`);
    assert.ok(node.posts.every((post) => post.batchId === BATCH && post.tag === ctx.tagUid));
    assert.equal(copy.chunks, node.posts.length);
    assert.equal(ctx.counters.posts, node.tags.get(ctx.tagUid)!.split, 'the posts are what the tag counts');
    assert.ok(file.parity.length > 0);
    assert.equal(copy.parityMissing, 0);
  });

  it('never opens a parity chunk: only chunks of the tree are asked for', async () => {
    const file = segment(600, 'b');
    await copier.copyTree(await context(), file.root);
    for (const address of node.reads) assert.ok(file.chunks.has(address), 'only chunks of the tree are read');
    const asked = new Set(node.reads);
    for (const parity of file.parity) assert.ok(asked.has(parity));
  });

  it('rebuilds a data chunk the network lost by reading its file whole, then copies it', async () => {
    const file = segment(600, 'c');
    const lost = file.data[3]!;
    node.restorable.set(lost, node.network.get(lost)!);
    node.network.delete(lost);
    const copy = await copier.copyTree(await context(), file.root);
    assert.deepEqual(node.fileReads, [file.root]);
    assert.equal(copy.rebuilt, 1);
    assert.ok(node.posts.some((post) => post.address === lost));
  });

  it('stops on a data chunk neither read nor rebuilt', async () => {
    const file = segment(600, 'd');
    node.network.delete(file.data[0]!);
    const ctx = await context();
    await assert.rejects(
      () => copier.copyTree(ctx, file.root),
      (error) => error instanceof UnreadableChunkError && error.root === file.root,
    );
  });

  it('counts a lost parity chunk and leaves it out, and copies the rest', async () => {
    const file = segment(600, 'e');
    const lost = file.parity[0]!;
    node.network.delete(lost);
    const copy = await copier.copyTree(await context(), file.root);
    assert.equal(copy.parityMissing, 1);
    assert.ok(!node.posts.some((post) => post.address === lost));
    for (const address of file.chunks.keys()) {
      if (address !== lost) assert.ok(node.posts.some((post) => post.address === address));
    }
  });

  it('posts a feed slot with its signature, and a wrapped playlist root with the tree under it', async () => {
    const refs = Array.from({ length: 80 }, (_, at) => (at + 1).toString(16).padStart(64, '0'));
    const text = playlistText(refs);
    assert.ok(text.length > 4096, 'a wrapped payload');
    const slot = slotFor(OWNER, TOPIC, 7, text, node.network);
    const payload = await copier.copySlot(await context(), { owner: OWNER, topic: TOPIC, index: 7 });
    assert.equal(payload, text);
    assert.ok(node.posts.some((post) => post.address === slot.address && post.kind === 'soc'));
    assert.ok(
      node.posts.some((post) => post.address === slot.root && post.kind === 'chunk'),
      'the wrapped root',
    );
  });

  it('reads a slot for measuring without posting anything', async () => {
    const text = playlistText(Array.from({ length: 80 }, (_, at) => (at + 1).toString(16).padStart(64, '0')));
    slotFor(OWNER, TOPIC, 9, text, node.network);
    const read = await copier.readSlot([URL], { owner: OWNER, topic: TOPIC, index: 9 }, new AbortController().signal);
    assert.equal(read.payload, text);
    assert.ok(read.chunks >= 3, 'the slot, its root and the chunks under it');
    assert.equal(node.posts.length, 0);
  });

  it('refuses a slot that is not on Swarm', async () => {
    const ctx = await context();
    await assert.rejects(() => copier.copySlot(ctx, { owner: OWNER, topic: TOPIC, index: 99 }), SlotMissingError);
  });

  it('stops when a chunk comes back stored under another address', async () => {
    const file = segment(10, 'f');
    node.misstored.add(file.data[0]!);
    const ctx = await context();
    await assert.rejects(
      () => copier.copyTree(ctx, file.root),
      (error) => error instanceof ArchiveNodeError && error.problem === 'wrong_address',
    );
  });

  it('stops when the stamp is full', async () => {
    const file = segment(10, 'g');
    node.refusing.set(BATCH, 'batch_full');
    const ctx = await context();
    await assert.rejects(
      () => copier.copyTree(ctx, file.root),
      (error) => error instanceof ArchiveNodeError && error.problem === 'batch_full',
    );
  });

  it('asks the push window before every post', async () => {
    const file = segment(100, 'h');
    let asked = 0;
    const ctx = { ...(await context()), admit: async () => void (asked += 1) };
    await copier.copyTree(ctx, file.root);
    assert.equal(asked, ctx.counters.posts);
  });
});
