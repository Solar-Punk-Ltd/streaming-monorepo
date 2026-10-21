import type { HlsConfig } from 'hls.js';

const MB = 1024 * 1024;

/**
 * How far behind the live edge playback aims to sit, in seconds.
 *
 * Every segment here is fetched from Swarm rather than from an origin next to the viewer, so the
 * budget covers a feed lookup plus a chunk download, not one HTTP round trip. It is the largest
 * client-side latency lever there is.
 *
 * Behind-live is not the total plus this buffer. The total is anchored on a segment's first frame
 * and the buffer is measured back from the live edge, which is that same segment's last, so adding
 * them counts one segment twice.
 *
 * ## What the number has to cover
 *
 * A player stalls unless its buffer covers the largest edge-to-fetchable delay, which is
 * `totalMs - segmentMs` per segment, plus the cadence it asks at, since a segment becomes fetchable
 * before the player has asked for it. hls.js reloads a live playlist once per target duration.
 *
 * ## Why twelve
 *
 * Six was derived from arrivals at 0.25 s and 0.5 s segments on a gateway beside the stage. The event
 * runs 2 s segments, and on a development gateway a 2 s segment became fetchable 7 to 9 s after it
 * was filmed, past six. Over SRT the player stalled about 30 times per 15 minutes at six and about 9
 * times at fourteen, on the same broadcast and gateway. Twelve sits in the 10 to 14 s range asked
 * for, and with live held at normal speed (see {@link LIVE_SYNC_PLAYBACK_RATE}) the margin over the
 * arrival delay is what absorbs a slow fetch.
 *
 * **Twelve is the floor, not the whole target.** Longer segments are covered by the three-segment
 * rule in {@link liveLatencyFor}, which raises the target to three segments of the length the
 * playlist names whenever that is more than twelve seconds. The engine's playlist window does not
 * grow with it: SRS keeps a fixed `HLS_WINDOW`, 15 s by default, so from segments of 5 s the target
 * sits on the window's oldest fragment (see `DEFAULT_HLS_TUNING` in `SwarmHlsPlayer.tsx`).
 *
 * ## The uploader has to name enough media for this to be reachable
 *
 * hls.js clamps its sync position to the start of the playlist, so a first manifest holding less
 * media than this asks for puts a joining viewer at the live edge with less runway than this says.
 * The uploader's window is budgeted against one chunk rather than counted in segments. A segment
 * line is a duration and a bare Swarm reference, so measured against the shipped builder it holds
 * 12.5 s at a 0.25 s segment and 25.5 s at a 0.5 s segment. `ManifestManager.test.ts` reads this
 * constant out of this file and fails if the window stops covering it.
 */
export const LIVE_SYNC_DURATION_S = 12;

/**
 * Segments behind the live edge the player aims at when that is more than {@link LIVE_SYNC_DURATION_S}.
 * Three segments only pass the twelve second floor at segments longer than 4 s. A quality's progress
 * bound in `rungPosition.ts` is the same three segments over a floor of its own.
 */
export const LIVE_SYNC_SEGMENTS = 3;

/** How many times the live target the jump limit sits at, for the reason {@link LIVE_MAX_LATENCY_DURATION_S} gives. */
const JUMP_LIMIT_FACTOR = 2;

/** Whether a segment length is one a target can be computed from: a positive, finite number of milliseconds. */
export function isKnownSegmentMs(segmentMs: number | null | undefined): segmentMs is number {
  return segmentMs != null && Number.isFinite(segmentMs) && segmentMs > 0;
}

/**
 * The latency at which hls.js jumps a viewer who has fallen behind forward to the live target.
 *
 * hls.js refuses a value at or below {@link LIVE_SYNC_DURATION_S}, throwing from the constructor, so
 * every mount of the player depends on the two staying ordered. With playback held at normal speed
 * (see {@link LIVE_SYNC_PLAYBACK_RATE}) nothing pulls a viewer back gradually, so every stall adds to
 * how far behind they sit until this is crossed and the jump skips them forward. At twice the target
 * a viewer can lose as many seconds to stalls as the target itself before anything is skipped.
 *
 * This constant is the floor's pair, the limit that goes with {@link LIVE_SYNC_DURATION_S}. The pair a
 * live player runs with is computed from the segment length by {@link liveLatencyFor}, on the same
 * twice-the-target rule.
 */
export const LIVE_MAX_LATENCY_DURATION_S = JUMP_LIMIT_FACTOR * LIVE_SYNC_DURATION_S;

/** The live target and jump limit hls.js works with. */
interface LiveLatency {
  liveSyncDuration: number;
  liveMaxLatencyDuration: number;
}

/**
 * The live target for a stage cutting segments of `segmentMs`: three segments behind the live edge,
 * never under {@link LIVE_SYNC_DURATION_S}, and the jump limit twice that, for the reason
 * {@link LIVE_MAX_LATENCY_DURATION_S} gives. A length not known yet answers the floor.
 */
export function liveLatencyFor(segmentMs: number | null | undefined): LiveLatency {
  const liveSyncDuration = isKnownSegmentMs(segmentMs)
    ? Math.max(LIVE_SYNC_DURATION_S, (LIVE_SYNC_SEGMENTS * segmentMs) / 1000)
    : LIVE_SYNC_DURATION_S;
  return { liveSyncDuration, liveMaxLatencyDuration: JUMP_LIMIT_FACTOR * liveSyncDuration };
}

/**
 * The playback rate a live viewer is held at: normal speed, always.
 *
 * hls.js reads exactly 1 as "never adapt" and then leaves the playback rate alone entirely, so a
 * viewer who falls behind the target is never played fast to catch up. A stall leaves the viewer
 * that much further behind, inside the room {@link LIVE_SYNC_DURATION_S} gives, and only past
 * {@link LIVE_MAX_LATENCY_DURATION_S} does hls.js jump them forward to the target.
 *
 * Since hls.js never writes the rate, a speed the viewer picks from the native controls stays theirs
 * without any guard.
 */
export const LIVE_SYNC_PLAYBACK_RATE = 1;

/**
 * How many of a live playlist's newest segments, gaps not counted, a failed load may turn into a gap.
 *
 * At the live edge a segment the gateway cannot hand over yet is a hole the viewer is about to meet,
 * and skipping it costs one segment of picture. Further back the segment is history the viewer has
 * already played past or chose to rewind to, and is left to hls.js as it always was.
 */
export const LIVE_GAP_NEWEST_SEGMENTS = 3;

/**
 * At most this many segments are turned into gaps inside {@link LIVE_GAP_WINDOW_MS}. A stream losing
 * more than that is not missing a segment, it is not being served, and the player's ordinary recovery,
 * which ends in a restart, is the better answer to that.
 */
export const LIVE_GAP_LIMIT = 4;

/** The sliding window {@link LIVE_GAP_LIMIT} is counted over. */
export const LIVE_GAP_WINDOW_MS = 5 * 60_000;

/**
 * Everything the player tells hls.js that is not a loader.
 *
 * Separate from the component because a wrong number here is invisible in every way except how the
 * stream feels: nothing throws, nothing logs, playback just sits further behind or rebuffers more.
 * Out here it can be asserted, and compared against the library's own defaults, without a DOM.
 */
export const HLS_TUNING = {
  liveSyncDuration: LIVE_SYNC_DURATION_S,
  liveMaxLatencyDuration: LIVE_MAX_LATENCY_DURATION_S,
  maxLiveSyncPlaybackRate: LIVE_SYNC_PLAYBACK_RATE,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  maxBufferSize: 60 * MB,
  maxBufferHole: 1,
} as const satisfies Partial<HlsConfig>;

/**
 * The full config for one player instance: a tuning, plus the loaders that route manifest and
 * fragment requests through Swarm.
 *
 * A function rather than a spread at the call site so that what the component passes to hls.js is
 * one named thing a test can build and hand to a real `new Hls(...)`.
 *
 * `tuning` defaults to {@link HLS_TUNING} and is the seam a caller's own overrides arrive through.
 * The loaders are applied after it on purpose: they are what make this a Swarm player rather than an
 * HTTP one, and a tuning that replaced them would produce a component which looks like this one and
 * fetches from somewhere else entirely.
 */
export function buildPlayerConfig(
  loaders: Pick<HlsConfig, 'pLoader' | 'fLoader'>,
  tuning: Partial<HlsConfig> = HLS_TUNING,
): Partial<HlsConfig> {
  return {
    ...tuning,
    ...loaders,
    // Fragment loading is started by hand once the ladder is known, from the component's
    // MANIFEST_PARSED handler. Left on, hls.js starts it from its own MANIFEST_LOADED handler, and
    // whether that runs before or after the component gets to set `startLevel` depends on the order
    // two internal controllers happened to register for the same event. Not a race worth inheriting.
    autoStartLoad: false,
  };
}
