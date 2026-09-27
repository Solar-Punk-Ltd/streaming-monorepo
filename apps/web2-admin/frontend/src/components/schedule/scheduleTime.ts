import dayjs, { type Dayjs } from 'dayjs';

import { formatHumanDateTime, toDateTimeLocalValue } from '../../dateUtil';

/**
 * Every date calculation the three scheduler variants need, as pure
 * functions. `now` is always a parameter — never `Date.now()` inside — so the
 * awkward cases (a DST transition, the last hour of a year, a Saturday
 * evening) can be tested by handing in a fixed instant.
 *
 * All arithmetic goes through the `new Date(y, m, d, h, …)` constructor
 * rather than adding milliseconds, because that constructor works in local
 * wall-clock terms: "tomorrow at the same time" stays 14:00 across the night
 * the clocks move, which is what an operator scheduling a stream means.
 */

const pad = (n: number) => String(n).padStart(2, '0');

const SATURDAY = 6;

/** `YYYY-MM-DDTHH:mm`, the only shape the form state ever holds. */
const VALUE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** A `datetime-local` value → a local-time Date, or null when it is not one. */
export function parseDateTimeLocalValue(value: string): Date | null {
  const m = VALUE_RE.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The next full hour, local time: 14:23 → 15:00. On the morning the clocks
 * jump forward the 02:00 this asks for does not exist, and the Date
 * constructor lands on the instant that replaced it — which is still the next
 * real hour boundary, so the caller needs no special case.
 */
export function nextFullHour(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
}

/** What a fresh create form starts with. */
export function nextFullHourValue(now: Date): string {
  return toDateTimeLocalValue(nextFullHour(now));
}

/**
 * `in 40 minutes`, `in 6 days`, `2 hours ago`. Days are rounded from the
 * elapsed milliseconds, so a span crossing a DST change still reads as the
 * whole number of days an operator counted on a calendar — 143 hours and 145
 * hours are both "6 days".
 */
export function relativeLabel(target: Date, now: Date): string {
  const diff = target.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return 'now';

  let amount: number;
  let unit: string;
  if (minutes < 90) {
    amount = minutes;
    unit = 'minute';
  } else if (abs < 22 * 3_600_000) {
    // The handover to days is at 22 hours rather than 24 so that rounding can
    // never produce "in 24 hours", which nobody says.
    amount = Math.round(abs / 3_600_000);
    unit = 'hour';
  } else {
    amount = Math.round(abs / 86_400_000);
    unit = 'day';
  }

  const phrase = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  return diff < 0 ? `${phrase} ago` : `in ${phrase}`;
}

/**
 * The caption under every variant, or null when there is nothing to read. The
 * date half comes from `formatHumanDateTime`, the same function behind the
 * `DATE_TIME_FORMAT` the picker field renders, because two spellings of one
 * date a line apart look like two dates.
 */
export function describeSchedule(value: string, now: Date): string | null {
  const date = parseDateTimeLocalValue(value);
  if (!date) return null;
  return `${formatHumanDateTime(date)} · ${relativeLabel(date, now)}`;
}

export interface QuickPick {
  key: string;
  label: string;
  /** A `datetime-local` value, ready to hand straight to `onChange`. */
  value: string;
}

/**
 * The four one-click targets, with anything already in the past dropped —
 * "Tonight 20:00" is not an offer worth making at half past ten.
 */
export function quickPicks(now: Date): QuickPick[] {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  // ((6 - dow + 7) % 7) || 7: the coming Saturday, and a full week away when
  // today is already Saturday — "next Saturday" is never today.
  const toSaturday = (SATURDAY - now.getDay() + 7) % 7 || 7;

  const candidates: { key: string; label: string; date: Date }[] = [
    {
      key: 'hour',
      label: 'In 1 hour',
      date: new Date(y, m, d, now.getHours() + 1, now.getMinutes(), 0, 0),
    },
    { key: 'tonight', label: 'Tonight 20:00', date: new Date(y, m, d, 20, 0, 0, 0) },
    {
      key: 'tomorrow',
      label: 'Tomorrow same time',
      date: new Date(y, m, d + 1, now.getHours(), now.getMinutes(), 0, 0),
    },
    {
      key: 'saturday',
      label: 'Next Saturday 18:00',
      date: new Date(y, m, d + toSaturday, 18, 0, 0, 0),
    },
  ];

  return candidates
    .filter((c) => c.date.getTime() > now.getTime())
    .map(({ key, label, date }) => ({
      key,
      label,
      value: toDateTimeLocalValue(date),
    }));
}

export const SLOT_MINUTES = 15;

/** `00:00`, `00:15`, … `23:45` — the split variant's time menu. */
export function timeSlots(): string[] {
  const slots: string[] = [];
  for (let minute = 0; minute < 24 * 60; minute += SLOT_MINUTES) {
    slots.push(`${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`);
  }
  return slots;
}

/**
 * The menu for a field whose current time is off the grid — an edited stream
 * scheduled for 18:07, say. Dropping it would silently move the stream, so it
 * is offered in its place instead.
 */
export function slotOptions(current: string): string[] {
  const slots = timeSlots();
  if (!current || slots.includes(current)) return slots;
  return [...slots, current].sort();
}

/** Whether a slot on `dateValue` (`YYYY-MM-DD`) has already gone by. */
export function isSlotPast(dateValue: string, slot: string, now: Date): boolean {
  const date = parseDateTimeLocalValue(`${dateValue}T${slot}`);
  if (!date) return false;
  return date.getTime() < now.getTime();
}

/** The earliest slot still selectable on a date, or null when none is. */
export function firstFreeSlot(dateValue: string, now: Date): string | null {
  return timeSlots().find((slot) => !isSlotPast(dateValue, slot, now)) ?? null;
}

/**
 * `18:30`, `1830`, `9:05`, `1807`, `7` — what an operator types into the time
 * field instead of reaching for the menu. A bare hour means the hour itself,
 * and the grid is not enforced: an exact minute is a legitimate answer, so
 * `18:07` comes back as `18:07` rather than being rounded onto a slot.
 * Anything that is not a time of day is null, and the field keeps what it had.
 */
const TYPED_TIME_RE = /^(\d{1,2}):?(\d{2})?$/;

export function parseTypedTime(text: string): string | null {
  const m = TYPED_TIME_RE.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = m[2] === undefined ? 0 : Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

/** `2026-09-20T18:00` → `{ date: '2026-09-20', time: '18:00' }`. */
export function splitDateTimeLocal(value: string): { date: string; time: string } {
  const m = VALUE_RE.exec(value);
  if (!m) return { date: '', time: '' };
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

/** The inverse; either half missing means the field has no value yet. */
export function joinDateTimeLocal(date: string, time: string): string {
  if (!date || !time) return '';
  return `${date}T${time}`;
}

/** The MUI X boundary: the pickers speak dayjs, the form state does not. */
export function dateTimeLocalToDayjs(value: string): Dayjs | null {
  const date = parseDateTimeLocalValue(value);
  return date ? dayjs(date) : null;
}

export function dayjsToDateTimeLocal(value: Dayjs | null): string {
  if (!value || !value.isValid()) return '';
  return toDateTimeLocalValue(value.toDate());
}

/** The date-only siblings, for the calendar half of the split field. */
export function dateToDayjs(value: string): Dayjs | null {
  return dateTimeLocalToDayjs(`${value}T00:00`);
}

export function dayjsToDateValue(value: Dayjs | null): string {
  return splitDateTimeLocal(dayjsToDateTimeLocal(value)).date;
}

/** Today, as the date half of a value — the day a bare time means. */
export function todayValue(now: Date): string {
  return splitDateTimeLocal(toDateTimeLocalValue(now)).date;
}
