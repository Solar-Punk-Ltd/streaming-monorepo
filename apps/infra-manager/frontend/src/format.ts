import {
  BZZ_DECIMALS,
  formatDateTime,
  formatTokenBalance,
  formatTtl,
  NO_VALUE,
  shortHex,
  XDAI_DECIMALS,
} from '@streaming-infra-manager/common';

// The readiness sentences write these, and the readiness composition lives in
// the common package since 2026-09-28, so the manager works it out in the same
// words. They are passed on here so every page keeps importing them from one place.
export { BZZ_DECIMALS, formatDateTime, formatTokenBalance, formatTtl, NO_VALUE, shortHex, XDAI_DECIMALS };

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1610612736 → "1.5 GB". null/undefined → the no-value dash. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return NO_VALUE;
  if (bytes < 1) return '0 B';
  const exp = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 100 || exp === 0 ? 0 : 1)} ${UNITS[exp]}`;
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return NO_VALUE;
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatCores(cpuPercent: number | null | undefined): string {
  if (cpuPercent == null || !Number.isFinite(cpuPercent)) return NO_VALUE;
  return (cpuPercent / 100).toFixed(2);
}

export function formatPercent(percent: number | null | undefined, digits = 0): string {
  if (percent == null || !Number.isFinite(percent)) return NO_VALUE;
  return `${percent.toFixed(digits)}%`;
}

/**
 * `used / total` as a percentage, with decimals scaled to the magnitude so
 * tiny shares stay legible (0.04%) while big ones stay clean (37%).
 */
export function formatSharePercent(used: number | null | undefined, total: number | null | undefined): string {
  if (used == null || total == null || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return NO_VALUE;
  }
  return formatScaledPercent((used / total) * 100);
}

/** A percentage with its decimals scaled to its magnitude, by the rule `formatSharePercent` applies. */
export function formatScaledPercent(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return NO_VALUE;
  const digits = pct >= 10 ? 0 : pct >= 1 ? 1 : 2;
  return `${pct.toFixed(digits)}%`;
}

/** "3 Sep 2026". Dates are read, not sorted, everywhere they appear here. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** How many characters of a commit sha are shown, the way git abbreviates. */
const COMMIT_SHORT_LENGTH = 7;

export function shortCommit(sha: string): string {
  return sha.slice(0, COMMIT_SHORT_LENGTH);
}
