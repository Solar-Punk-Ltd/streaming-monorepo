import { errorMessage } from '../../errors';

/**
 * The sentence the buy dialog shows for a purchase that was refused or failed: the API's own sentence, which is
 * `ARCHIVE_PURCHASES_NOT_OFFERED` for a manager that offers no purchases and names the new cost when the price moved.
 */
export function purchaseRefusal(e: unknown): string {
  return errorMessage(e, 'The purchase could not be started.');
}

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
