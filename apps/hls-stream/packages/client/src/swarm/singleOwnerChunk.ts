import { Bytes, ChunkBuilder, EthAddress, Identifier, Signature } from '@ethersphere/bee-js';

import type { SwarmAnswer } from './answers';
import { bodyLengthOf, SPAN_LENGTH, storedSpanOf } from './chunkSpan';

// A single-owner chunk is the identifier, the owner's signature, then the content-addressed chunk it
// wraps, its span and its payload. These are the offsets Bee and bee-js lay it out at.
const IDENTIFIER_LENGTH = 32;
const SIGNATURE_LENGTH = 65;
const SPAN_OFFSET = IDENTIFIER_LENGTH + SIGNATURE_LENGTH;

/** The most payload one chunk carries. A span past it says the payload is the root of a tree of chunks. */
const MAX_CHUNK_PAYLOAD = 4096;

/** The content-addressed chunk a single-owner chunk wraps. */
interface WrappedChunk {
  /** How many bytes the wrapped chunk stands for, which is more than its payload for a tree's root. */
  readonly bodyLength: bigint;
  readonly payload: Uint8Array;
  /** Its address, hashed over the span as stored, which the bytes of a tree are read from. */
  readonly wrappedAddress: string;
}

/** What a single-owner chunk read by its address holds, once it has proved to be its owner's. */
export interface SingleOwnerChunk extends WrappedChunk {
  /** Its owner, as 40 hex digits without `0x`. */
  readonly owner: string;
}

type ContentAnswer = Extract<SwarmAnswer, { kind: 'content' }>;

/** The address an owner's single-owner chunk under an identifier is stored at, as 64 hex digits. */
export function singleOwnerChunkAddress(identifier: Identifier, owner: string): string {
  return Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), new EthAddress(owner).toUint8Array())).toHex();
}

/**
 * A content-addressed chunk given as its span and payload, the part of a single-owner chunk after its signature.
 *
 * @throws When the bytes are shorter than a span or carry more than one chunk's payload.
 */
function wrappedChunkOf(bytes: Uint8Array): WrappedChunk {
  if (bytes.length < SPAN_LENGTH || bytes.length - SPAN_LENGTH > MAX_CHUNK_PAYLOAD) {
    throw new Error(`a chunk is a span and at most ${MAX_CHUNK_PAYLOAD} bytes of payload, this one is ${bytes.length}`);
  }
  const payload = bytes.slice(SPAN_LENGTH);
  const wrapped = new ChunkBuilder(storedSpanOf(bytes));
  wrapped.writer.buffer.set(payload);
  return { bodyLength: bodyLengthOf(bytes), payload, wrappedAddress: wrapped.hash().toHex() };
}

/**
 * A single-owner chunk read by its address, checked as bee-js checks it: the owner is recovered from
 * the signature over the identifier and the wrapped chunk's address, and the identifier and that
 * owner must make the address it was read from. A gateway can serve any bytes at any address, so this
 * is what makes them the owner's.
 *
 * @throws When the bytes are too short to be one, or are not the chunk at `address`.
 */
export function parseSingleOwnerChunk(data: Uint8Array, address: string): SingleOwnerChunk {
  if (data.length < SPAN_OFFSET + SPAN_LENGTH) {
    throw new Error(`a single-owner chunk is at least ${SPAN_OFFSET + SPAN_LENGTH} bytes, this one is ${data.length}`);
  }
  const identifier = new Identifier(data.slice(0, IDENTIFIER_LENGTH));
  const signature = new Signature(data.slice(IDENTIFIER_LENGTH, SPAN_OFFSET));
  const wrapped = wrappedChunkOf(data.slice(SPAN_OFFSET));

  const owner = signature
    .recoverPublicKey(Bytes.concat(identifier.toUint8Array(), new Bytes(wrapped.wrappedAddress).toUint8Array()))
    .address()
    .toHex();
  if (singleOwnerChunkAddress(identifier, owner) !== address.toLowerCase()) {
    throw new Error(`the chunk served for ${address} is not the single-owner chunk at that address`);
  }
  return { ...wrapped, owner };
}

/**
 * The body a single-owner chunk stands for, as Bee's `/soc` answers it: the payload, or for the root of a tree the
 * bytes read at the root's address, which must be as long as the span says. `served` is the read that brought the
 * chunk, whose other fields the answer keeps, and `fault` is how the reader says a body was of the wrong length.
 */
export async function socBodyOf(
  chunk: WrappedChunk,
  served: ContentAnswer,
  readBytes: (reference: string) => Promise<SwarmAnswer>,
  fault: (why: string) => SwarmAnswer,
): Promise<SwarmAnswer> {
  if (chunk.bodyLength <= BigInt(MAX_CHUNK_PAYLOAD)) {
    return { ...served, bytes: chunk.payload };
  }
  const joined = await readBytes(chunk.wrappedAddress);
  if (joined.kind !== 'content') {
    return joined;
  }
  if (BigInt(joined.bytes.length) !== chunk.bodyLength) {
    return fault(`answering ${joined.bytes.length} bytes for a body of ${chunk.bodyLength}`);
  }
  return { ...served, bytes: joined.bytes };
}
