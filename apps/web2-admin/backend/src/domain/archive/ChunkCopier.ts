import { ArchiveNodeError, ChunkMissingError, type ArchiveNode } from './ArchiveNode.js';
import {
  CHUNK_PAYLOAD_BYTES,
  feedSlotAddress,
  levelOf,
  SPAN_BYTES,
  socParts,
  spanOf,
  splitReferences,
  wrappedPayload,
  type RedundancyLevel,
} from './chunkTree.js';

/**
 * Copies chunks byte for byte from reader nodes onto a batch on the writer node, the way msrs-uploader's
 * `src/lib/restamp.js` does: every chunk read raw with `GET /chunks/{address}`, posted with `POST /chunks` under the
 * archive stamp and the quality's tag, and checked to come back under the address it was read at. A content-addressed
 * chunk keeps its address by construction, and a feed slot is posted with `POST /soc` and the signature it carries,
 * so nothing here needs a key. `docs/architecture/web2-admin.md`, "What is copied" and "The job", is the design.
 *
 * - A tree is walked by span, level by level. Its data and intermediate chunks are opened, its parity chunks copied
 *   and never opened, which ones are parity following from the erasure level in each span.
 * - A data or intermediate chunk the node answers not found for is brought back by reading its file whole through
 *   `/bytes`, which makes Bee restore it from its parity, then read again. One that still cannot be read stops the copy
 *   with {@link UnreadableChunkError}.
 * - A parity chunk the node answers not found for is tried once more after the tree's walk, then counted and left out,
 *   and the quality completes with reduced protection.
 * - A read the node does not answer, on any chunk, stops the copy with the node's {@link ArchiveNodeError}: an outage
 *   is no sign a chunk is lost.
 * - Before every post the copy asks its push window, which holds it while the tag's posts run too far ahead of what
 *   Bee has pushed.
 */

/** What a copy has done so far: the posts under its tag, and what they hold. Saved as the job goes. */
export interface CopyCounters {
  /** Every post under the tag, a chunk posted again counted again: what the tag's `split` should equal. */
  posts: number;
  chunks: number;
  bytes: number;
  rebuilt: number;
  parityMissing: number;
}

export function emptyCounters(): CopyCounters {
  return { posts: 0, chunks: 0, bytes: 0, rebuilt: 0, parityMissing: 0 };
}

/** Where a copy reads and writes, and how. */
export interface CopyContext {
  /** The node that holds the archive stamp, and every post goes to. */
  writer: string;
  /** The nodes chunks are read through, tried in turn. */
  readers: readonly string[];
  batchId: string;
  tagUid: number;
  signal: AbortSignal;
  /** How many chunks are read and posted at once. */
  parallel: number;
  /** Waits until the push window lets another post go. Throws to stop the copy. */
  admit(): Promise<void>;
  counters: CopyCounters;
}

/** What one tree's copy took. */
export interface TreeCopy {
  chunks: number;
  bytes: number;
  parityMissing: number;
  rebuilt: number;
}

/** A data or intermediate chunk that was neither read nor rebuilt from its parity, after every retry. */
export class UnreadableChunkError extends Error {
  constructor(
    readonly address: string,
    readonly root: string,
    readonly reason: unknown,
  ) {
    super(`A chunk of segment ${root.slice(0, 12)}… could not be read, or rebuilt from its parity.`);
    this.name = 'UnreadableChunkError';
  }
}

/** A feed slot that is not on Swarm: the recording's playlist cannot be found. */
export class SlotMissingError extends Error {
  constructor(readonly address: string) {
    super('The recording playlist could not be read from Swarm.');
    this.name = 'SlotMissingError';
  }
}

export interface ChunkCopierOptions {
  /** The waits between tries of one read or post, so `[1000, 2000]` tries three times. */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/** Runs `work` on every item with at most `parallel` at once, stopping at the first failure. */
export async function pool<T>(items: readonly T[], parallel: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Whether a read failure is worth another try: a chunk not found, or a node that did not answer. */
function retryable(error: unknown): boolean {
  return error instanceof ChunkMissingError || isNodeFailure(error);
}

/** A node that did not answer, or not in time. */
function isNodeFailure(error: unknown): boolean {
  return error instanceof ArchiveNodeError && error.problem === 'node';
}

export class ChunkCopier {
  private readonly retryDelaysMs: readonly number[];

  constructor(
    private readonly node: ArchiveNode,
    options: ChunkCopierOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /**
   * Copies a feed slot: the single-owner chunk, posted with its own signature, and when its payload is wrapped, the
   * root it wraps and the tree under that root. Answers the payload, joined from what was read.
   */
  async copySlot(ctx: CopyContext, feed: { owner: string; topic: string; index: number }): Promise<string> {
    const address = feedSlotAddress(feed.owner, feed.topic, feed.index);
    let soc: Uint8Array;
    try {
      soc = await this.read(ctx.readers, address, ctx.signal);
    } catch (error) {
      if (error instanceof ChunkMissingError) throw new SlotMissingError(address);
      throw error;
    }
    const parts = socParts(soc);
    await this.post(ctx, address, () =>
      this.node.postSoc(
        ctx.writer,
        ctx.batchId,
        ctx.tagUid,
        { owner: feed.owner, identifier: parts.identifier, signature: parts.signature, wrapped: parts.wrapped },
        ctx.signal,
      ),
    );
    ctx.counters.chunks += 1;
    ctx.counters.bytes += soc.length;

    const payload = wrappedPayload(soc);
    if (payload.kind === 'inline') return Buffer.from(payload.payload).toString('utf8');

    // The root is the slot's own wrapped chunk, so it is posted from the slot's bytes rather than read again. The tree
    // under it is copied as any file's, and the payload joined from it.
    const kept = new Map<string, Uint8Array>([[payload.address, payload.chunk]]);
    await this.post(ctx, payload.address, () =>
      this.node.postChunk(ctx.writer, ctx.batchId, ctx.tagUid, payload.chunk, ctx.signal),
    );
    ctx.counters.chunks += 1;
    ctx.counters.bytes += payload.chunk.length;
    await this.copyChildren(ctx, payload.address, payload.chunk, kept);
    return Buffer.from(join(payload.address, kept)).toString('utf8');
  }

  /** Copies the whole tree under a file's root reference: its root, intermediates, data and parity chunks. */
  async copyTree(ctx: CopyContext, root: string): Promise<TreeCopy> {
    const before = { ...ctx.counters };
    const rootChunk = await this.readOpened(ctx, root, root);
    await this.post(ctx, root, () => this.node.postChunk(ctx.writer, ctx.batchId, ctx.tagUid, rootChunk, ctx.signal));
    ctx.counters.chunks += 1;
    ctx.counters.bytes += rootChunk.length;
    await this.copyChildren(ctx, root, rootChunk, null);
    return {
      chunks: ctx.counters.chunks - before.chunks,
      bytes: ctx.counters.bytes - before.bytes,
      parityMissing: ctx.counters.parityMissing - before.parityMissing,
      rebuilt: ctx.counters.rebuilt - before.rebuilt,
    };
  }

  /**
   * A feed slot's payload, read and posted nowhere: what measuring reads of a playlist. Answers the payload and the
   * chunks the slot's copy will post, the slot itself and the tree its payload is wrapped in, if any.
   */
  async readSlot(
    readers: readonly string[],
    feed: { owner: string; topic: string; index: number },
    signal: AbortSignal,
  ): Promise<{ payload: string; chunks: number }> {
    const address = feedSlotAddress(feed.owner, feed.topic, feed.index);
    let soc: Uint8Array;
    try {
      soc = await this.read(readers, address, signal);
    } catch (error) {
      if (error instanceof ChunkMissingError) throw new SlotMissingError(address);
      throw error;
    }
    const payload = wrappedPayload(soc);
    if (payload.kind === 'inline') return { payload: Buffer.from(payload.payload).toString('utf8'), chunks: 1 };
    const kept = new Map<string, Uint8Array>([[payload.address, payload.chunk]]);
    let chunks = 2;
    let level = [payload.chunk];
    while (level.length > 0) {
      const next: Uint8Array[] = [];
      for (const chunk of level) {
        const { data, parity } = splitReferences(chunk);
        chunks += parity.length;
        for (const child of data) {
          if (kept.has(child)) continue;
          const read = await this.read(readers, child, signal);
          kept.set(child, read);
          chunks += 1;
          if (spanOf(read) > CHUNK_PAYLOAD_BYTES) next.push(read);
        }
      }
      level = next;
    }
    return { payload: Buffer.from(join(payload.address, kept)).toString('utf8'), chunks };
  }

  /**
   * A file's size and erasure level, from its root chunk alone: what measuring reads of each segment. Throws
   * {@link ChunkMissingError} when the root cannot be read after every try.
   */
  async measure(
    readers: readonly string[],
    root: string,
    signal: AbortSignal,
  ): Promise<{ bytes: number; level: RedundancyLevel }> {
    const chunk = await this.read(readers, root, signal);
    return { bytes: spanOf(chunk), level: levelOf(chunk) };
  }

  /**
   * Copies every chunk under an opened chunk, level by level. `kept`, when given, keeps the data and intermediate
   * chunks read, for a payload to be joined from.
   */
  private async copyChildren(
    ctx: CopyContext,
    root: string,
    chunk: Uint8Array,
    kept: Map<string, Uint8Array> | null,
  ): Promise<void> {
    let level: Array<{ address: string; open: boolean }> = [];
    const seen = new Set<string>([root]);
    const notFound: string[] = [];
    const enqueue = (from: Uint8Array) => {
      const { data, parity } = splitReferences(from);
      for (const address of data) {
        if (seen.has(address)) continue;
        seen.add(address);
        level.push({ address, open: true });
      }
      for (const address of parity) {
        if (seen.has(address)) continue;
        seen.add(address);
        level.push({ address, open: false });
      }
    };
    enqueue(chunk);
    while (level.length > 0) {
      const current = level;
      const opened: Uint8Array[] = [];
      level = [];
      await pool(current, ctx.parallel, async ({ address, open }) => {
        let bytes: Uint8Array;
        if (open) {
          bytes = await this.readOpened(ctx, address, root);
          if (spanOf(bytes) > CHUNK_PAYLOAD_BYTES) opened.push(bytes);
          kept?.set(address, bytes);
        } else {
          try {
            bytes = await this.read(ctx.readers, address, ctx.signal);
          } catch (error) {
            // Only a chunk the node answered not found for is lost; a node that did not answer stops the copy.
            if (ctx.signal.aborted || !(error instanceof ChunkMissingError)) throw error;
            notFound.push(address);
            return;
          }
        }
        await this.postCounted(ctx, address, bytes);
      });
      for (const intermediate of opened) enqueue(intermediate);
    }
    // Each parity chunk not found is tried once more before the tree counts as copied.
    await pool(notFound, ctx.parallel, async (address) => {
      let bytes: Uint8Array;
      try {
        bytes = await this.read(ctx.readers, address, ctx.signal);
      } catch (error) {
        if (ctx.signal.aborted || !(error instanceof ChunkMissingError)) throw error;
        // A parity chunk the network lost costs the recording some protection, never its playback.
        ctx.counters.parityMissing += 1;
        return;
      }
      await this.postCounted(ctx, address, bytes);
    });
  }

  /** A chunk posted under the stamp and the tag, and counted. */
  private async postCounted(ctx: CopyContext, address: string, bytes: Uint8Array): Promise<void> {
    await this.post(ctx, address, () => this.node.postChunk(ctx.writer, ctx.batchId, ctx.tagUid, bytes, ctx.signal));
    ctx.counters.chunks += 1;
    ctx.counters.bytes += bytes.length;
  }

  /**
   * A data or intermediate chunk of the file under `root`: read, or rebuilt by reading the file whole on a reader,
   * which makes Bee restore it from parity, and read again there. Throws {@link UnreadableChunkError} when neither.
   */
  private async readOpened(ctx: CopyContext, address: string, root: string): Promise<Uint8Array> {
    try {
      return await this.read(ctx.readers, address, ctx.signal);
    } catch (error) {
      // A node that did not answer is no sign the chunk is lost: the copy stops with the node.
      if (ctx.signal.aborted || !(error instanceof ChunkMissingError)) throw error;
      if (address === root) throw new UnreadableChunkError(address, root, error);
      for (const reader of ctx.readers) {
        try {
          await this.node.readFile(reader, root, ctx.signal);
          const rebuilt = await this.node.readChunk(reader, address, ctx.signal);
          ctx.counters.rebuilt += 1;
          return rebuilt;
        } catch (rebuildError) {
          if (ctx.signal.aborted || isNodeFailure(rebuildError)) throw rebuildError;
        }
      }
      throw new UnreadableChunkError(address, root, error);
    }
  }

  /** A chunk read on the readers in turn, each try after the wait before it. */
  private async read(readers: readonly string[], address: string, signal: AbortSignal): Promise<Uint8Array> {
    let last: unknown = new Error('There is no node to read through.');
    // A try the node did not answer outweighs a not-found: the chunk counts as lost only when every try said so.
    let unanswered: unknown = null;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1]!, signal);
      const reader = readers[attempt % readers.length];
      if (reader === undefined) break;
      try {
        return await this.node.readChunk(reader, address, signal);
      } catch (error) {
        if (signal.aborted || !retryable(error)) throw error;
        last = error;
        if (isNodeFailure(error)) unanswered = error;
      }
    }
    throw unanswered ?? last;
  }

  /**
   * One post, after the push window lets it go, tried again while the node does not answer. Counted under the tag
   * once the node answered it, and checked to be stored where it was read.
   */
  private async post(ctx: CopyContext, expected: string, send: () => Promise<string>): Promise<void> {
    await ctx.admit();
    let last: unknown = null;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1]!, ctx.signal);
      try {
        const stored = await send();
        ctx.counters.posts += 1;
        if (stored !== expected.toLowerCase()) {
          throw new ArchiveNodeError(
            'wrong_address',
            `The node stored a chunk as ${stored.slice(0, 12)}…, where ${expected.slice(0, 12)}… was expected.`,
          );
        }
        return;
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        if (!(error instanceof ArchiveNodeError) || error.problem !== 'node') throw error;
        last = error;
      }
    }
    throw last;
  }
}

/** The bytes under a root, joined from the data chunks kept, in order. */
function join(address: string, kept: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const chunk = kept.get(address);
  if (!chunk) throw new Error('A chunk of the playlist was not kept.');
  const span = spanOf(chunk);
  if (span <= CHUNK_PAYLOAD_BYTES) return chunk.subarray(SPAN_BYTES, SPAN_BYTES + span);
  const parts = splitReferences(chunk).data.map((child) => join(child, kept));
  return new Uint8Array(Buffer.concat(parts)).subarray(0, span);
}
