import { FeedEntry, FeedReader, MAX_PARALLEL_READS } from './feedReader';

/**
 * What a search knows so far: the newest slot it has read, and the lowest slot above that it read
 * and found missing. The search is over once the two touch.
 */
export interface Bracket {
  newest: FeedEntry | null;
  firstMissing: number | null;
}

export interface SearchTally {
  rounds: number;
  reads: number;
}

/** A finished search. `firstMissing` is always `newest.index + 1`, or 0 for a feed with nothing in it. */
export interface NewestFound {
  readonly newest: FeedEntry | null;
  readonly firstMissing: number;
  readonly rounds: number;
  readonly reads: number;
}

export function emptyBracket(): Bracket {
  return { newest: null, firstMissing: null };
}

export function newestIndexOf(bracket: Bracket): number {
  return bracket.newest?.index ?? -1;
}

export function isPinned(bracket: Bracket): boolean {
  return bracket.firstMissing === newestIndexOf(bracket) + 1;
}

/**
 * Read up to eight slots at once and fold the answers into the bracket.
 *
 * A miss below the newest hit is a hole, not the head, so it never becomes the upper end: a slot the
 * node refuses for a while must not stop the search short of the publisher.
 */
export async function readRound(
  reader: FeedReader,
  wanted: readonly number[],
  bracket: Bracket,
  tally: SearchTally,
): Promise<void> {
  const indexes = [...new Set(wanted.filter((index) => index >= 0))].slice(0, MAX_PARALLEL_READS);
  if (indexes.length === 0) {
    return;
  }
  tally.rounds += 1;
  tally.reads += indexes.length;
  const reads = await Promise.all(indexes.map((index) => reader.read(index)));

  const misses: number[] = bracket.firstMissing === null ? [] : [bracket.firstMissing];
  reads.forEach((read, position) => {
    if (read.found) {
      if (bracket.newest === null || read.entry.index > bracket.newest.index) {
        bracket.newest = read.entry;
      }
    } else {
      misses.push(indexes[position]);
    }
  });
  const above = misses.filter((index) => index > newestIndexOf(bracket));
  bracket.firstMissing = above.length === 0 ? null : Math.min(...above);
}

/** Where the head probably is, given what the search knows, or null when there is nothing to go on. */
export type HeadEstimate = (bracket: Bracket) => number | null;

/**
 * Where a round reads around an estimate: dense near it, wider further out, so an estimate off by a
 * dozen slots still leaves a gap of a few for the next round.
 */
export const ZOOM_CENTRED: readonly number[] = [-12, -6, -3, -1, 0, 1, 3, 6];

/**
 * The same leaning low, for an estimate projected over many slots, which runs high: coalesced
 * playlists make fewer slots than segments.
 */
export const ZOOM_LEANING_LOW: readonly number[] = [-16, -9, -5, -3, -1, 0, 1, 3];

/** An estimate this far above the lowest slot known missing is not a near miss but a wrong estimate. */
const NEAR_MISS = 32;

/**
 * The reads of a round around `guess`, kept inside what the bracket still allows. A guess just above
 * the lowest slot known missing is moved under it, since the head is then most likely just below.
 */
export function zoomAround(guess: number, bracket: Bracket, offsets: readonly number[] = ZOOM_CENTRED): number[] {
  const low = newestIndexOf(bracket);
  const high = bracket.firstMissing ?? Infinity;
  if (guess - low <= MAX_PARALLEL_READS) {
    // Close above the newest slot found, the eight slots after it are the best round there is.
    return Array.from({ length: MAX_PARALLEL_READS }, (_, offset) => low + 1 + offset).filter((index) => index < high);
  }
  const top = Math.max(...offsets);
  const centre = guess + top >= high && guess - high < NEAR_MISS ? high - 1 - top : guess;
  return offsets.map((offset) => centre + offset).filter((index) => index > low && index < high);
}

/**
 * Close the bracket. With no miss known yet the search gallops, eight reads spaced by powers of two
 * and wider each round. With both ends known it cuts the gap evenly and reads the cuts, which takes a
 * gap of 60,000 to a single slot in five rounds. When an estimate is given and the gap is wide, the
 * round reads around the estimate instead, which pins the head in one or two rounds when the estimate
 * is good.
 */
export async function narrowToNewest(
  reader: FeedReader,
  bracket: Bracket,
  tally: SearchTally,
  estimate: HeadEstimate = () => null,
  offsets: readonly number[] = ZOOM_CENTRED,
  trusted = true,
): Promise<NewestFound> {
  let scale = 1;
  while (!isPinned(bracket)) {
    const low = newestIndexOf(bracket);
    let wanted: number[];
    let zoomed = false;
    if (bracket.firstMissing === null) {
      wanted = Array.from({ length: MAX_PARALLEL_READS }, (_, power) => low + scale * 2 ** power);
      scale *= 2 ** MAX_PARALLEL_READS;
    } else {
      const gap = bracket.firstMissing - low - 1;
      const guess = trusted ? estimate(bracket) : null;
      if (gap <= MAX_PARALLEL_READS) {
        wanted = Array.from({ length: gap }, (_, offset) => low + 1 + offset);
      } else if (guess !== null && zoomAround(guess, bracket, offsets).length >= MAX_PARALLEL_READS / 2) {
        wanted = zoomAround(guess, bracket, offsets);
        zoomed = true;
      } else {
        wanted = cuts(low, bracket.firstMissing, MAX_PARALLEL_READS);
      }
    }
    const outcome = await readZoomRound(reader, wanted, bracket, tally);
    // An estimate whose reads all landed on one side of the head was wrong by more than they span,
    // most often because a pause lies between the newest slot found and the head. The rest of the
    // search cuts evenly.
    if (zoomed) {
      trusted = outcome === 'straddled';
    }
  }
  return finished(bracket, tally);
}

/**
 * Read a round and say whether the head fell among its reads or all of them landed on one side,
 * which is how a search tells a good estimate from a wrong one.
 */
export async function readZoomRound(
  reader: FeedReader,
  wanted: readonly number[],
  bracket: Bracket,
  tally: SearchTally,
): Promise<'straddled' | 'allFound' | 'allMissed'> {
  const before = newestIndexOf(bracket);
  const missingBefore = bracket.firstMissing;
  await readRound(reader, wanted, bracket, tally);
  if (newestIndexOf(bracket) === before) {
    return 'allMissed';
  }
  return bracket.firstMissing === missingBefore ? 'allFound' : 'straddled';
}

/** `count` slots cutting the open gap between `low` and `high` into equal parts. */
function cuts(low: number, high: number, count: number): number[] {
  const gap = high - low - 1;
  return Array.from({ length: count }, (_, cut) => Math.round(low + ((cut + 1) * (gap + 1)) / (count + 1)));
}

export function finished(bracket: Bracket, tally: SearchTally): NewestFound {
  return {
    newest: bracket.newest,
    firstMissing: newestIndexOf(bracket) + 1,
    rounds: tally.rounds,
    reads: tally.reads,
  };
}

/** Eight consecutive slots ending one past `guess`, kept inside what the bracket still allows. */
export function roundAround(guess: number, bracket: Bracket, before = 5): number[] {
  const low = newestIndexOf(bracket);
  const high = bracket.firstMissing ?? Infinity;
  return Array.from({ length: MAX_PARALLEL_READS }, (_, offset) => guess - before + offset).filter(
    (index) => index > low && index < high,
  );
}
