import { ErrorDetails, type ErrorData, PlaylistLevelType } from 'hls.js';

import { LIVE_GAP_LIMIT, LIVE_GAP_WINDOW_MS } from './playerConfig';

/**
 * A live segment hls.js could not load, turned into a gap so playback skips it, instead of a frozen
 * picture or a player restart.
 *
 * The playlist hls.js plays is the one this client serves it, so the gap is written there, as
 * `#EXT-X-GAP` above the segment, and every later reload of that level says the same. hls.js 1.7.3 skips
 * such an entry without fetching it: its fragment loader rejects a fragment whose tags include `GAP`
 * with a `fragGap` error (`src/loader/fragment-loader.ts`, `createGapLoadError`), which the stream
 * controller records as a buffered gap (`base-stream-controller.ts`, `onFragmentOrKeyLoadError`,
 * `addAsGap`), and the gap controller seeks over the hole it leaves.
 */

/** The failures a gap may stand in for: the segment's bytes never arrived, or arrived as no media. */
const GAP_ELIGIBLE: ReadonlySet<string> = new Set([
  ErrorDetails.FRAG_LOAD_ERROR,
  ErrorDetails.FRAG_LOAD_TIMEOUT,
  ErrorDetails.FRAG_PARSING_ERROR,
]);

/**
 * Counts the gaps made in a sliding window, so a stream that is not being served at all reaches the
 * player's ordinary recovery instead of being skipped through segment by segment.
 */
export class LiveGapBudget {
  private takenAtMs: number[] = [];

  constructor(
    private readonly limit: number = LIVE_GAP_LIMIT,
    private readonly windowMs: number = LIVE_GAP_WINDOW_MS,
  ) {}

  /** @param nowMs A monotonic clock reading, `performance.now()`, for the reason `mediaErrorRecovery.ts` gives. */
  hasRoom(nowMs: number): boolean {
    this.takenAtMs = this.takenAtMs.filter((atMs) => nowMs - atMs < this.windowMs);
    return this.takenAtMs.length < this.limit;
  }

  take(nowMs: number): void {
    this.takenAtMs.push(nowMs);
  }
}

/** Marks a failed segment as a gap in the playlist served for its level. Answers whether one was marked. */
type MarkLiveGap = (levelUri: string, fragmentUrl: string) => boolean;

/** The part of hls.js this uses, kept small so the decision can be tested without a browser. */
export interface GapPlayer {
  readonly levels: readonly { readonly uri: string }[];
  startLoad(startPosition?: number, skipSeekToStartPosition?: boolean): void;
}

/**
 * Turns a live segment hls.js has given up on into a gap, when the budget allows it.
 *
 * "Given up on" is read from what hls.js has already done by the time the player's own listener runs,
 * since its error controller and stream controller subscribed first. A fatal error is the case that
 * used to end in a restart: hls.js has stopped loading, so the fragment it holds is marked a gap the
 * way a `GAP` tag would have marked it, and loading is started again from the playhead. A non-fatal
 * error on a fragment hls.js has set `gap` on is one it skipped by itself: after its retries with no
 * other level left to try, or at once for a fragment it found no media in (`base-stream-controller.ts`,
 * `treatAsGap`, called from `onFragmentOrKeyLoadError` and from `updateLevelTiming`). That skip is not
 * remembered across a reload, so it is written into the playlist too. Any other non-fatal error is still being
 * retried, or hls.js is moving to another level, and is left alone.
 *
 * @param playheadS Where the video is, read by the caller before anything here runs.
 * @returns Whether the failure became a gap, in which case the caller's own recovery must not run.
 */
export function skipFailedLiveSegment(
  hls: GapPlayer,
  data: ErrorData,
  markGap: MarkLiveGap,
  budget: LiveGapBudget,
  nowMs: number,
  playheadS: number,
): boolean {
  const frag = data.frag;
  if (!GAP_ELIGIBLE.has(data.details) || !frag || frag.type !== PlaylistLevelType.MAIN || frag.sn === 'initSegment') {
    return false;
  }
  if (!data.fatal && !frag.gap) {
    return false;
  }
  const levelUri = hls.levels[frag.level]?.uri;
  if (!levelUri || !budget.hasRoom(nowMs) || !markGap(levelUri, frag.url)) {
    return false;
  }
  budget.take(nowMs);

  if (data.fatal) {
    // The fragment is the one in the playlist hls.js already holds, so it is told directly. The reload
    // that follows builds fresh fragments from the served playlist, which carries the tag itself.
    frag.gap = true;
    frag.tagList.push(['GAP']);
    // From the playhead without seeking to it, so the video keeps the position it was playing.
    if (playheadS > 0) {
      hls.startLoad(playheadS, true);
    } else {
      hls.startLoad();
    }
  }
  console.warn(`[SwarmHls] live segment ${frag.sn} could not be loaded, playing past it as a gap`);
  return true;
}
