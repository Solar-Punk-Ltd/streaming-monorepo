/**
 * The few ways a number, a moment or a long hex value is written in the
 * readiness sentences. They lived in the console's `format.ts` until the
 * readiness composition moved here, on 2026-09-28, so that the manager can
 * work out a stage's readiness in the words the console shows it with. The
 * console's `format.ts` passes these on unchanged.
 */

/** Shown where a number is not known. Never an em dash, which reads as prose. */
export const NO_VALUE = '–';

/** BZZ is quoted in PLUR. */
export const BZZ_DECIMALS = 16;
/** xDAI is an ordinary 18-decimal native token. */
export const XDAI_DECIMALS = 18;

/**
 * Format a base-unit integer string (e.g. wei) to a decimal token amount.
 * Uses BigInt to avoid precision loss. xDAI has 18 decimals, BZZ (PLUR) has 16.
 */
export function formatTokenBalance(raw: string | null | undefined, decimals: number, fractionDigits = 4): string {
  if (raw == null || raw === '') return NO_VALUE;
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return raw;
  }
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const rem = value % base;
  const scaled = (rem * 10n ** BigInt(fractionDigits)) / base;
  const frac = scaled.toString().padStart(fractionDigits, '0');
  return `${whole.toString()}.${frac}`;
}

export function formatTtl(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return NO_VALUE;
  if (seconds < 0) return 'unknown';
  if (seconds === 0) return 'expired';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Date and clock time, for the moment something failed. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'time unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'time unknown';
  return date.toLocaleString('en-GB');
}

/** A long hex value elided in the middle: batch ids, addresses, tx hashes. */
export function shortHex(hex: string, lead = 8, tail = 6): string {
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}
