import { describe, expect, it } from 'vitest';

import {
  dateTimeLocalToDayjs,
  dayjsToDateTimeLocal,
  describeSchedule,
  firstFreeSlot,
  isSlotPast,
  joinDateTimeLocal,
  nextFullHour,
  nextFullHourValue,
  dateToDayjs,
  dayjsToDateValue,
  parseDateTimeLocalValue,
  parseTypedTime,
  quickPicks,
  relativeLabel,
  slotOptions,
  splitDateTimeLocal,
  timeSlots,
} from '../components/schedule/scheduleTime';

/**
 * Every case hands in a fixed `now`, which is the whole point of the module:
 * nothing here reads the clock, so the answers are the same on every machine
 * and the awkward days can be tested at all.
 */

/** Monday 14 September 2026, 14:23:45 local. */
const MONDAY = new Date(2026, 8, 14, 14, 23, 45, 0);

describe('nextFullHour', () => {
  it('rounds up to the coming hour', () => {
    expect(nextFullHourValue(MONDAY)).toBe('2026-09-14T15:00');
  });

  it('moves to the next day at the end of one', () => {
    expect(nextFullHourValue(new Date(2026, 8, 14, 23, 5))).toBe('2026-09-15T00:00');
  });

  it('crosses a year boundary', () => {
    expect(nextFullHourValue(new Date(2026, 11, 31, 23, 59))).toBe('2027-01-01T00:00');
  });

  it('lands on a real instant for every hour of a clock-change day', () => {
    // 29 March 2026 is the European spring-forward date and 25 October the
    // autumn one; in a zone that observes either, one local hour does not
    // exist and another happens twice. Whatever the machine's zone, the
    // result must stay a real instant that is strictly later than `now`, is
    // on the hour, and survives the round trip through the string the form
    // holds — no NaN, no silent hour lost.
    for (const day of [
      [2026, 2, 29],
      [2026, 9, 25],
    ] as const) {
      for (let hour = 0; hour < 24; hour += 1) {
        const now = new Date(day[0], day[1], day[2], hour, 30);
        const next = nextFullHour(now);

        expect(Number.isNaN(next.getTime())).toBe(false);
        expect(next.getTime()).toBeGreaterThan(now.getTime());
        expect(next.getMinutes()).toBe(0);
        expect(next.getSeconds()).toBe(0);
        expect(parseDateTimeLocalValue(nextFullHourValue(now))?.getTime()).toBe(next.getTime());
      }
    }
  });
});

describe('quickPicks', () => {
  it('offers the four targets while they are all ahead', () => {
    const picks = quickPicks(MONDAY);

    expect(picks.map((p) => p.label)).toEqual([
      'In 1 hour',
      'Tonight 20:00',
      'Tomorrow same time',
      'Next Saturday 18:00',
    ]);
    expect(picks.map((p) => p.value)).toEqual([
      '2026-09-14T15:23',
      '2026-09-14T20:00',
      '2026-09-15T14:23',
      '2026-09-19T18:00',
    ]);
  });

  it('drops tonight once the evening has gone', () => {
    const picks = quickPicks(new Date(2026, 8, 14, 22, 30));

    expect(picks.map((p) => p.key)).toEqual(['hour', 'tomorrow', 'saturday']);
  });

  it('reads "next Saturday" as a week away when today is Saturday', () => {
    // Saturday 19 September 2026 at 09:00: the offer is the 26th, not today.
    const picks = quickPicks(new Date(2026, 8, 19, 9, 0));

    expect(picks.find((p) => p.key === 'saturday')?.value).toBe('2026-09-26T18:00');
  });

  it('keeps the wall-clock hour when tomorrow crosses a clock change', () => {
    // The operator means "this time tomorrow", not "24 hours from now".
    const eve = new Date(2026, 2, 28, 14, 0);
    const tomorrow = quickPicks(eve).find((p) => p.key === 'tomorrow');

    expect(tomorrow?.value).toBe('2026-03-29T14:00');
  });
});

describe('relativeLabel and describeSchedule', () => {
  it('reads in minutes, hours and days', () => {
    expect(relativeLabel(new Date(2026, 8, 14, 14, 24), MONDAY)).toBe('now');
    expect(relativeLabel(new Date(2026, 8, 14, 15, 0), MONDAY)).toBe('in 36 minutes');
    expect(relativeLabel(new Date(2026, 8, 14, 18, 23), MONDAY)).toBe('in 4 hours');
    expect(relativeLabel(new Date(2026, 8, 20, 18, 0), MONDAY)).toBe('in 6 days');
  });

  it('says so when the time has gone', () => {
    expect(relativeLabel(new Date(2026, 8, 13, 14, 23), MONDAY)).toBe('1 day ago');
  });

  it('counts whole days across a clock change', () => {
    // 28 March to 3 April is six calendar days and 143 or 145 hours,
    // depending on the zone; it reads as six either way.
    expect(relativeLabel(new Date(2026, 3, 3, 14, 0), new Date(2026, 2, 28, 14, 0))).toBe('in 6 days');
  });

  it('spells the whole value out for the caption', () => {
    expect(describeSchedule('2026-09-20T18:00', MONDAY)).toBe('20/09/2026 18:00 · in 6 days');
  });

  it('has nothing to say about an empty field', () => {
    expect(describeSchedule('', MONDAY)).toBeNull();
    expect(describeSchedule('not a time', MONDAY)).toBeNull();
  });
});

describe('time slots', () => {
  it('covers the day in quarters', () => {
    const slots = timeSlots();

    expect(slots).toHaveLength(96);
    expect(slots[0]).toBe('00:00');
    expect(slots[1]).toBe('00:15');
    expect(slots.at(-1)).toBe('23:45');
  });

  it('keeps an off-grid time rather than moving the stream', () => {
    const options = slotOptions('18:07');

    expect(options).toHaveLength(97);
    expect(options.indexOf('18:07')).toBe(options.indexOf('18:00') + 1);
  });

  it('marks the slots today has already used up', () => {
    expect(isSlotPast('2026-09-14', '14:15', MONDAY)).toBe(true);
    expect(isSlotPast('2026-09-14', '14:30', MONDAY)).toBe(false);
    expect(isSlotPast('2026-09-15', '00:00', MONDAY)).toBe(false);
  });

  it('finds the first slot still free', () => {
    expect(firstFreeSlot('2026-09-14', MONDAY)).toBe('14:30');
    expect(firstFreeSlot('2026-09-15', MONDAY)).toBe('00:00');
    expect(firstFreeSlot('2026-09-13', MONDAY)).toBeNull();
  });
});

describe('value plumbing', () => {
  it('splits and rejoins a value', () => {
    expect(splitDateTimeLocal('2026-09-20T18:00')).toEqual({
      date: '2026-09-20',
      time: '18:00',
    });
    expect(splitDateTimeLocal('')).toEqual({ date: '', time: '' });
    expect(joinDateTimeLocal('2026-09-20', '18:00')).toBe('2026-09-20T18:00');
    expect(joinDateTimeLocal('2026-09-20', '')).toBe('');
    expect(joinDateTimeLocal('', '18:00')).toBe('');
  });

  it('round-trips through dayjs without drifting', () => {
    const value = '2026-09-20T18:00';

    expect(dayjsToDateTimeLocal(dateTimeLocalToDayjs(value))).toBe(value);
    expect(dateTimeLocalToDayjs('')).toBeNull();
    expect(dayjsToDateTimeLocal(null)).toBe('');
  });
});

describe('parseTypedTime', () => {
  it('reads the shapes an operator types', () => {
    expect(parseTypedTime('18:30')).toBe('18:30');
    expect(parseTypedTime('1830')).toBe('18:30');
    expect(parseTypedTime('9:05')).toBe('09:05');
    expect(parseTypedTime('905')).toBe('09:05');
    expect(parseTypedTime('1807')).toBe('18:07');
    // A bare hour is that hour, not a prefix of something longer.
    expect(parseTypedTime('7')).toBe('07:00');
    expect(parseTypedTime('07')).toBe('07:00');
    expect(parseTypedTime(' 18:30 ')).toBe('18:30');
  });

  it('refuses anything that is not a time of day', () => {
    // 24:00 is midnight spelled as a duration; the field holds clock times.
    expect(parseTypedTime('24:00')).toBeNull();
    expect(parseTypedTime('18:60')).toBeNull();
    expect(parseTypedTime('')).toBeNull();
    expect(parseTypedTime('half six')).toBeNull();
    expect(parseTypedTime('123456')).toBeNull();
    expect(parseTypedTime('18:3')).toBeNull();
  });
});

describe('date-only plumbing', () => {
  it('round-trips the calendar half', () => {
    expect(dayjsToDateValue(dateToDayjs('2026-09-20'))).toBe('2026-09-20');
    expect(dateToDayjs('')).toBeNull();
    expect(dayjsToDateValue(null)).toBe('');
  });
});
