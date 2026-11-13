/**
 * How much an archive stamp holds, and which depth a recording needs. An archive stamp is an immutable batch on the
 * brand's catalogue node, which the web2 admin buys through the manager's funding API and copies finished recordings
 * onto. The manager's settings page and the admin's buy dialog both size with this file, so the two never disagree
 * about what a depth holds. `docs/architecture/web2-admin.md`, "Archiving a recording", is the design.
 *
 * A batch of depth `d` has `2^d` stamps in 65536 buckets, and a chunk's address picks its bucket. An immutable batch
 * refuses a chunk whose bucket is full, so it stops taking chunks well before all `2^d` stamps are used. The table
 * below is what such a batch holds before a bucket is expected to fill: bee-js's `getStampEffectiveBytes` for a plain
 * upload, with no encryption and no erasure coding, since an archive counts every chunk it copies itself, parity
 * included. `apps/web2-admin/backend` holds the test that compares every row with bee-js.
 */

/** The bytes one chunk carries. */
export const ARCHIVE_CHUNK_BYTES = 4096;

/** The shallowest depth a batch can have: one deeper than the 65536 buckets. */
export const ARCHIVE_MIN_DEPTH = 17;

/** The deepest depth the table names, and so the deepest an archive stamp is bought at. */
export const ARCHIVE_MAX_DEPTH = 41;

/** The room added to a recording's chunk count when a stamp is sized for it: 5%. */
export const ARCHIVE_SIZING_MARGIN = 0.05;

/** What an immutable batch of each depth holds, in bytes, from {@link ARCHIVE_MIN_DEPTH} to {@link ARCHIVE_MAX_DEPTH}. */
export const ARCHIVE_EFFECTIVE_BYTES_BY_DEPTH: Readonly<Record<number, number>> = {
  17: 44_700,
  18: 6_660_000,
  19: 112_060_000,
  20: 687_620_000,
  21: 2_600_000_000,
  22: 7_730_000_000,
  23: 19_940_000_000,
  24: 47_060_000_000,
  25: 105_510_000_000,
  26: 227_980_000_000,
  27: 476_680_000_000,
  28: 993_650_000_000,
  29: 2_040_000_000_000,
  30: 4_170_000_000_000,
  31: 8_450_000_000_000,
  32: 17_070_000_000_000,
  33: 34_360_000_000_000,
  34: 69_040_000_000_000,
  35: 138_540_000_000_000,
  36: 277_720_000_000_000,
  37: 556_350_000_000_000,
  38: 1_110_000_000_000_000,
  39: 2_230_000_000_000_000,
  40: 4_460_000_000_000_000,
  41: 8_930_000_000_000_000,
};

function isTableDepth(depth: number): boolean {
  return Number.isInteger(depth) && depth >= ARCHIVE_MIN_DEPTH && depth <= ARCHIVE_MAX_DEPTH;
}

/**
 * The bytes an immutable batch of `depth` holds, or 0 for a depth the table does not name: one under
 * {@link ARCHIVE_MIN_DEPTH}, one over {@link ARCHIVE_MAX_DEPTH}, or one that is not a whole number.
 */
export function archiveEffectiveBytes(depth: number): number {
  return isTableDepth(depth) ? ARCHIVE_EFFECTIVE_BYTES_BY_DEPTH[depth]! : 0;
}

/** The chunks an immutable batch of `depth` holds: its bytes in whole chunks, 0 for a depth the table does not name. */
export function archiveEffectiveChunks(depth: number): number {
  return Math.floor(archiveEffectiveBytes(depth) / ARCHIVE_CHUNK_BYTES);
}

/**
 * The chunks to make room for when `chunks` are to be copied: the count with `margin` added, rounded up. `chunks` is a
 * whole number of zero or more and `margin` zero or more, or it throws.
 */
export function archiveChunksWithMargin(chunks: number, margin: number = ARCHIVE_SIZING_MARGIN): number {
  if (!Number.isSafeInteger(chunks) || chunks < 0) throw new Error('A chunk count is a whole number of zero or more.');
  if (!Number.isFinite(margin) || margin < 0) throw new Error('A margin is zero or more.');
  return Math.ceil(chunks * (1 + margin));
}

/**
 * The shallowest depth whose batch holds `chunks` with `margin` added, which is the cheapest stamp a recording fits,
 * or null when no depth up to {@link ARCHIVE_MAX_DEPTH} holds it. A buy dialog offers this depth first and every
 * deeper one beside it.
 */
export function smallestArchiveDepthFor(chunks: number, margin: number = ARCHIVE_SIZING_MARGIN): number | null {
  const needed = archiveChunksWithMargin(chunks, margin);
  for (let depth = ARCHIVE_MIN_DEPTH; depth <= ARCHIVE_MAX_DEPTH; depth++) {
    if (archiveEffectiveChunks(depth) >= needed) return depth;
  }
  return null;
}

/**
 * The depths a buy dialog offers for `chunks`: the smallest that fits and every deeper one up to
 * {@link ARCHIVE_MAX_DEPTH}, shallowest first. Empty when none fits. With no count, as on the Stamps tab where no
 * recording is being sized, it is every depth of the table.
 */
export function archiveDepthChoices(chunks?: number, margin: number = ARCHIVE_SIZING_MARGIN): number[] {
  const first = chunks === undefined ? ARCHIVE_MIN_DEPTH : smallestArchiveDepthFor(chunks, margin);
  if (first === null) return [];
  return Array.from({ length: ARCHIVE_MAX_DEPTH - first + 1 }, (_, step) => first + step);
}

/**
 * What a batch of `depth` costs when each of its chunks is given `amountPerChunkPlur`: that amount for every one of
 * its `2^depth` stamps, in PLUR, as a decimal string. It is what the postage contract takes for a purchase and for a
 * top-up alike. `amountPerChunkPlur` is a whole number of PLUR as decimal digits, or it throws.
 */
export function archiveBatchCostPlur(depth: number, amountPerChunkPlur: string): string {
  if (!isTableDepth(depth))
    throw new Error(`An archive stamp's depth is ${ARCHIVE_MIN_DEPTH} to ${ARCHIVE_MAX_DEPTH}.`);
  if (!/^(0|[1-9]\d{0,77})$/.test(amountPerChunkPlur)) throw new Error('An amount is a whole number of PLUR.');
  return (BigInt(amountPerChunkPlur) << BigInt(depth)).toString();
}

/**
 * The amount each chunk needs for a batch to last `seconds` at `pricePerChunkPerBlockPlur`, with blocks of
 * `blockSeconds`: the price for every block of that time, rounded up to a whole block, in PLUR as a decimal string.
 * The price moves, so the life a batch really gets is the one its node reports afterwards.
 */
export function archiveAmountPerChunkPlur(
  seconds: number,
  pricePerChunkPerBlockPlur: string,
  blockSeconds: number,
): string {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('A life is more than no time.');
  if (!Number.isInteger(blockSeconds) || blockSeconds <= 0)
    throw new Error('A block time is a whole number of seconds.');
  if (!/^[1-9]\d{0,77}$/.test(pricePerChunkPerBlockPlur)) throw new Error('A price is a whole number of PLUR above 0.');
  const blocks = BigInt(Math.ceil(seconds / blockSeconds));
  return (BigInt(pricePerChunkPerBlockPlur) * blocks).toString();
}
