import { shouldProbePastRefusal } from './refusedSlot';

/** The newest segment a rung holds, as the walk last saw it. */
export interface NewestSegmentTiming {
  /** Its `#EXTINF` duration, or null when the line does not carry a number. */
  readonly durationS: number | null;
  /** Its `#EXT-X-PROGRAM-DATE-TIME`, or null when the playlist carries none. */
  readonly programDateTimeMs: number | null;
}

/** What one pass of a rung's walk found, which is what the next wait is decided from. */
export interface PollObservation {
  /** How many indexes the pass took. Zero means it asked for the next one and it was not there. */
  readonly advanced: number;
  readonly newestSegment: NewestSegmentTiming | null;
  /** Since the walk last took a new index, or null before its first. */
  readonly msSinceNewIndex: number | null;
}

/**
 * How a rung's walk paces its asks.
 *
 * Injected so the polling study (decision 31) can compare policies on the same walk. Every ask for an
 * index not written yet makes a Bee node skip its peers for that address for a while, so the policy is
 * what decides how much a caught-up viewer costs the network.
 */
export interface PollPacing {
  /** The wait before the walk's next ask. Zero asks again straight away. */
  waitBeforeNextAskMs(observation: PollObservation): number;
  /** Whether a run of refusals this long is worth asking what is behind it. See `probePastRefusal`. */
  probesPastRefusal(unservedPolls: number): boolean;
}

/**
 * The pacing every walk had before it was a choice: ask again at once after a pass that took
 * something, wait one interval after a pass that took nothing, and probe past a refusal on the run
 * lengths `shouldProbePastRefusal` names.
 */
export function steadyPollPacing(intervalMs: number): PollPacing {
  return {
    waitBeforeNextAskMs: (observation) => (observation.advanced === 0 ? intervalMs : 0),
    probesPastRefusal: shouldProbePastRefusal,
  };
}
