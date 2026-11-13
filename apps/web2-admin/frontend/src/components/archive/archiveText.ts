import { errorMessage } from '../../errors';

/**
 * The sentence the buy dialog shows for a purchase that was refused or failed: the API's own sentence, which is
 * `ARCHIVE_PURCHASES_NOT_OFFERED` for a manager that offers no purchases and names the new cost when the price moved.
 */
export function purchaseRefusal(e: unknown): string {
  return errorMessage(e, 'The purchase could not be started.');
}

/**
 * A batch id as the archive's answers carry it, 64 hex digits in lower case without `0x`, from one as the funding view
 * carries it, with `0x`: the key both are matched by.
 */
export function bareBatchId(batchId: string): string {
  return batchId.replace(/^0x/i, '').toLowerCase();
}

/** The bytes one chunk carries, `ARCHIVE_CHUNK_BYTES` of `packages/contracts`, which the console does not import. */
export const CHUNK_BYTES = 4096;

const UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e15, 'PB'],
  [1e12, 'TB'],
  [1e9, 'GB'],
  [1e6, 'MB'],
  [1e3, 'kB'],
];

/**
 * What a stamp holds, in decimal units with three significant digits at most, from kB to PB: `44.7 kB`, `2.6 GB`,
 * `8.93 PB`. The capacity table of `packages/contracts` gives its sizes the same way.
 */
export function formatCapacity(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  for (const [size, unit] of UNITS) {
    if (bytes >= size) return `${Number((bytes / size).toPrecision(3))} ${unit}`;
  }
  return `${Math.round(bytes)} B`;
}

/** A count of chunks with its thousands marked: `1,627 chunks`, `1 chunk`. */
export function chunkCount(chunks: number): string {
  return `${chunks.toLocaleString('en-US')} chunk${chunks === 1 ? '' : 's'}`;
}
