/**
 * Formatting that is not a date. Everything about dates and times lives in
 * `dateUtil.ts`, so there is one answer to what a timestamp looks like.
 */

/** A long hex value elided in the middle: owners, topics, swarm references. */
export function shortHex(hex: string, lead = 8, tail = 6): string {
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/**
 * Seconds as the uploader reports them → what an operator reads. Whole
 * seconds: the fractional part of a recording's length is noise on a details
 * page, and the exact value is on the feed entry for anything that needs it.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}
