/** ISO timestamp → the operator's locale, or an em dash when absent. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** A long hex value elided in the middle: owners, topics, swarm references. */
export function shortHex(hex: string, lead = 8, tail = 6): string {
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/**
 * `<input type="datetime-local">` wants local wall-clock time with no zone,
 * and `new Date().toISOString()` is UTC — hence the hand-rolled formatting.
 */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function nowDateTimeLocalValue(): string {
  return toDateTimeLocalValue(new Date());
}

/** ISO string from the API → the value a datetime-local input accepts. */
export function isoToDateTimeLocalValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return toDateTimeLocalValue(date);
}

/** A datetime-local value → the ISO string the API stores, or null. */
export function dateTimeLocalValueToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
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
