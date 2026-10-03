/**
 * What the ingest suites share: how many streams a broadcast publishes, whether each has delivered, how a publisher
 * ended, and whether an encoder's return continued the broadcast it left.
 *
 * The verdicts are pure functions of log text so `test/ingest.test.ts` can hold them to the uploader's real lines
 * under `pnpm test`, which no suite under `suites/` is.
 */

import { segmentUploadedPattern } from '@swarm-hls-stream/shared';

import type { E2EConfig } from '../config.js';

import {
  announcedSessionTopics,
  encoderReturnCount,
  segmentIndicesByStream,
  timestampedMessages,
  vodFinalizeCountFor,
} from './logwatch.js';
import type { Publisher } from './publisher.js';
import { redactPublishKey } from './redactPublishKey.js';
import { StopWaiting } from './wait.js';

/** The streams one broadcast publishes: every rung of a ladder, or the one stream a single rendition is. */
export function streamsPerBroadcast(cfg: E2EConfig): number {
  return cfg.abrEnabled ? cfg.abrRungs.length : 1;
}

/** Whether at least `streams` streams each uploaded at least `perStream` segments in `logText`. */
export function everyStreamDelivered(logText: string, streams: number, perStream: number): boolean {
  const delivered = [...segmentIndicesByStream(logText).values()].filter((indices) => indices.length >= perStream);
  return delivered.length >= streams;
}

/** How many of a publisher's last stderr lines a refusal quotes. */
const STDERR_LINES_QUOTED = 3;

/**
 * How a publisher ended, for a refusal: its exit and the last of what it wrote.
 *
 * ⛔ Redacted, because ffmpeg quotes the URL it was dialing in its own errors, and the URL carries the publish key.
 * See `redactPublishKey.ts` for what one such line cost.
 */
export function publisherEnding(publisher: Pick<Publisher, 'exit' | 'stderr'>): string {
  const exit = publisher.exit();
  const ended = exit === null ? 'is still running' : `exited with ${exit.code ?? exit.signal ?? 'no status'}`;
  const said = publisher.stderr().trim().split('\n').filter(Boolean).slice(-STDERR_LINES_QUOTED).join(' | ');
  return said === '' ? ended : `${ended}, saying: ${redactPublishKey(said)}`;
}

/**
 * Throws {@link StopWaiting} once `publisher` has ended, so a wait on its media gives up at once with the reason it
 * ended, rather than spending its ceiling and reporting the uploader for media nobody was sending.
 */
export function requirePublishing(publisher: Pick<Publisher, 'exit' | 'stderr'>, who: string): void {
  if (publisher.exit() !== null) {
    throw new StopWaiting(`${who} ${publisherEnding(publisher)}`);
  }
}

/**
 * Why a broadcast whose encoder dropped and came back did not continue as the same broadcast, or null when it did.
 *
 * Continuing is three things the uploader's log says. The return announced no new session, so it joined the one it
 * left. Nothing finalized the broadcast into a recording. And every stream placed exactly one seam for the return,
 * which is the one break a viewer is told about.
 *
 * @param broadcastLog the whole broadcast's log, from before its first publish, which is where a ladder's rung
 *   announces are that attribute a finalize to it
 * @param sinceDrop the log from the moment the encoder dropped
 * @param topicsBefore the session topics the broadcast announced before the drop
 */
export function continuationRefusal(
  broadcastLog: string,
  sinceDrop: string,
  topicsBefore: ReadonlySet<string>,
  streams: number,
): string | null {
  const fresh = announcedSessionTopics(sinceDrop).filter((topic) => !topicsBefore.has(topic));
  if (fresh.length > 0) {
    return (
      `the return announced ${fresh.length} new session topic(s), so it started a new broadcast rather than ` +
      'continuing the one it left'
    );
  }
  const finalized = vodFinalizeCountFor(broadcastLog, [...topicsBefore]);
  if (finalized > 0) {
    return `the broadcast was finalized into a recording ${finalized} time(s), so the return had nothing to continue`;
  }
  const seams = encoderReturnCount(sinceDrop);
  if (seams !== streams) {
    return `the return placed ${seams} seam(s), where each of the ${streams} stream(s) owes exactly one`;
  }
  return null;
}

/**
 * Seconds from `sinceIso` to the first segment upload in `logText`, or null when there is none.
 *
 * Both instants are the deployment host's clock: `sinceIso` comes from `Host.nowIso` and the line's stamp from the
 * uploader's own log, so no clock skew between this machine and the host enters it. `nowIso` has a resolution of a
 * second, so this is a reading to the second and is printed as an observation, never asserted.
 */
export function secondsToFirstSegment(logText: string, sinceIso: string): number | null {
  const first = timestampedMessages(logText).find((line) => segmentUploadedPattern().test(line.message));
  return first === undefined ? null : (first.atMs - Date.parse(sinceIso)) / 1_000;
}

/** Prints what a suite measured, under the heading every e2e suite files its unasserted readings under. */
export function printObservations(suite: string, observations: readonly string[]): void {
  console.log(`  ${suite}: observations, none of them asserted`);
  for (const observation of observations) {
    console.log(`    ${observation}`);
  }
}
