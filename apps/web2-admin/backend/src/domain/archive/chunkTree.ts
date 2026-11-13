import { Bee, Bytes, FeedIndex, Span, Topic } from '@ethersphere/bee-js';

/**
 * The shapes of Swarm chunks an archive copies, read from the bytes alone: how much a chunk's tree spans, its erasure
 * level, which of its references are data and which are parity, and where a feed slot is. Nothing here reaches a node.
 * `docs/architecture/web2-admin.md`, "What is copied", is the design.
 *
 * A content-addressed chunk is its span, 8 bytes little-endian, then up to 4096 bytes. The span's top byte carries
 * the erasure level of the tree under it (`0x80 | level`), and its lower 7 bytes the bytes the tree spans. A
 * single-owner chunk is its identifier, 32 bytes, and its signature, 65, before the content-addressed chunk it wraps.
 */

export const SPAN_BYTES = 8;
export const CHUNK_PAYLOAD_BYTES = 4096;
export const REFERENCE_BYTES = 32;
export const SOC_IDENTIFIER_BYTES = 32;
export const SOC_SIGNATURE_BYTES = 65;
export const SOC_HEADER_BYTES = SOC_IDENTIFIER_BYTES + SOC_SIGNATURE_BYTES;
/** The references an intermediate chunk holds at most. */
export const BRANCHES = CHUNK_PAYLOAD_BYTES / REFERENCE_BYTES;

const SPAN_VALUE_MASK = 0x00ffffffffffffffn;
const LEVEL_FLAG = 0x80;

/** A chunk's erasure level: 0 none, 1 medium, 2 strong, 3 insane, 4 paranoid. */
export type RedundancyLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Bee's parity tables for unencrypted chunks (`pkg/file/redundancy/level.go`): for a group of data shards, the first
 * row whose shard count is at most the group's gives its parity count.
 */
const PARITY_TABLES: Readonly<Record<1 | 2 | 3 | 4, ReadonlyArray<readonly [number, number]>>> = {
  1: [
    [95, 9],
    [69, 8],
    [47, 7],
    [29, 6],
    [15, 5],
    [6, 4],
    [2, 3],
    [1, 2],
  ],
  2: [
    [105, 21],
    [96, 20],
    [87, 19],
    [78, 18],
    [70, 17],
    [62, 16],
    [54, 15],
    [47, 14],
    [40, 13],
    [33, 12],
    [27, 11],
    [21, 10],
    [16, 9],
    [11, 8],
    [7, 7],
    [4, 6],
    [2, 5],
    [1, 4],
  ],
  3: [
    [93, 31],
    [88, 30],
    [83, 29],
    [78, 28],
    [74, 27],
    [69, 26],
    [64, 25],
    [60, 24],
    [55, 23],
    [51, 22],
    [46, 21],
    [42, 20],
    [38, 19],
    [34, 18],
    [30, 17],
    [27, 16],
    [23, 15],
    [20, 14],
    [17, 13],
    [14, 12],
    [11, 11],
    [9, 10],
    [6, 9],
    [4, 8],
    [3, 7],
    [2, 6],
    [1, 5],
  ],
  4: [
    [37, 89],
    [36, 87],
    [35, 86],
    [34, 84],
    [33, 83],
    [32, 81],
    [31, 80],
    [30, 78],
    [29, 76],
    [28, 75],
    [27, 73],
    [26, 71],
    [25, 70],
    [24, 68],
    [23, 66],
    [22, 65],
    [21, 63],
    [20, 61],
    [19, 59],
    [18, 58],
    [17, 56],
    [16, 54],
    [15, 52],
    [14, 50],
    [13, 48],
    [12, 47],
    [11, 45],
    [10, 43],
    [9, 40],
    [8, 38],
    [7, 36],
    [6, 34],
    [5, 31],
    [4, 29],
    [3, 26],
    [2, 23],
    [1, 19],
  ],
};

/** The bytes the tree under this chunk spans, without the erasure level. */
export function spanOf(chunk: Uint8Array): number {
  if (chunk.length < SPAN_BYTES) throw new Error('A chunk is shorter than its span.');
  return Number(Buffer.from(chunk.buffer, chunk.byteOffset, SPAN_BYTES).readBigUInt64LE(0) & SPAN_VALUE_MASK);
}

/** The erasure level the chunk's span carries, 0 when it carries none. */
export function levelOf(chunk: Uint8Array): RedundancyLevel {
  const top = chunk[SPAN_BYTES - 1] ?? 0;
  if (top <= LEVEL_FLAG) return 0;
  const level = top & (LEVEL_FLAG - 1);
  return (level >= 1 && level <= 4 ? level : 0) as RedundancyLevel;
}

/** The parity chunks Bee adds to a group of `shards` data chunks at `level`. */
export function parityCount(level: RedundancyLevel, shards: number): number {
  if (level === 0) return 0;
  for (const [atLeast, parities] of PARITY_TABLES[level]) if (shards >= atLeast) return parities;
  return 0;
}

/** The most data shards an intermediate chunk at `level` holds beside their parity: 128 less a full group's. */
export function maxShards(level: RedundancyLevel): number {
  return BRANCHES - parityCount(level, BRANCHES);
}

/**
 * The references an intermediate chunk holds, split into the data references to descend into and the parity
 * references to copy but never open. A parity chunk carries coded bytes and a span that looks like an intermediate's,
 * so reading it as references gives nonsense. A data chunk, whose span fits in one chunk, holds none. Throws for an
 * intermediate whose count fits no row of its level's table.
 */
export function splitReferences(chunk: Uint8Array): { data: string[]; parity: string[] } {
  if (spanOf(chunk) <= CHUNK_PAYLOAD_BYTES) return { data: [], parity: [] };
  const payload = chunk.subarray(SPAN_BYTES);
  const references: string[] = [];
  for (let at = 0; at + REFERENCE_BYTES <= payload.length; at += REFERENCE_BYTES) {
    references.push(Buffer.from(payload.subarray(at, at + REFERENCE_BYTES)).toString('hex'));
  }
  const level = levelOf(chunk);
  if (level === 0) return { data: references, parity: [] };
  for (let shards = references.length; shards >= 1; shards--) {
    if (shards + parityCount(level, shards) === references.length) {
      return { data: references.slice(0, shards), parity: references.slice(shards) };
    }
  }
  throw new Error(
    `An intermediate chunk of erasure level ${level} holds ${references.length} references, which fits no parity group.`,
  );
}

/** The chunks of a tree, by kind, as Bee builds one over `bytes` at `level`. */
export interface TreeShape {
  data: number;
  intermediate: number;
  parity: number;
}

/**
 * The chunks Bee builds for `bytes` at `level`: the data chunks, then each level of intermediates grouping up to
 * {@link maxShards} references with their parity, up to one root. Identical data chunks are stored once, so a real
 * tree can hold fewer: this is an upper bound, and it was exact for every segment step 0 measured but one.
 */
export function treeShape(bytes: number, level: RedundancyLevel): TreeShape {
  const data = Math.max(1, Math.ceil(bytes / CHUNK_PAYLOAD_BYTES));
  let intermediate = 0;
  let parity = 0;
  let count = data;
  const groupSize = maxShards(level);
  while (count > 1) {
    const groups = Math.ceil(count / groupSize);
    for (let group = 0; group < groups; group++) {
      const shards = group < groups - 1 ? groupSize : count - groupSize * (groups - 1);
      parity += parityCount(level, shards);
    }
    intermediate += groups;
    count = groups;
  }
  return { data, intermediate, parity };
}

/** The chunks of a tree, all kinds together. */
export function treeChunks(bytes: number, level: RedundancyLevel): number {
  const shape = treeShape(bytes, level);
  return shape.data + shape.intermediate + shape.parity;
}

/** The address of a feed's slot: keccak256(keccak256(topic ‖ index) ‖ owner), as 64 hex digits. */
export function feedSlotAddress(owner: string, topic: string, index: number): string {
  const identifier = Bytes.keccak256(
    Bytes.concat(Topic.fromString(topic).toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array()),
  );
  const ownerBytes = Buffer.from(owner.replace(/^0x/i, ''), 'hex');
  return Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), ownerBytes)).toHex();
}

/** A single-owner chunk taken apart: its identifier and signature in hex, and the content-addressed chunk it wraps. */
export interface SocParts {
  identifier: string;
  signature: string;
  wrapped: Uint8Array;
}

export function socParts(soc: Uint8Array): SocParts {
  if (soc.length < SOC_HEADER_BYTES + SPAN_BYTES) throw new Error('A single-owner chunk is shorter than its header.');
  return {
    identifier: Buffer.from(soc.subarray(0, SOC_IDENTIFIER_BYTES)).toString('hex'),
    signature: Buffer.from(soc.subarray(SOC_IDENTIFIER_BYTES, SOC_HEADER_BYTES)).toString('hex'),
    wrapped: soc.subarray(SOC_HEADER_BYTES),
  };
}

/** For bee-js's pure chunk hashing only; it is never asked anything over HTTP. */
const helpers = new Bee('http://127.0.0.1:1633');

/** The address of a content-addressed chunk, span included: the BMT hash of its payload under its span. */
export function chunkAddress(chunk: Uint8Array): string {
  const span = Span.fromSlice(chunk, 0);
  return helpers.makeContentAddressedChunk(chunk.subarray(SPAN_BYTES), span).address.toHex();
}

/**
 * What a feed slot's payload is: the payload itself when it fits in one chunk, or, above 4096 bytes, the root chunk it
 * wraps, which Bee's feed lookup and the export both read by its own address. The root is the slot's wrapped chunk,
 * so it is rebuilt from the slot's bytes, its address computed from them.
 */
export function wrappedPayload(
  soc: Uint8Array,
): { kind: 'inline'; payload: Uint8Array } | { kind: 'root'; address: string; chunk: Uint8Array } {
  const { wrapped } = socParts(soc);
  const span = spanOf(wrapped);
  if (span <= CHUNK_PAYLOAD_BYTES) return { kind: 'inline', payload: wrapped.subarray(SPAN_BYTES, SPAN_BYTES + span) };
  const chunk = new Uint8Array(wrapped);
  return { kind: 'root', address: chunkAddress(chunk), chunk };
}
