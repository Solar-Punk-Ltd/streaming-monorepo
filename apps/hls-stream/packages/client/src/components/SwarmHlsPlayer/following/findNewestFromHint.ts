import { FeedReader, FollowClock, MAX_PARALLEL_READS } from './feedReader';
import { findNewestFromScratch } from './findNewestFromScratch';
import {
  Bracket,
  emptyBracket,
  finished,
  isPinned,
  narrowToNewest,
  NewestFound,
  newestIndexOf,
  readRound,
  roundAround,
  SearchTally,
  zoomAround,
} from './searchRounds';

/** What the quality already playing says about where the one being switched to is. */
export interface SwitchHint {
  /** The playing quality's newest index. */
  readonly index: number;
  /** Its newest segment end, on the publisher's clock. */
  readonly newestSegmentEndMs: number;
  /**
   * How long its segments last, from its playlist or its time marker, or null for a hint that came
   * without one, as a version 1 marker does.
   */
  readonly segmentMs: number | null;
  /** When the viewer read it, on the viewer's clock. */
  readonly seenAtMs: number;
}

interface NewestFoundFromHint extends NewestFound {
  readonly usedFallback: boolean;
}

/**
 * Find the newest slot of the quality being switched to, starting from the playing quality's head.
 *
 * The qualities drift apart, so the hint is a place to look rather than an answer. One round of eight
 * around it, moved on by however many segments have passed since it was read, pins the head whenever
 * the two are within a few slots. When the round finds slots but not the head, the highest one's
 * segment end, compared with the hint's on the same publisher clock, says how far ahead the head is,
 * and a round there usually pins it. Nothing here reads the viewer's clock against the publisher's,
 * so a viewer whose clock is wrong pays nothing. When every read around the hint misses, this quality
 * is behind, and one round reaching down from the hint by doubling steps finds it within 131 slots.
 * Only when that misses too does the search from nothing take over.
 */
export async function findNewestFromHint(
  reader: FeedReader,
  clock: FollowClock,
  hint: SwitchHint,
): Promise<NewestFoundFromHint> {
  const tally: SearchTally = { rounds: 0, reads: 0 };
  const bracket = emptyBracket();
  const elapsedMs = Math.max(0, clock.now() - hint.seenAtMs);
  // A hint that names no length is searched from where it stood, and the first slot read supplies it.
  const centre = hint.index + (hint.segmentMs === null ? 0 : Math.floor(elapsedMs / hint.segmentMs));
  // Where the head is by the publisher's clock: as many slots past the newest one found as the hint's
  // newest segment, moved on by the time since it was read, is segments past that slot's.
  const byHint = (known: Bracket): number | null =>
    known.newest === null
      ? null
      : known.newest.index +
        Math.round((hint.newestSegmentEndMs + elapsedMs - known.newest.newestSegmentEndMs) / known.newest.segmentMs);

  await readRound(reader, roundAround(centre, bracket, 3), bracket, tally);
  if (bracket.newest === null) {
    // Behind the hint by more than the round could see: one round down from it, doubling the step.
    const below = centre - 3;
    await readRound(
      reader,
      Array.from({ length: MAX_PARALLEL_READS }, (_, power) => below - 2 ** power),
      bracket,
      tally,
    );
    if (bracket.newest === null) {
      const fallback = await findNewestFromScratch(reader, clock, tally);
      return { ...fallback, usedFallback: true };
    }
  }
  if (isPinned(bracket)) {
    return { ...finished(bracket, tally), usedFallback: false };
  }

  const guess = byHint(bracket)!;
  await readRound(reader, zoomAround(Math.max(guess, newestIndexOf(bracket) + 1), bracket), bracket, tally);
  return { ...(await narrowToNewest(reader, bracket, tally, byHint)), usedFallback: false };
}
