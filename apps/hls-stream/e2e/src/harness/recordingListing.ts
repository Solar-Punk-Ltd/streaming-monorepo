/**
 * What a finished broadcast's recording holds, rung by rung, read the way a viewer reads it: the ladder's master off its
 * own feed, and each rung's recording playlist off the rung's feed.
 *
 * ## What it answers that nothing else here does
 *
 * `viewer/vod-playback` plays a recording and judges whether each rung ends at the uploader's last segment. Nothing
 * judged the recording's SHAPE: whether every rung finalized into one, whether the rungs are the same length, and how
 * many broadcasting sessions each one glued together. A re-broadcast on a declared stream, a rung that restarted, and a
 * long broadcast whose recording outgrows one chunk all go wrong exactly there, and silently: the recording plays, it is
 * just short a rung, or a session, or most of its media.
 *
 * ## ⛔ Sessions are counted from the breaks, and that is an upper bound
 *
 * A recording glued from several sessions carries an `#EXT-X-DISCONTINUITY` at each seam, plus
 * `#EXT-X-DISCONTINUITY-SEQUENCE` for seams that ran in front of its first entry. So sessions here are the declared
 * breaks plus one. An encoder returning inside the reconnect window, a re-anchored clock and an origin-declared break
 * also place one, so on a broadcast with any of those this over-counts. Every suite that asserts a session count runs a
 * broadcast with no such fault in it, where breaks and seams are the same thing. A lost segment is a gap entry and adds
 * nothing.
 *
 * The parse and the verdict are pure so `test/recordingListing.test.ts` covers them under `pnpm verify`.
 * {@link readRecordingListing} and {@link waitForRecordingListing} are the only wiring.
 */

import { segmentSecondsOf } from '../browser/rungManifest.js';
import type { E2EConfig } from '../config.js';

import type { Host } from './host.js';
import type { RungFeed, RungPlaylistParse } from './manifestContractLive.js';
import { masterRungsOf, readLadderMaster } from './masterShape.js';
import { readRungHeads } from './rungPublishing.js';
import { sleep } from './wait.js';

/** One rung's recording as its feed head holds it. */
export interface RecordingRung {
  /** The rung name, or the stream id on a single rendition. */
  rung: string;
  /** Whether the head is a finished recording at all, rather than a live window or nothing. */
  recording: boolean;
  /** Media entries, gap entries left out, the way `RungPlaylistParse.segments` counts them. */
  segments: number;
  /** Seconds of timeline, gap entries included, because a hole really does occupy that stretch. */
  durationSeconds: number;
  /** `#EXT-X-DISCONTINUITY` tags inside the playlist. */
  discontinuities: number;
  /** Declared breaks plus one. See the header for why this is an upper bound. */
  sessions: number;
  /** Why the feed could not be read, or null. */
  unreadable: string | null;
}

/** One rung's feed head reduced to the recording facts a verdict weighs. Pure. */
export function recordingRungOf(parse: RungPlaylistParse): RecordingRung {
  const timeline = parse.playlist === null ? [] : segmentSecondsOf(parse.playlist);
  return {
    rung: parse.rung ?? parse.streamId ?? parse.topic,
    recording: parse.recording,
    segments: parse.segments,
    durationSeconds: timeline.reduce((total, seconds) => total + seconds, 0),
    discontinuities: parse.discontinuities,
    sessions: parse.playlist === null ? 0 : parse.discontinuitySequence + parse.discontinuities + 1,
    unreadable: parse.unreadable,
  };
}

/** What a recording must look like. */
interface RecordingExpectation {
  /** Every rung the broadcast announced. Each must be offered by the master and hold a recording. */
  rungs: readonly string[];
  /** Sessions every rung must hold, or per rung where they differ, as after one rung restarted. */
  sessions: number | ReadonlyMap<string, number>;
  /** The deployment's segment length, which is how far apart two rung durations may be. */
  fragmentSeconds: number;
  /** Media entries the shortest rung must reach, or null to leave the count unjudged. */
  minSegments?: number | null;
  /**
   * Rungs left out of the equal-length rule, because the scenario took media from them on purpose: a rung whose
   * transcode was stopped for minutes is right to be minutes short of its siblings.
   */
  shortOnPurpose?: readonly string[];
}

function sessionsFor(expectation: RecordingExpectation, rung: string): number {
  return typeof expectation.sessions === 'number' ? expectation.sessions : (expectation.sessions.get(rung) ?? 1);
}

/**
 * Why a finished recording is not the whole broadcast on every rung, or null.
 *
 * ⛔ Every rule is reported, not the first, because they point at different defects. A rung missing from the master is
 * the ladder flip. A head that is not a recording is that rung's finalize. A short rung is media its recording lost.
 * A wrong session count is the glue across a restart.
 *
 * @param offered the rungs the master lists, out of `masterRungsOf`
 */
export function recordingRefusal(
  offered: readonly string[],
  rungs: readonly RecordingRung[],
  expectation: RecordingExpectation,
): string | null {
  if (expectation.rungs.length === 0) {
    return 'no rung was expected to hold a recording, so nothing about this one was judged';
  }
  const problems: string[] = [];
  const byRung = new Map(rungs.map((rung) => [rung.rung, rung]));

  const notOffered = expectation.rungs.filter((rung) => !offered.includes(rung));
  if (notOffered.length > 0) {
    problems.push(`the finished master does not offer ${notOffered.join(', ')}`);
  }

  for (const name of expectation.rungs) {
    const rung = byRung.get(name);
    if (rung === undefined || !rung.recording) {
      problems.push(
        `${name} holds no finished recording (${rung?.unreadable ?? (rung === undefined ? 'never read' : 'its head is a live window')})`,
      );
      continue;
    }
    const wanted = sessionsFor(expectation, name);
    if (rung.sessions !== wanted) {
      problems.push(`${name} glued ${rung.sessions} session(s) where the broadcast made ${wanted}`);
    }
    if (
      expectation.minSegments !== undefined &&
      expectation.minSegments !== null &&
      rung.segments < expectation.minSegments
    ) {
      problems.push(
        `${name} holds ${rung.segments} segment(s) where at least ${expectation.minSegments} were published`,
      );
    }
  }

  const finished = rungs.filter(
    (rung) =>
      rung.recording &&
      expectation.rungs.includes(rung.rung) &&
      !(expectation.shortOnPurpose ?? []).includes(rung.rung),
  );
  const longest = Math.max(0, ...finished.map((rung) => rung.durationSeconds));
  const short = finished.filter((rung) => longest - rung.durationSeconds > expectation.fragmentSeconds);
  if (short.length > 0) {
    problems.push(
      `${short.map((rung) => `${rung.rung} ${rung.durationSeconds.toFixed(1)}s`).join(', ')} fall more than one ` +
        `${expectation.fragmentSeconds}s segment short of the longest rung's ${longest.toFixed(1)}s`,
    );
  }

  return problems.length === 0
    ? null
    : `the recording is not the whole broadcast on every rung: ${problems.join('; ')}`;
}

/** Sessions each rung's recording glues, for the rungs whose head is a finished recording. */
export function sessionsByRung(rungs: readonly RecordingRung[]): ReadonlyMap<string, number> {
  return new Map(rungs.filter((rung) => rung.recording).map((rung) => [rung.rung, rung.sessions]));
}

/**
 * Why a declared stream's recording did not grow by exactly the sessions broadcast onto it, or null.
 *
 * ⛔ The baseline is the recording itself, read once after a suite's first session finalized, never the uploader's
 * log: a declared stream's recording glues every session its feed ever carried, across runs and redeploys, and a log
 * tail forgets all of it at the first redeploy. So the rule is a difference: every rung the first reading held must
 * hold exactly `added` more sessions at the last, and every rung must agree, because one ladder is one broadcast.
 *
 * @param added sessions broadcast after the first reading was taken
 */
export function sessionGrowthRefusal(
  afterFirst: ReadonlyMap<string, number>,
  afterLast: ReadonlyMap<string, number>,
  added: number,
): string | null {
  if (afterFirst.size === 0) {
    return 'no rung held a finished recording after the first session, so there is no baseline to grow from';
  }
  const problems = [...afterFirst].flatMap(([rung, first]) => {
    const last = afterLast.get(rung);
    if (last === undefined) {
      return [`${rung} holds no finished recording after the last session`];
    }
    return last === first + added ? [] : [`${rung} went from ${first} to ${last} session(s) where ${added} were added`];
  });
  const finals = new Set(afterLast.values());
  if (finals.size > 1) {
    const each = [...afterLast].map(([rung, count]) => `${rung} ${count}`).join(', ');
    problems.push(`the rungs disagree about how many sessions the broadcast holds (${each})`);
  }
  return problems.length === 0
    ? null
    : `the recording did not grow by one session per broadcast: ${problems.join('; ')}`;
}

/**
 * Segment uploads per recording rung, keyed the way {@link recordingRungOf} keys the listing: by rung name, or by topic
 * on a single rendition, whose feed carries no stream id.
 *
 * ⛔ Resolved the way `publishedFor` resolves a playlist's count: a feed with a stream id takes that stream's uploads,
 * and a feed without one takes the one stream the window holds. Null where neither can be attributed, so a caller
 * refuses rather than comparing against nothing, which is what made the comparison pass by construction before.
 */
export function uploadsPerRecordingRung(
  feeds: readonly RungFeed[],
  byStream: ReadonlyMap<string, number>,
): ReadonlyMap<string, number | null> {
  return new Map(
    feeds.map((feed) => {
      const key = feed.rung ?? feed.streamId ?? feed.topic;
      if (feed.streamId !== null) {
        return [key, byStream.get(feed.streamId) ?? null];
      }
      return [key, byStream.size === 1 ? [...byStream.values()][0] : null];
    }),
  );
}

/** One line per rung, for the run's log. */
export function describeRecording(offered: readonly string[], rungs: readonly RecordingRung[]): string {
  const lines = rungs.map(
    (rung) =>
      `  ${rung.rung}: ${rung.recording ? 'recording' : 'NOT a recording'}, ${rung.segments} segment(s), ` +
      `${rung.durationSeconds.toFixed(1)}s, ${rung.discontinuities} break(s), ${rung.sessions} session(s)`,
  );
  return [`  the finished master offers: ${offered.join(', ') || 'nothing'}`, ...lines].join('\n');
}

/** Where one finished broadcast's recording lives. */
interface RecordingLocation {
  /** The signer's address, as `discoverCatalogFeed` reads it. */
  owner: string;
  /** The ladder group, which is also the master feed's topic, or null on a single rendition, which has no master. */
  ladder: string | null;
  /** Every rung's feed, out of `rungFeedsOf` over the broadcast's own log window. */
  feeds: readonly RungFeed[];
}

/** The master and every rung head, read once. */
export interface RecordingListing {
  offered: readonly string[];
  rungs: readonly RecordingRung[];
}

/** Read the finished master and every rung's head once, judging nothing. */
export async function readRecordingListing(
  host: Host,
  cfg: E2EConfig,
  { owner, ladder, feeds }: RecordingLocation,
): Promise<RecordingListing> {
  const parses = await readRungHeads(host, cfg, owner, feeds);
  const rungs = parses.map(recordingRungOf);
  if (ladder === null) {
    return { offered: rungs.map((rung) => rung.rung), rungs };
  }
  const rungByTopic = new Map(
    feeds.filter((feed) => feed.rung !== null).map((feed) => [feed.topic, feed.rung as string]),
  );
  const master = await readLadderMaster(host, cfg, owner, ladder);
  return { offered: masterRungsOf(master, rungByTopic).offered, rungs };
}

/** How often every head is re-read while waiting for the last rung to finalize. */
const RECORDING_POLL_MS = 5_000;

/**
 * Re-read until every rung head is a finished recording, or the time runs out, and hand back the last listing.
 *
 * A finalize writes each rung's recording on its own and the master after them, so a listing read the instant the
 * catalog flips can still hold a live window on a slow rung. Never throws: the caller judges what came back.
 */
export async function waitForRecordingListing(
  host: Host,
  cfg: E2EConfig,
  location: RecordingLocation,
  timeoutMs: number,
): Promise<RecordingListing> {
  const deadline = Date.now() + timeoutMs;
  let listing = await readRecordingListing(host, cfg, location);
  while (!listing.rungs.every((rung) => rung.recording) && Date.now() < deadline) {
    await sleep(RECORDING_POLL_MS);
    listing = await readRecordingListing(host, cfg, location);
  }
  return listing;
}
