import { FeedEntry, FeedReader, FollowClock, MAX_PARALLEL_READS, SEGMENT_MS } from './feedReader';
import {
  Bracket,
  emptyBracket,
  finished,
  isPinned,
  narrowToNewest,
  NewestFound,
  readRound,
  readZoomRound,
  SearchTally,
  ZOOM_LEANING_LOW,
  zoomAround,
} from './searchRounds';

/**
 * The first round: slot 0 and then every power of four less one, up to 16,383. A feed of any length
 * up to that is bracketed within a factor of four, and a longer one gives its 16,383rd entry, whose
 * segment time places the head by the clock.
 */
export const FIRST_ROUND: readonly number[] = Array.from({ length: MAX_PARALLEL_READS }, (_, power) =>
  power === 0 ? 0 : 4 ** power - 1,
);

/** What a slot's lag behind its segment end is taken to be before anything has been measured. */
const ASSUMED_LAG_MS = 1_000;

/** How many of the guess round's eight reads go around the guess. */
const ZOOM_READS_IN_GUESS_ROUND = 5;

/** Two slots closer than this give too noisy a pace, since one coalesced playlist moves it a lot. */
const PACE_MIN_SPAN = 32;

/**
 * A pace slower than this between two slots means a pause lies between them, so it says nothing
 * about how fast the feed moves now.
 */
const SLOWEST_LIVE_PACE = 0.5 / SEGMENT_MS;

/**
 * Find a feed's newest slot by reading slots by index, never through Bee's own lookup.
 *
 * One round at powers of four brackets the feed. The highest slot found then says how far the head
 * can be: no more slots than segments have ended since its newest segment, by the viewer's clock. The
 * pace between the slots found, in slots per second of segment time, refines that into a guess, which
 * allows for playlists that coalesced, and a round read around the guess, with the bound itself,
 * usually lands on the head. Later rounds steer by the same estimate from the newest slot found until
 * a round shows it wrong, which a pause or a wrong clock does, and then cut evenly. Neither costs a
 * wrong answer: the search only ends on a slot read and the slot above it read missing.
 */
export async function findNewestFromScratch(
  reader: FeedReader,
  clock: FollowClock,
  tally: SearchTally = { rounds: 0, reads: 0 },
): Promise<NewestFound> {
  const bracket = emptyBracket();
  const hits: FeedEntry[] = [];
  const trackingReader: FeedReader = {
    read: async (index) => {
      const read = await reader.read(index);
      if (read.found) {
        hits.push(read.entry);
      }
      return read;
    },
  };
  const estimate = (known: Bracket) => byClock(known, hits, clock.now());

  await readRound(trackingReader, FIRST_ROUND, bracket, tally);
  if (bracket.newest === null || isPinned(bracket)) {
    if (bracket.newest === null) {
      bracket.firstMissing = 0;
    }
    return finished(bracket, tally);
  }

  const newest = bracket.newest;
  const bound = newest.index + Math.max(1, Math.ceil((clock.now() - newest.newestSegmentEndMs) / SEGMENT_MS));
  const guess = Math.min(bound, estimate(bracket)!);
  const below = bracket.firstMissing ?? Infinity;
  // Five reads around the guess. The rest reach up from the newest slot found by fourfold steps, so a
  // pause between it and the head, which sends the guess far too high, still leaves a tight bracket,
  // and the last is the bound, so a guess that fell short still leaves a miss above it.
  const wanted = zoomAround(guess, bracket, ZOOM_LEANING_LOW).slice(-ZOOM_READS_IN_GUESS_ROUND);
  for (const step of [256, 1_024, 4_096]) {
    const index = newest.index + step;
    if (wanted.length < MAX_PARALLEL_READS - 1 && index < Math.min(below, guess - 16)) {
      wanted.push(index);
    }
  }
  if (bound < below && bound > Math.max(newest.index, ...wanted)) {
    wanted.push(bound);
  }
  const outcome = await readZoomRound(trackingReader, wanted, bracket, tally);
  return narrowToNewest(trackingReader, bracket, tally, estimate, ZOOM_LEANING_LOW, outcome === 'straddled');
}

/**
 * The head as the viewer's clock places it from the newest slot found, at the pace the slots found so
 * far show. Exact within the current session, too high across a pause, and off by the viewer's clock
 * error, which is why a round that proves it wrong stops it steering.
 */
function byClock(bracket: Bracket, hits: readonly FeedEntry[], nowMs: number): number | null {
  const newest = bracket.newest;
  if (newest === null) {
    return null;
  }
  const older = [...hits]
    .filter((hit) => hit.index <= newest.index - PACE_MIN_SPAN)
    .sort((a, b) => b.index - a.index)
    .find((hit) => paceBetween(hit, newest) >= SLOWEST_LIVE_PACE);
  const pace = older === undefined ? 1 / SEGMENT_MS : Math.min(1 / SEGMENT_MS, paceBetween(older, newest));
  return newest.index + Math.round(pace * (nowMs - newest.newestSegmentEndMs - ASSUMED_LAG_MS));
}

function paceBetween(older: FeedEntry, newer: FeedEntry): number {
  const spanMs = newer.newestSegmentEndMs - older.newestSegmentEndMs;
  return spanMs <= 0 ? 0 : (newer.index - older.index) / spanMs;
}
