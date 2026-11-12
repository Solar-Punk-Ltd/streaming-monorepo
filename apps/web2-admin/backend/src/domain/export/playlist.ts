/**
 * Reading a recording playlist, the HLS media playlist an uploader leaves at the head of a feed when a broadcast ends
 * (`apps/hls-stream/packages/stream-uploader/concepts.md`).
 *
 * Each segment is named by its Swarm reference, in one of three forms:
 * - a bare reference, 64 hex digits, or 128 for an encrypted one: every recording since 2026-08-13;
 * - an absolute `http://<host>/bytes/<reference>`: older recordings, written with the address of the node that
 *   uploaded them;
 * - a relative `/bytes/<reference>`.
 * Only the reference is taken. A playlist that names anything else is refused, so a playlist can never make the
 * export fetch an address of its choosing.
 *
 * `#EXT-X-GAP` entries, which mark a stretch the uploader never received, are skipped and counted, and the segment
 * after one carries a break, so the file cuts across the hole. Their URI is `gap-<sequence>`. `#EXT-X-DISCONTINUITY` marks a seam between two sessions of one broadcast, and is kept on the
 * segment after it.
 */

/** One segment the export reads. */
export interface PlaylistSegment {
  reference: string;
  durationSeconds: number;
  /**
   * A break comes before this segment, so the file cuts here: a seam where another session of the broadcast starts,
   * whose clock differs, or a gap entry, a stretch the uploader never received, across which the clock ran on.
   */
  discontinuity: boolean;
}

export interface RecordingPlaylist {
  segments: PlaylistSegment[];
  /** Gap entries skipped. */
  gaps: number;
  /** The length of the segments, gaps left out. */
  durationSeconds: number;
}

/** The playlist is not a finished recording this export can read; the message says why, for the console. */
export class PlaylistFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaylistFormatError';
  }
}

const BARE_REFERENCE = /^[0-9a-f]{64}([0-9a-f]{64})?$/i;
const BYTES_REFERENCE = /(?:^|\/)bytes\/([0-9a-f]{64}(?:[0-9a-f]{64})?)(?:[/?#]|$)/i;
const GAP_URI = /^gap-\d+$/;

/**
 * The reference a segment line names, or null when it names none. Absolute and relative `/bytes/` forms give their
 * reference only; the host an old playlist names is never used.
 */
export function segmentReference(uri: string): string | null {
  if (BARE_REFERENCE.test(uri)) return uri.toLowerCase();
  const named = BYTES_REFERENCE.exec(uri);
  return named ? named[1]!.toLowerCase() : null;
}

export function parseRecordingPlaylist(text: string): RecordingPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== '#EXTM3U') throw new PlaylistFormatError('The recording playlist is not an HLS playlist.');
  if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'))) {
    throw new PlaylistFormatError('The playlist is a master playlist, not the recording of one quality.');
  }
  if (!lines.includes('#EXT-X-ENDLIST')) {
    throw new PlaylistFormatError('The playlist has no end, so it is not a finished recording.');
  }

  const segments: PlaylistSegment[] = [];
  let gaps = 0;
  let durationSeconds = 0;
  let duration: number | null = null;
  let gap = false;
  let discontinuity = false;
  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice('#EXTINF:'.length));
      duration = Number.isFinite(value) && value >= 0 ? value : 0;
      continue;
    }
    if (line === '#EXT-X-GAP') {
      gap = true;
      continue;
    }
    if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
      continue;
    }
    if (line.startsWith('#')) continue;

    // A URI line ends the segment its tags described.
    if (gap || GAP_URI.test(line)) {
      gaps += 1;
      // The uploader keeps the clock running across a hole, so the segments either side of it cannot be copied as one
      // stretch: the picture would freeze for the missing seconds. The next segment starts a new run, and the file cuts.
      discontinuity = true;
    } else {
      const reference = segmentReference(line);
      if (reference === null) {
        throw new PlaylistFormatError(
          `The recording playlist names "${line.slice(0, 80)}", which is not a Swarm reference, so it is not read.`,
        );
      }
      const seconds = duration ?? 0;
      segments.push({ reference, durationSeconds: seconds, discontinuity });
      durationSeconds += seconds;
      discontinuity = false;
    }
    duration = null;
    gap = false;
  }
  if (segments.length === 0) throw new PlaylistFormatError('The recording playlist names no segments.');
  return { segments, gaps, durationSeconds };
}

/**
 * The segments as runs the joiner can copy without touching their timestamps: a run breaks at a seam between
 * sessions, whose clocks differ, after a gap entry, and at a segment that was not read, so a missing stretch becomes a
 * cut. Segments are named by reference, so `present` holds the references read.
 */
export function runsOf(segments: readonly PlaylistSegment[], present: ReadonlySet<string>): PlaylistSegment[][] {
  const runs: PlaylistSegment[][] = [];
  let run: PlaylistSegment[] = [];
  for (const segment of segments) {
    if (!present.has(segment.reference)) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    if (segment.discontinuity && run.length > 0) {
      runs.push(run);
      run = [];
    }
    run.push(segment);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}
