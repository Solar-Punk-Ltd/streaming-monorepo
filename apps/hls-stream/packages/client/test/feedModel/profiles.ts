/**
 * How a Bee node answers, fitted to phase 0's two runs of ten minutes on 2026-10-06: A through the
 * test stack's viewer gateway, B through a local Bee node. Round trips are log-normal with the
 * measured medians. The spreads were then fitted, with the readable lag's jitter, so that today's walk
 * reproduces the measured asks per slot (the study report gives the fit), and come out a little
 * narrower than the raw p10 to p90 of the round trips, whose far tails are not log-normal.
 */
export interface NodeProfile {
  readonly name: 'A' | 'B';
  /** A read that found its slot: median and log spread. */
  readonly foundMs: { readonly median: number; readonly sigma: number };
  /** A read that did not: Bee waits on the network before it answers 404, so this is no cheaper. */
  readonly missingMs: { readonly median: number; readonly sigma: number };
  /**
   * How far into a read the node decides whether the slot is there. A slot that becomes readable
   * after that moment is answered as missing even though the answer arrives later.
   */
  readonly decideAfterMs: number;
  /** One probe inside Bee's own lookup that finds its chunk, before its one second timeout. */
  readonly lookupProbeFoundMs: { readonly median: number; readonly sigma: number };
  /**
   * One probe inside Bee's own lookup whose chunk is not there. Bee turns not-found into an empty
   * answer at once (`get` in `pkg/feeds/sequence/sequence.go`), so this is the retrieval's own
   * not-found time, cut at the one second timeout. Taken as a playlist miss less its HTTP overhead.
   */
  readonly lookupProbeMissingMs: { readonly median: number; readonly sigma: number };
}

export const PROFILE_A: NodeProfile = {
  name: 'A',
  foundMs: { median: 656, sigma: 0.5 },
  missingMs: { median: 716, sigma: 0.4 },
  decideAfterMs: 150,
  lookupProbeFoundMs: { median: 60, sigma: 0.5 },
  lookupProbeMissingMs: { median: 550, sigma: 0.4 },
};

export const PROFILE_B: NodeProfile = {
  name: 'B',
  foundMs: { median: 910, sigma: 0.5 },
  missingMs: { median: 913, sigma: 0.45 },
  decideAfterMs: 150,
  lookupProbeFoundMs: { median: 120, sigma: 0.5 },
  lookupProbeMissingMs: { median: 750, sigma: 0.4 },
};

export const PROFILES = { A: PROFILE_A, B: PROFILE_B } as const;
