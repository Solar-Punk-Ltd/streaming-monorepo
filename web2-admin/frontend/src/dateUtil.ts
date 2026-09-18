/**
 * Every date the console shows or converts, in one place.
 *
 * The console reads `DD/MM/YYYY HH:mm` and nothing else: EU order, 24-hour
 * clock, zero padded, local time, fixed rather than taken from the browser
 * locale so a screenshot from one machine matches a screenshot from another.
 * The picker field, the caption under it and every table cell go through the
 * helpers here, so the two spellings of the same instant cannot drift apart.
 */

/** The dayjs/MUI token string for the one format the console displays. */
export const DATE_TIME_FORMAT = 'DD/MM/YYYY HH:mm';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The single producer of the `DD/MM/YYYY HH:mm` string. Hand-rolled rather
 * than `toLocaleString`, because the picker renders the same instant from
 * `DATE_TIME_FORMAT` and a locale would answer something else.
 */
export function formatHumanDateTime(date: Date): string {
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * ISO timestamp → `DD/MM/YYYY HH:mm` in local time, an em dash when there is
 * no value, and the string itself when it is not a date this can read — a
 * value the API sent is worth showing even when it is malformed.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatHumanDateTime(date);
}

/**
 * `<input type="datetime-local">` wants local wall-clock time with no zone,
 * and `new Date().toISOString()` is UTC — hence the hand-rolled formatting.
 */
export function toDateTimeLocalValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
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
