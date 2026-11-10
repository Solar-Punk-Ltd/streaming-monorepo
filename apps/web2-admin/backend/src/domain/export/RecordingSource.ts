import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { Bee, Bytes, EthAddress, FeedIndex, Identifier, Reference, Topic } from '@ethersphere/bee-js';

/** The node a recording is read through: the catalogue node the manager designated, as its record names it. */
export interface ReadNode {
  beeApiUrl: string;
}

/** Where a recording playlist is: the feed's owner, its topic as the UUID the admin holds, and the slot's index. */
export interface RecordingFeed {
  owner: string;
  topic: string;
  index: number;
}

/** Reading a recording from Swarm: its playlist, then its segments, each to a file. */
export interface RecordingSource {
  readPlaylist(node: ReadNode, feed: RecordingFeed, signal?: AbortSignal): Promise<string>;
  /** Reads one segment into `destination`, and answers its size. A failed read leaves no file. */
  readSegment(node: ReadNode, reference: string, destination: string, signal?: AbortSignal): Promise<number>;
}

/** The largest payload a chunk holds; a feed payload above it is a wrapped chunk, as bee-js writes one. */
const CHUNK_PAYLOAD_SIZE = 4096n;

/**
 * A reference the node does not hold is looked for on the network before Bee answers, which takes seconds, and a
 * segment is a few megabytes. A minute is a node that is not answering, and the read is retried.
 */
const READ_TIMEOUT_MS = 60_000;

/**
 * The real thing. The playlist is read from the slot the admin recorded for the recording, not from the feed's head:
 * the recording a stream points at is a fixed slot, and the head may be a newer session's. The uploader writes a
 * playlist as bee-js's `updateFeedWithPayload` does, so a playlist above one chunk is a wrapped chunk whose root the
 * node resolves, as the catalogue's own slots are read in `BeeFeedGateway`.
 *
 * Segments are read from `/bytes/<reference>` on the same node and streamed to disk.
 */
export class BeeRecordingSource implements RecordingSource {
  async readPlaylist(node: ReadNode, feed: RecordingFeed, signal?: AbortSignal): Promise<string> {
    const bee = new Bee(node.beeApiUrl);
    const topic = Topic.fromString(feed.topic);
    const index = FeedIndex.fromBigInt(BigInt(feed.index));
    const identifier = new Identifier(Bytes.keccak256(Bytes.concat(topic.toUint8Array(), index.toUint8Array())));
    const owner = new EthAddress(feed.owner);
    const address = new Reference(Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), owner.toUint8Array())));
    const requestOptions = { timeout: READ_TIMEOUT_MS, signal };

    const bytes = await bee.chunk.download(address, undefined, requestOptions);
    const soc = bee.unmarshalSingleOwnerChunk(bytes, address);
    if (soc.span.toBigInt() <= CHUNK_PAYLOAD_SIZE) return decode(soc.payload.toUint8Array());
    const root = bee.makeContentAddressedChunk(soc.payload.toUint8Array(), soc.span).address;
    const data = await bee.data.download(root, undefined, requestOptions);
    return decode(data.toUint8Array());
  }

  async readSegment(node: ReadNode, reference: string, destination: string, signal?: AbortSignal): Promise<number> {
    const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
    const response = await fetch(`${node.beeApiUrl.replace(/\/+$/, '')}/bytes/${reference}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`the node answered ${response.status} for segment ${reference.slice(0, 12)}…`);
    }
    const part = `${destination}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(part));
      const { size } = await stat(part);
      if (size === 0) throw new Error(`the node answered an empty segment ${reference.slice(0, 12)}…`);
      await rename(part, destination);
      return size;
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
