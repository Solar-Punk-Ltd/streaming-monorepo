import type { StampReadingAge } from '@streaming-monorepo/web2-admin-common';

/** A batch reading as the manager took it: the time to live its node said, and when. */
export interface TimedReading {
  ttlSeconds: number | null;
  observedAt: string;
}

/**
 * Whether a batch has run out by the time to live the manager last read for it: `observedAt` plus `ttlSeconds` is
 * before `now`, whatever `state` says. Only for a positive time to live; Bee reports a negative one when it cannot
 * tell. This compares the manager's moment with the admin's clock, which nothing else here does: a time to live is
 * measured in hours and days, so two hosts' clocks a few seconds apart cannot change the answer. It matters most for
 * a pinned batch the manager no longer reports, whose last reading only ages: a manager that is down, one older than
 * the `previous` of a catalogue stamp record, or a move the manager has released.
 */
export function expiredByClock(reading: TimedReading, now: number): boolean {
  if (reading.ttlSeconds === null || !(reading.ttlSeconds > 0)) return false;
  const observed = Date.parse(reading.observedAt);
  return Number.isFinite(observed) && observed + reading.ttlSeconds * 1000 < now;
}

/**
 * A reading aged to `now`, as the console is shown it: the time to live less the whole seconds since the manager
 * read it, never below 0 and never above what the node said, and `expiredByClock` by the rule above, which is the
 * one the catalogue's refusal goes by. A time to live the node did not give, or gave as negative, has no time left
 * to age. Every presenter of a batch reading answers this, so what the console shows cannot drift from what the
 * admin refuses.
 */
export function stampAge(reading: TimedReading, now: number): StampReadingAge {
  const { ttlSeconds } = reading;
  if (ttlSeconds === null || !(ttlSeconds >= 0)) return { remainingSeconds: null, expiredByClock: false };
  const observed = Date.parse(reading.observedAt);
  const ageSeconds = Number.isFinite(observed) ? Math.max(0, Math.floor((now - observed) / 1000)) : 0;
  return { remainingSeconds: Math.max(0, ttlSeconds - ageSeconds), expiredByClock: expiredByClock(reading, now) };
}
