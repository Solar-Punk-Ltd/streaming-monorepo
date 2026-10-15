/**
 * The long-broadcast scenario's two numbers: how long it broadcasts, and how long its finish took.
 *
 * ## Why long
 *
 * A recording playlist names every segment the broadcast made, so it grows by one entry a segment. Past 4096 bytes it
 * no longer fits one Swarm chunk, which is about two minutes of a four-rung ladder at 1 s segments, and every suite here
 * stops well before the recording of a real broadcast is that big. Twenty minutes is roughly ten chunks per rung, which
 * is a recording no other suite ever finalizes.
 *
 * ## ⛔ The finish time is an observation, never asserted
 *
 * Owner rule of 2026-08-29: an e2e suite checks correctness and never gates on a timing. How long the last publish took
 * is printed and filed so a regression is visible, and nothing refuses on it.
 */

import { ladderFinalizedPattern, manifestUploadedPattern } from '@swarm-hls-stream/shared';

import { timestampedMessages } from './logwatch.js';

const LONG_BROADCAST_MINUTES_VAR = 'E2E_LONG_BROADCAST_MINUTES';
export const DEFAULT_LONG_BROADCAST_MINUTES = 20;

/**
 * Minutes to broadcast, out of `E2E_LONG_BROADCAST_MINUTES`, 20 when unset.
 *
 * ⛔ Thrown at import on anything that is not a positive number, rather than read as the default, because a typo would
 * otherwise run a twenty minute paid broadcast nobody asked for, or a zero minute one that proves nothing.
 */
export function longBroadcastMinutes(env: NodeJS.ProcessEnv): number {
  const raw = env[LONG_BROADCAST_MINUTES_VAR]?.trim() ?? '';
  if (raw === '') {
    return DEFAULT_LONG_BROADCAST_MINUTES;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`${LONG_BROADCAST_MINUTES_VAR}=${raw} is not a positive number of minutes`);
  }
  return minutes;
}

/**
 * Seconds from the last live playlist any rung published to the ladder's VOD flip, or null where the log holds either
 * end unpaired. Read off the uploader's own timestamps, so one clock measures both ends.
 */
export function finalizeSecondsAfterLastPublish(logText: string, ladder: string): number | null {
  const stamped = timestampedMessages(logText);
  const flipped = stamped.find((line) =>
    [...line.message.matchAll(ladderFinalizedPattern('g'))].some((m) => m[1] === ladder),
  );
  if (flipped === undefined) {
    return null;
  }
  const lastPublish = stamped
    .filter((line) => line.atMs <= flipped.atMs && manifestUploadedPattern().test(line.message))
    .at(-1);
  return lastPublish === undefined ? null : (flipped.atMs - lastPublish.atMs) / 1000;
}
