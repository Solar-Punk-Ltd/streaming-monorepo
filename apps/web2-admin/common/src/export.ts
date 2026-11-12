/**
 * Exporting a recording: the API reads one quality of a finished recording from Swarm, joins its segments into an MP4
 * on the server, and keeps the file so any user can save it from the console without another Swarm read.
 *
 * One export exists at a time for the whole admin: the one running, paused or waiting, or once it is done, the kept
 * file. Starting a new one replaces the kept file. Every signed-in user sees it and can act on it.
 */

/** Where the console reads the export on the server and acts on it. */
export const EXPORT_PATH = '/api/export';

/** The options for one stream, and where an export of it is started: GET answers the options, POST starts. */
export function streamExportPath(streamId: string): string {
  return `/api/streams/${encodeURIComponent(streamId)}/export`;
}

/** POST an `ExportActionRequest`: pause, resume, wait, save, cancel or dismiss. */
export function exportActionPath(exportId: string): string {
  return `${EXPORT_PATH}/${encodeURIComponent(exportId)}/actions`;
}

/** The finished MP4, as an attachment with its file name. A plain GET, so a link can save it. */
export function exportFilePath(exportId: string): string {
  return `${EXPORT_PATH}/${encodeURIComponent(exportId)}/file`;
}

/**
 * - `reading`: the segments are read from Swarm.
 * - `joining`: ffmpeg joins what was read into the MP4.
 * - `paused`: stopped, with a reason, until someone decides.
 * - `waiting`: the stream went live again, and the export continues by itself once it is a recording again.
 * - `done`: the MP4 is kept on the server.
 */
export type ExportState = 'reading' | 'joining' | 'paused' | 'waiting' | 'done';

/** The states in which the export holds the one slot and nobody can start another. */
export const EXPORT_ACTIVE_STATES: readonly ExportState[] = ['reading', 'joining', 'paused', 'waiting'];

/**
 * Why an export paused:
 * - `user`: someone pressed Pause.
 * - `unreadable`: some segments could not be read from Swarm, after retries.
 * - `live`: the stream went live again, so its recording is changing.
 * - `disk`: the server ran short of free disk.
 * - `problem`: anything else, in `pauseMessage`: no node to read through, a playlist that cannot be read, a join
 *   that failed.
 */
export type ExportPauseReason = 'user' | 'unreadable' | 'live' | 'disk' | 'problem';

/** Whether a pause asks for a decision: every reason but a user's own Pause. */
export function pauseNeedsDecision(reason: ExportPauseReason | null): boolean {
  return reason !== null && reason !== 'user';
}

/**
 * What a user can do to the export:
 * - `pause`: stop reading after the segments in flight.
 * - `resume`: carry on reading; after `unreadable` it tries the missing segments again.
 * - `wait`: after `live`, carry on by itself once the stream is a recording again.
 * - `save`: join what was read into an MP4 now. A missing stretch becomes a cut, and the file is marked partial.
 * - `cancel`: stop, and delete everything the export read.
 * - `dismiss`: close the widget of a finished export, for the user who asks only.
 * - `clear`: delete the kept file of a finished export, for everyone, so its quality can be exported again.
 */
export type ExportAction = 'pause' | 'resume' | 'wait' | 'save' | 'cancel' | 'dismiss' | 'clear';

export const EXPORT_ACTIONS: readonly ExportAction[] = [
  'pause',
  'resume',
  'wait',
  'save',
  'cancel',
  'dismiss',
  'clear',
];

/** The export on the server, as every user sees it. */
export interface ExportSummary {
  id: string;
  streamId: string;
  streamTitle: string;
  /** The rung's name, such as `1080p`, or `source` for a recording with one quality. */
  rendition: string;
  /** What the file name ends in: the rung's name, or the height of a single-quality recording once it is known. */
  quality: string;
  state: ExportState;
  /** Set while `paused`, null otherwise. */
  pauseReason: ExportPauseReason | null;
  /** The sentence that says why it paused, while `paused`. */
  pauseMessage: string | null;
  pausedAt: string | null;
  /** Segments in the recording, once its playlist was read. Gaps in the recording are not counted. */
  segmentsTotal: number | null;
  segmentsRead: number;
  /** Segments that could not be read on the last pass. */
  segmentsMissing: number;
  bytesRead: number;
  estimatedBytes: number | null;
  durationSeconds: number | null;
  /** Set once done. */
  fileName: string | null;
  sizeBytes: number | null;
  /** The file was saved from part of the recording. */
  partial: boolean;
  /** Who started it, as the audit log names them. */
  startedBy: string;
  /** Whether the user asking started it: the panel comes to front for them when it pauses on a problem. */
  startedByYou: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Whether the user asking closed its widget. Only a finished export can be closed. */
  dismissed: boolean;
  /** What can be done to it now, as the API decides. */
  actions: ExportAction[];
}

/** `GET /api/export`: the export on the server, or null when there is none. */
export interface ExportCurrentResponse {
  export: ExportSummary | null;
}

/** One quality a recording can be exported in. */
export interface ExportQuality {
  /** What `ExportStartRequest.rendition` names: the rung's name, or `source`. */
  rendition: string;
  /** What the panel shows: the rung's name, or `Source`. */
  label: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** The MP4's size, estimated from the bitrate and length, or from the playlist and its first segment. */
  estimatedBytes: number | null;
  /** Null when it can be exported; otherwise the sentence that says why not. */
  unavailable: string | null;
}

export type ExportRefusalProblem =
  | 'busy'
  | 'not_recording'
  | 'quality_unavailable'
  | 'no_node'
  | 'no_ffmpeg'
  | 'disk'
  | 'not_now';

export interface ExportRefusal {
  problem: ExportRefusalProblem;
  message: string;
}

/** `GET /api/streams/:id/export`: what the panel offers for one stream. */
export interface ExportOptionsResponse {
  streamId: string;
  title: string;
  /** The day the broadcast started, in UTC, as the file name carries it: `YYYY-MM-DD`. */
  date: string | null;
  durationSeconds: number | null;
  qualities: ExportQuality[];
  /** Why no export of this stream can start now, or null. */
  refusal: ExportRefusal | null;
  /** The export on the server, of this stream or another. */
  current: ExportSummary | null;
}

export interface ExportStartRequest {
  rendition: string;
}

export interface ExportActionRequest {
  action: ExportAction;
}

/** The 409 the API answers when an export cannot start or an action cannot be done now. */
export interface ExportRefusedAnswer {
  error: 'export_refused';
  problem: ExportRefusalProblem;
  message: string;
}

/**
 * Whether a stream holds a finished recording, which is what the console offers Download on: recorded, published or
 * not. The API decides again when an export starts.
 */
export function holdsFinishedRecording(stream: { status: string; manifestIndex?: number | null }): boolean {
  return (stream.status === 'vod' || stream.status === 'draft') && stream.manifestIndex != null;
}
