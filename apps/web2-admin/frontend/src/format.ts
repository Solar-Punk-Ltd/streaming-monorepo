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
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * A batch's time to live as the manager read it: `12 days`, `1 day 4 h`,
 * `5 h 12 min`, `40 min`. An em dash when the node did not say, or said a
 * negative number, which is how Bee answers when it cannot work it out.
 */
export function formatTimeLeft(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 7) return `${days} days`;
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ${hours % 24} h`;
  if (hours >= 1) return `${hours} h ${minutes % 60} min`;
  return `${minutes} min`;
}

/** A ratio from 0 to 1 as a whole percentage, or an em dash when there is none. */
export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}
