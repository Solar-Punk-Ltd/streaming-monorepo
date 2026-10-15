import { type ErrorData, ErrorDetails } from 'hls.js';

/** One segment of a finished playlist on the media timeline, in seconds. */
interface RecordingSegment {
  readonly start: number;
  readonly duration: number;
}

/** Where the player a restart builds starts loading, and the source and timeline that position belongs to. */
export interface RestartResume {
  readonly sourceUrl: string;
  readonly positionS: number;
  readonly segments: readonly RecordingSegment[];
  readonly targetDurationS: number;
}

/** The parts of a playlist a restart reads, as hls.js's level details carry them. */
interface PlaylistTimeline {
  readonly live: boolean;
  readonly fragments: readonly RecordingSegment[];
  readonly targetduration: number;
}

/** Below this a playhead and a segment edge are the same place, so float sums never pin a resume to one spot. */
const SAME_PLACE_S = 0.01;

/**
 * Failures of a playlist rather than of what plays at the position. A restart after one of them resumes
 * at the same spot, because moving past the segment there would skip media nothing showed was broken.
 */
const PLAYLIST_FAILURES: ReadonlySet<string> = new Set([
  ErrorDetails.MANIFEST_LOAD_ERROR,
  ErrorDetails.MANIFEST_LOAD_TIMEOUT,
  ErrorDetails.MANIFEST_PARSING_ERROR,
  ErrorDetails.LEVEL_LOAD_ERROR,
  ErrorDetails.LEVEL_LOAD_TIMEOUT,
  ErrorDetails.LEVEL_PARSING_ERROR,
  ErrorDetails.LEVEL_EMPTY_ERROR,
]);

/**
 * Where a restarted player picks up, read from the player that failed, or null for hls.js's own start.
 *
 * Only a finished playlist keeps the viewer's place. A recording has one timeline, so a viewer 2100 s
 * in who hit a fatal error was otherwise sent back to 0 (2026-10-15). A live rung's playlist is rebuilt
 * from its newest window on a restart, so a live viewer rejoins at the live edge as before.
 */
export function restartResumeOf(
  details: PlaylistTimeline | undefined,
  currentTimeS: number,
  sourceUrl: string,
): RestartResume | null {
  if (!details || details.live || !(currentTimeS > 0)) {
    return null;
  }
  return {
    sourceUrl,
    positionS: currentTimeS,
    segments: details.fragments,
    targetDurationS: details.targetduration,
  };
}

/**
 * Where the next player starts, from what the failed player read and the place the previous restart
 * asked for, which is still held only while playback has not moved past it.
 *
 * A second failure at that place, on anything but a playlist, means the segment there may never load,
 * and restarting at it again would loop for as long as the tab stays open. So the resume moves past that
 * segment, and each repeat moves one further, until playback gets going or the recording runs out.
 */
export function nextRestartResume(
  read: RestartResume | null,
  kept: RestartResume | null,
  cause: ErrorData,
): RestartResume | null {
  const resume = read ?? kept;
  if (!resume || !kept || PLAYLIST_FAILURES.has(cause.details)) {
    return resume;
  }
  const keptSegment = segmentAt(kept, kept.positionS);
  const segmentLengthS = keptSegment?.duration ?? kept.targetDurationS;
  if (Math.abs(resume.positionS - kept.positionS) >= segmentLengthS) {
    return resume;
  }
  return { ...kept, positionS: positionPastSegmentAt(kept, kept.positionS) };
}

/** The segment playing at `positionS`, treating a position a hair short of an edge as on it. */
function segmentAt(timeline: RestartResume, positionS: number): RecordingSegment | undefined {
  return timeline.segments.find((segment) => segment.start + segment.duration > positionS + SAME_PLACE_S);
}

/** The end of the segment at `positionS`, which is always later than `positionS`. */
function positionPastSegmentAt(timeline: RestartResume, positionS: number): number {
  const segment = segmentAt(timeline, positionS);
  const end = segment ? segment.start + segment.duration : positionS + timeline.targetDurationS;
  return end > positionS + SAME_PLACE_S ? end : positionS + SAME_PLACE_S;
}
