import type { StreamStatus } from './api.js';

/**
 * Checking the recordings and removing the lost ones. A recording lives on Swarm only while a batch that stamped it
 * has time left, so once a stage's batches have run out its recordings are gone, while the admin still lists them. A
 * person starts a check on the Streams page; it reads each recording through the catalogue node, several times over a
 * span, and lists the ones it could not read. Remove lost recordings then takes them off the catalogue and deletes
 * them. `docs/architecture/web2-admin.md`, "Lost recordings", is the design.
 *
 * One check exists at a time for the whole admin: the one running, or the last one that ended.
 */

/** GET answers the latest check and whether a new one can start; POST starts one. */
export const RECORDING_CHECK_PATH = '/api/recordings/check';

/** POST a {@link LostRecordingsRemovalRequest}: remove the recordings a finished check lists as lost. */
export const LOST_RECORDINGS_REMOVAL_PATH = '/api/recordings/lost/removal';

/** How many times a check reads a recording that failed to read, each a round, before it calls it lost. */
export const RECORDING_CHECK_ROUNDS = 3;

/** The seconds between two rounds: ten minutes, so the three rounds of a failing recording span twenty. */
export const RECORDING_CHECK_ROUND_GAP_SECONDS = 600;

/**
 * The peers the catalogue node has to be connected to for a read through it to count. A node with fewer reads
 * nothing whatever is on Swarm, so a check starts, and goes on to its next round, only at this many or more.
 */
export const RECORDING_CHECK_MIN_PEERS = 4;

/** How long a finished check's list is good for a removal, in seconds: six hours. After that a new check is run. */
export const RECORDING_CHECK_VALID_SECONDS = 6 * 60 * 60;

/**
 * Why a stream is left out of a check, unjudged:
 * - `live`: it is live, so its recording is being written.
 * - `restart_window`: it ended and can still go live again on its key, so its recording can still change.
 * - `job`: an export or an archive of it is under way, which reads the same recording.
 * - `test`: it is a test stream, hidden from viewers.
 * - `unlisted`: a removal took it off the catalogue as lost and kept it as a draft for the export file the server keeps
 *   of it, and it has not changed since, so a check would only find it lost again.
 */
export type RecordingSkipReason = 'live' | 'restart_window' | 'job' | 'test' | 'unlisted';

/** What the one rule reads of a stream to decide whether a check may judge it. */
export interface RecordingJudgeInput {
  status: StreamStatus;
  /** The end of the stream's restart window, ISO 8601, or null when it has none open. */
  restartUntil: string | null;
  /** Whether an export or an archive job of the stream is under way. */
  hasOpenJob: boolean;
  /** Whether the stream is a test stream. Absent is read as false. */
  test?: boolean;
  /**
   * Whether a removal kept the stream as a draft off the catalogue for its export file, and it has not changed since.
   * Absent is read as false.
   */
  unlisted?: boolean;
}

/**
 * Why a check leaves a stream unjudged, or null when it may judge it. Every part of the check and of the removal asks
 * this one rule, so a kind of stream that must never be judged is named here and nowhere else.
 */
export function recordingSkipReason(stream: RecordingJudgeInput, now: Date): RecordingSkipReason | null {
  if (stream.test === true) return 'test';
  if (stream.status === 'live') return 'live';
  if (stream.restartUntil !== null && new Date(stream.restartUntil).getTime() > now.getTime()) return 'restart_window';
  if (stream.hasOpenJob) return 'job';
  if (stream.unlisted === true) return 'unlisted';
  return null;
}

/**
 * What a check found of one recording:
 * - `readable`: its master playlist and every quality were read, in some round.
 * - `partly_lost`: some quality was read and some other failed in every round. It is listed and left alone.
 * - `lost`: its master playlist failed in every round, or every quality did.
 */
export type RecordingVerdict = 'readable' | 'partly_lost' | 'lost';

/**
 * The readings of one recording, round by round, true for a read that came back whole. `master` is the stream's own
 * playlist, the master playlist of a ladder. A quality is read as its playlist and its first segment, one after the
 * other, and a stream with no ladder has one quality, itself. A round is skipped for whatever already read, so a list
 * shorter than the rounds ends in true.
 */
export interface RecordingReadings {
  master: readonly boolean[];
  qualities: readonly { name: string; rounds: readonly boolean[] }[];
}

/** Whether a list of rounds is a failure in every one of {@link RECORDING_CHECK_ROUNDS}. */
function failedEveryRound(rounds: readonly boolean[]): boolean {
  return rounds.length >= RECORDING_CHECK_ROUNDS && rounds.every((read) => !read);
}

/**
 * The verdict the readings give once the last round is over. A read that failed once and came back later is a
 * readable recording: only a failure in every round counts, so a slow or a passing failure loses nothing.
 */
export function recordingVerdict(readings: RecordingReadings): RecordingVerdict {
  if (failedEveryRound(readings.master)) return 'lost';
  const failed = readings.qualities.filter((quality) => failedEveryRound(quality.rounds));
  if (failed.length === 0) return 'readable';
  return failed.length === readings.qualities.length ? 'lost' : 'partly_lost';
}

/**
 * - `running`: a round is being read, or the check waits for its next round.
 * - `done`: the last round is over, and `lost` and `partlyLost` are the result.
 * - `stopped`: the check ended early with no result, and `stopMessage` says why: the catalogue node fell under
 *   {@link RECORDING_CHECK_MIN_PEERS} peers or stopped answering, or the admin restarted.
 */
export type RecordingCheckState = 'running' | 'done' | 'stopped';

/** One recording a check lists. */
export interface CheckedRecording {
  streamId: string;
  title: string;
  status: StreamStatus;
  verdict: Exclude<RecordingVerdict, 'readable'>;
  /** The qualities that failed in every round, by name; every one of a lost recording whose master was read. */
  failedQualities: string[];
  /** Whether the server keeps an export file of this stream. A removal then takes it off the catalogue and keeps it. */
  hasExportFile: boolean;
}

/** A check, as the Streams page shows it. */
export interface RecordingCheck {
  id: string;
  state: RecordingCheckState;
  stopMessage: string | null;
  /** The round being read or last read, 1 to {@link RECORDING_CHECK_ROUNDS}. */
  round: number;
  /** When the next round starts, ISO 8601, or null when none waits. */
  nextRoundAt: string | null;
  /** The recordings the check judges, the ones read so far in this round, and the streams it left unjudged. */
  total: number;
  readThisRound: number;
  unjudged: number;
  /** The result, each list empty until the check is `done`. */
  lost: CheckedRecording[];
  partlyLost: CheckedRecording[];
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * `GET /api/recordings/check`. `check` is the latest check, null before the first. `startRefusal` says in a sentence
 * why a new check cannot start now, or is null: one is running, no catalogue node is designated, or the node has too
 * few peers. `removalRefusal` says why the latest check's lost recordings cannot be removed now, or is null: the check
 * is not done or lists none, its list is older than {@link RECORDING_CHECK_VALID_SECONDS}, or the catalogue cannot be
 * written, and then the sentence says to recover the catalogue first.
 */
export interface RecordingCheckResponse {
  check: RecordingCheck | null;
  startRefusal: string | null;
  removalRefusal: string | null;
}

/**
 * `POST /api/recordings/lost/removal`: remove the lost recordings of the check `checkId`. `streamIds` is the list the
 * confirm showed, and has to be the check's own list of lost recordings, in any order, so what is removed is what a
 * person read. A partly lost recording is never in it.
 */
export interface LostRecordingsRemovalRequest {
  checkId: string;
  streamIds: string[];
}

/** One stream of a removal's answer. */
export interface RemovedRecording {
  streamId: string;
  title: string;
}

/**
 * What a removal did. Each stream is asked the one rule again and read once more first, and one that may not be
 * judged now, or that reads now, is left as it is, in `kept` with the reason. The rest leave the catalogue in one
 * write, at `feedIndex`. A stream with an export file on the server stays, as a draft off the catalogue, in
 * `unlisted`; every other is deleted, in `removed`. Each is audited.
 */
export interface LostRecordingsRemovalResponse {
  removed: RemovedRecording[];
  unlisted: RemovedRecording[];
  kept: (RemovedRecording & { reason: string })[];
  /** The catalogue slot the removal wrote, or null when no stream of it was on the catalogue. */
  feedIndex: number | null;
}

/** What the confirm of a removal says above its list. */
export const LOST_RECORDINGS_REMOVAL_CONFIRM =
  'These recordings could not be read from Swarm in three readings over twenty minutes. Removing them takes them off the catalogue and deletes them from the admin. A stream with an export file on the server is kept as a draft.';
