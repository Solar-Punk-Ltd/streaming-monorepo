import type { UnmarkedStampHolder, UnmarkedStampLevel } from '@streaming-monorepo/web2-admin-common';

/** One row of `stamp_watch_notices`, migration 037: an unmarked stamp that is running low. */
export interface UnmarkedStampRow {
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  nodeId: string;
  holder: UnmarkedStampHolder;
  level: UnmarkedStampLevel;
  /** When it was first read under "Top up when under". */
  since: Date;
  /** When it reached its level. */
  levelSince: Date;
  /** What the tab and the notices say of it, as the last run worded it. */
  message: string;
  /** The level the last notice that told of it named, or null while none did. */
  notifiedLevel: UnmarkedStampLevel | null;
  /** When a notice last told of it, the daily one included, or null. */
  notifiedAt: Date | null;
}

/** What one run read of a low unmarked stamp. */
export interface UnmarkedStampReading {
  batchId: string;
  nodeId: string;
  holder: UnmarkedStampHolder;
  level: UnmarkedStampLevel;
  message: string;
}

/** What names an unmarked stamp's subject in a notice (`NoticePart`). It stands while the stamp has its row. */
export function unmarkedStampSubject(batchId: string): string {
  return `auto-top-up/unmarked/${batchId}`;
}

/**
 * Where the alert job keeps the unmarked stamps that are running low: Postgres, migration 037, or memory in the unit
 * tests (docs/architecture/funding.md, "Stamps not on auto top-up"). The alert job writes it each tick, and the Auto
 * top-up tab's list reads it. It holds no mark, no alert and no warning: nothing here is topped up, moves money or
 * fails a job.
 */
export interface UnmarkedStampStore {
  /** Every row, the earliest `since` first. */
  rows(): Promise<UnmarkedStampRow[]>;
  /**
   * Writes what a run read of a stamp. A stamp with no row gets one, its `since` and `levelSince` at `at`. One with a
   * row keeps its `since` and what it was notified of, takes the new message, and moves `levelSince` to `at` when its
   * level changed.
   */
  record(reading: UnmarkedStampReading, at: Date): Promise<void>;
  /** Removes the rows of these stamps: topped up, marked, or gone. */
  remove(batchIds: readonly string[]): Promise<void>;
  /** A notice that told of these stamps was taken: sets each one's `notifiedLevel` to the level named, and `notifiedAt`. */
  setNotified(stamps: readonly { batchId: string; level: UnmarkedStampLevel }[], at: Date): Promise<void>;
}
