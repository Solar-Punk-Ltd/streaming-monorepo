/**
 * What an archive asks of a Bee node, over its HTTP API: a chunk read raw, a file read whole so Bee rebuilds what it
 * lost from parity, a chunk or a feed slot posted under a batch and a tag, a tag created and read, and the stamps a
 * batch has used. `docs/architecture/web2-admin.md`, "The job", is the design.
 *
 * A read that receives nothing for {@link ARCHIVE_STALL_TIMEOUT_MS} is abandoned, whatever its total length: a node
 * looking for a chunk on the network can take seconds, and one that stopped answering would otherwise hold the copy
 * for ever. Every post goes with `swarm-tag` and without `swarm-deferred-upload`: with a tag, Bee defers the push and
 * the tag counts it.
 */

/** How long a read may receive nothing before it is abandoned and tried again. */
export const ARCHIVE_STALL_TIMEOUT_MS = 30_000;

/** A Bee tag as `GET /tags/{uid}` answers it: the chunks posted under it, and how far each got. */
export interface TagReading {
  /** Every post under the tag, a chunk posted again counted again. */
  split: number;
  /** Posts whose chunk was still waiting to be pushed from an earlier post: they sync with that one. */
  seen: number;
  stored: number;
  /** Push attempts, which overshoot. */
  sent: number;
  /** Posts whose chunk reached the network. */
  synced: number;
}

/**
 * Why a node refused a post, as the archive answers it:
 * - `batch_full`: the batch's bucket for the chunk is full (402), which an immutable batch never makes room in;
 * - `batch_unusable`: Bee does not hold the batch, or cannot stamp with it yet (404, 422);
 * - `tag_gone`: the node does not know the tag (404);
 * - `wrong_address`: the node stored the chunk under another address than the one the copy expected;
 * - `node`: the node did not answer, or answered anything else.
 */
export type ArchiveNodeProblem = 'batch_full' | 'batch_unusable' | 'tag_gone' | 'wrong_address' | 'node';

export class ArchiveNodeError extends Error {
  constructor(
    readonly problem: ArchiveNodeProblem,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ArchiveNodeError';
  }
}

/** A chunk the node answered 404 for: the network did not give it within the node's own search. */
export class ChunkMissingError extends Error {
  constructor(readonly address: string) {
    super(`The chunk ${address.slice(0, 12)}… was not found.`);
    this.name = 'ChunkMissingError';
  }
}

export interface ArchiveNode {
  /** The chunk at `address`, span included, and the single-owner header for a feed slot. */
  readChunk(url: string, address: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Reads the file under `reference` whole and drops it: the read makes Bee rebuild lost chunks from their parity. */
  readFile(url: string, reference: string, signal: AbortSignal): Promise<void>;
  /** Posts a content-addressed chunk under the batch and tag, and answers the address the node stored it under. */
  postChunk(url: string, batchId: string, tagUid: number, chunk: Uint8Array, signal: AbortSignal): Promise<string>;
  /** Posts a single-owner chunk with the signature it carries, and answers its address. */
  postSoc(url: string, batchId: string, tagUid: number, soc: SocPost, signal: AbortSignal): Promise<string>;
  createTag(url: string, signal: AbortSignal): Promise<number>;
  /** The tag, or null when the node does not know it. */
  readTag(url: string, uid: number, signal: AbortSignal): Promise<TagReading | null>;
  /** The stamps the batch has used: the sum of `GET /stamps/{id}/buckets`' counts. */
  bucketSum(url: string, batchId: string, signal: AbortSignal): Promise<number>;
}

/** A feed slot as it is posted: its owner, identifier and signature in hex, and the chunk it wraps. */
export interface SocPost {
  owner: string;
  identifier: string;
  signature: string;
  wrapped: Uint8Array;
}

const BOOKKEEPING_TIMEOUT_MS = 30_000;

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

/** An abort signal that fires after `ms` with no reset, or when `outer` does. */
function stallSignal(outer: AbortSignal, ms: number): { signal: AbortSignal; reset(): void; done(): void } {
  const controller = new AbortController();
  const stalled = () => controller.abort(new Error('stalled'));
  let timer = setTimeout(stalled, ms);
  const onAbort = () => controller.abort(outer.reason);
  if (outer.aborted) controller.abort(outer.reason);
  else outer.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    reset() {
      clearTimeout(timer);
      timer = setTimeout(stalled, ms);
    },
    done() {
      clearTimeout(timer);
      outer.removeEventListener('abort', onAbort);
    },
  };
}

/** Reads a body whole, each piece that arrives resetting the stall. */
async function readStalling(response: Response, stall: { reset(): void }, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      stall.reset();
      parts.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(parts, length));
}

async function refusalOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON: the text is the reason.
  }
  return text.slice(0, 200);
}

/** A failure as the archive reads it: what the caller aborted stays its abort; anything else is the node's. */
function nodeFailure(error: unknown, signal: AbortSignal, what: string): unknown {
  if (signal.aborted) return error;
  if (error instanceof ArchiveNodeError || error instanceof ChunkMissingError) return error;
  const stalled = error instanceof Error && (error.message === 'stalled' || error.name === 'TimeoutError');
  return new ArchiveNodeError(
    'node',
    stalled ? `The node sent nothing for a while during ${what}.` : `The node could not be reached for ${what}.`,
  );
}

/** The real thing, over fetch. */
export class BeeArchiveNode implements ArchiveNode {
  constructor(private readonly stallMs: number = ARCHIVE_STALL_TIMEOUT_MS) {}

  async readChunk(url: string, address: string, signal: AbortSignal): Promise<Uint8Array> {
    const stall = stallSignal(signal, this.stallMs);
    try {
      const response = await fetch(`${base(url)}/chunks/${address}`, { signal: stall.signal });
      if (response.status === 404) {
        await response.body?.cancel();
        throw new ChunkMissingError(address);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ArchiveNodeError('node', `The node answered ${response.status} for a chunk.`, response.status);
      }
      return await readStalling(response, stall, stall.signal);
    } catch (error) {
      throw nodeFailure(error, signal, 'a chunk read');
    } finally {
      stall.done();
    }
  }

  async readFile(url: string, reference: string, signal: AbortSignal): Promise<void> {
    const stall = stallSignal(signal, this.stallMs);
    try {
      const response = await fetch(`${base(url)}/bytes/${reference}`, { signal: stall.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ArchiveNodeError(
          'node',
          `The node answered ${response.status} reading a segment whole.`,
          response.status,
        );
      }
      await readStalling(response, stall, stall.signal);
    } catch (error) {
      throw nodeFailure(error, signal, 'a segment read');
    } finally {
      stall.done();
    }
  }

  async postChunk(
    url: string,
    batchId: string,
    tagUid: number,
    chunk: Uint8Array,
    signal: AbortSignal,
  ): Promise<string> {
    return this.post(`${base(url)}/chunks`, batchId, tagUid, chunk, signal);
  }

  async postSoc(url: string, batchId: string, tagUid: number, soc: SocPost, signal: AbortSignal): Promise<string> {
    const owner = soc.owner.replace(/^0x/i, '').toLowerCase();
    return this.post(
      `${base(url)}/soc/${owner}/${soc.identifier}?sig=${soc.signature}`,
      batchId,
      tagUid,
      soc.wrapped,
      signal,
    );
  }

  async createTag(url: string, signal: AbortSignal): Promise<number> {
    const response = await this.bookkeeping(`${base(url)}/tags`, signal, { method: 'POST' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ArchiveNodeError('node', `The node answered ${response.status} creating a tag.`, response.status);
    }
    const { uid } = (await response.json()) as { uid?: unknown };
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) {
      throw new ArchiveNodeError('node', 'The node answered a tag without a uid.');
    }
    return uid;
  }

  async readTag(url: string, uid: number, signal: AbortSignal): Promise<TagReading | null> {
    const response = await this.bookkeeping(`${base(url)}/tags/${uid}`, signal);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ArchiveNodeError('node', `The node answered ${response.status} for a tag.`, response.status);
    }
    const tag = (await response.json()) as Record<string, unknown>;
    const count = (key: string) => {
      const value = tag[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    return {
      split: count('split'),
      seen: count('seen'),
      stored: count('stored'),
      sent: count('sent'),
      synced: count('synced'),
    };
  }

  async bucketSum(url: string, batchId: string, signal: AbortSignal): Promise<number> {
    const response = await this.bookkeeping(`${base(url)}/stamps/${batchId}/buckets`, signal);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new ArchiveNodeError('batch_unusable', 'The node does not hold the archive stamp.', 404);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ArchiveNodeError(
        'node',
        `The node answered ${response.status} for the stamp's buckets.`,
        response.status,
      );
    }
    const { buckets } = (await response.json()) as { buckets?: Array<{ collisions?: unknown }> };
    if (!Array.isArray(buckets)) {
      throw new ArchiveNodeError('node', "The node's answer for the stamp's buckets holds none.");
    }
    return buckets.reduce((sum, bucket) => sum + (typeof bucket.collisions === 'number' ? bucket.collisions : 0), 0);
  }

  private async bookkeeping(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(BOOKKEEPING_TIMEOUT_MS)]),
      });
    } catch (error) {
      throw nodeFailure(error, signal, 'a call');
    }
  }

  private async post(
    url: string,
    batchId: string,
    tagUid: number,
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'swarm-postage-batch-id': batchId,
          'swarm-tag': String(tagUid),
        },
        body: Buffer.from(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.stallMs)]),
      });
    } catch (error) {
      throw nodeFailure(error, signal, 'a post');
    }
    if (response.status === 201 || response.status === 200) {
      const { reference } = (await response.json()) as { reference?: unknown };
      if (typeof reference !== 'string') {
        throw new ArchiveNodeError('node', 'The node answered a post without a reference.');
      }
      return reference.toLowerCase();
    }
    const reason = await refusalOf(response);
    if (response.status === 402) throw new ArchiveNodeError('batch_full', `The archive stamp is full: ${reason}.`, 402);
    if (response.status === 422) {
      throw new ArchiveNodeError('batch_unusable', `The archive stamp cannot be used yet: ${reason}.`, 422);
    }
    if (response.status === 404) {
      if (/tag/i.test(reason)) throw new ArchiveNodeError('tag_gone', "The node does not know the copy's tag.", 404);
      throw new ArchiveNodeError('batch_unusable', `The node does not hold the archive stamp: ${reason}.`, 404);
    }
    throw new ArchiveNodeError('node', `The node answered ${response.status} to a post: ${reason}.`, response.status);
  }
}
