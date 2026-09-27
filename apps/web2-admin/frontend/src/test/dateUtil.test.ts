/**
 * The one spelling of a date the console uses. These are the cases that go
 * wrong when a formatter is hand-rolled: a single-digit day or month read as
 * `1/9/2026`, midnight read as `24:00` or dropped, and a round trip through a
 * `datetime-local` value that quietly moves the instant by a zone offset.
 */
import { describe, expect, it } from 'vitest';

import {
  DATE_TIME_FORMAT,
  dateTimeLocalValueToIso,
  formatDateTime,
  formatHumanDateTime,
  isoToDateTimeLocalValue,
  toDateTimeLocalValue,
} from '../dateUtil';

describe('formatHumanDateTime', () => {
  it('pads a single-digit day, month, hour and minute', () => {
    expect(formatHumanDateTime(new Date(2026, 0, 5, 9, 7))).toBe(
      '05/01/2026 09:07',
    );
  });

  it('writes midnight as 00:00 rather than 24:00 or 12 AM', () => {
    expect(formatHumanDateTime(new Date(2026, 8, 20, 0, 0))).toBe(
      '20/09/2026 00:00',
    );
  });

  it('keeps the 24-hour clock in the afternoon', () => {
    expect(formatHumanDateTime(new Date(2026, 11, 31, 23, 59))).toBe(
      '31/12/2026 23:59',
    );
  });

  it('spells the same shape the picker is told to render', () => {
    expect(DATE_TIME_FORMAT).toBe('DD/MM/YYYY HH:mm');
  });
});

describe('formatDateTime', () => {
  it('renders an ISO timestamp in local time', () => {
    // Built from local parts, so the assertion holds in any zone.
    const iso = new Date(2026, 8, 20, 18, 0).toISOString();
    expect(formatDateTime(iso)).toBe('20/09/2026 18:00');
  });

  it('answers an em dash when there is no value', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
  });

  it('shows a value it cannot read rather than hiding it', () => {
    expect(formatDateTime('next tuesday')).toBe('next tuesday');
  });
});

describe('datetime-local conversion', () => {
  it('round trips an instant through the input value and back', () => {
    const date = new Date(2026, 8, 20, 18, 5);
    const value = toDateTimeLocalValue(date);

    expect(value).toBe('2026-09-20T18:05');

    const iso = dateTimeLocalValueToIso(value);
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getTime()).toBe(date.getTime());
    expect(isoToDateTimeLocalValue(iso)).toBe(value);
  });

  it('has nothing to convert when the field is empty or unreadable', () => {
    expect(dateTimeLocalValueToIso('')).toBeNull();
    expect(dateTimeLocalValueToIso('not a time')).toBeNull();
    expect(isoToDateTimeLocalValue(null)).toBe('');
    expect(isoToDateTimeLocalValue('not a time')).toBe('');
  });
});
