import { Span } from '@ethersphere/bee-js';

/** Every chunk starts with its span: 8 bytes, little-endian. */
export const SPAN_LENGTH = 8;

const SEVEN_BYTES = (1n << 56n) - 1n;
const LEVEL_MARK = 0x80n;

/**
 * The span at `offset`, as stored. A chunk's address is made over these bytes, so a hash takes this value, never the
 * length {@link bodyLengthOf} reads out of it.
 */
export function storedSpanOf(bytes: Uint8Array, offset = 0): bigint {
  return Span.fromSlice(bytes, offset).toBigInt();
}

/**
 * How many bytes of body the chunk whose span is at `offset` stands for.
 *
 * An erasure-coded upload keeps its redundancy level in the top byte of every intermediate chunk's span, as 0x80
 * plus the level, and the real length in the 7 bytes below (Bee's `redundancy.EncodeLevel` and `DecodeSpan`). Read
 * whole, such a span names a body of about 9.3e18 bytes. bee-js 13 does not export its own decoder, which lives in
 * `@ethersphere/core-sdk` as `decodeRedundancyLevel`, so this follows the same rule: a top byte above 0x80 is a level.
 */
export function bodyLengthOf(bytes: Uint8Array, offset = 0): bigint {
  const span = storedSpanOf(bytes, offset);
  return span >> 56n > LEVEL_MARK ? span & SEVEN_BYTES : span;
}
