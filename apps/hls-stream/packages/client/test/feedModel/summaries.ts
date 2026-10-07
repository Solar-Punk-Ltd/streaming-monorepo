import type { FindOutcome, FollowOutcome } from './runs';
import { mean, quantile } from './random';

export interface FollowSummary {
  readonly runs: number;
  readonly requestsPerMinute: number;
  readonly earlyAsksPerIndex: number;
  readonly readableToFound: { readonly p50: number; readonly p90: number; readonly p99: number };
  /** The longest wait between two deliveries: the median run's, and the worst of all runs. */
  readonly longestGap: { readonly median: number; readonly max: number };
  readonly stallsPerHour: number;
  readonly stalledSecondsPerHour: number;
  readonly skippedPerHour: number;
  readonly resumeDelay: { readonly p50: number; readonly p90: number; readonly max: number } | null;
  readonly firstSlotEarlyAsks: { readonly mean: number; readonly max: number };
  /** Share of delivered slots that took 1, 2, 3 and 4 or more reads. */
  readonly readsPerSlotShares: readonly number[];
}

export function summariseFollow(outcomes: readonly FollowOutcome[]): FollowSummary {
  const minutes = outcomes.reduce((sum, outcome) => sum + outcome.minutes, 0);
  const delivered = outcomes.reduce((sum, outcome) => sum + outcome.delivered, 0);
  const latencies = outcomes.flatMap((outcome) => outcome.readableToFoundMs);
  const longest = outcomes.map((outcome) => Math.max(0, ...outcome.deliveryGapsMs));
  const resumes = outcomes.map((outcome) => outcome.resumeDelayMs).filter((delay): delay is number => delay !== null);
  const shares = [0, 0, 0, 0];
  for (const reads of outcomes.flatMap((outcome) => outcome.readsPerSlot)) {
    shares[Math.min(4, Math.max(1, reads)) - 1] += 1;
  }
  const hours = minutes / 60;
  return {
    runs: outcomes.length,
    requestsPerMinute: outcomes.reduce((sum, outcome) => sum + outcome.reads, 0) / minutes,
    earlyAsksPerIndex: outcomes.reduce((sum, outcome) => sum + outcome.earlyAsks, 0) / Math.max(1, delivered),
    readableToFound: { p50: quantile(latencies, 0.5), p90: quantile(latencies, 0.9), p99: quantile(latencies, 0.99) },
    longestGap: { median: quantile(longest, 0.5), max: Math.max(...longest) },
    stallsPerHour: outcomes.reduce((sum, outcome) => sum + outcome.stalls, 0) / hours,
    stalledSecondsPerHour: outcomes.reduce((sum, outcome) => sum + outcome.stalledMs, 0) / 1_000 / hours,
    skippedPerHour: outcomes.reduce((sum, outcome) => sum + outcome.skipped, 0) / hours,
    resumeDelay:
      resumes.length === 0
        ? null
        : { p50: quantile(resumes, 0.5), p90: quantile(resumes, 0.9), max: Math.max(...resumes) },
    firstSlotEarlyAsks: {
      mean: mean(outcomes.map((outcome) => outcome.firstSlotEarlyAsks)),
      max: Math.max(...outcomes.map((outcome) => outcome.firstSlotEarlyAsks)),
    },
    readsPerSlotShares: shares.map((count) => count / Math.max(1, delivered)),
  };
}

export interface FindSummary {
  readonly runs: number;
  readonly reads: { readonly p50: number; readonly p90: number };
  readonly earlyAsks: { readonly p50: number; readonly p90: number };
  readonly nextSlotEarlyAsks: { readonly mean: number; readonly max: number };
  readonly rounds: { readonly p50: number; readonly p90: number };
  readonly timeMs: { readonly p50: number; readonly p90: number; readonly max: number };
  readonly correct: number;
  readonly fallbacks: number;
}

export function summariseFind(outcomes: readonly FindOutcome[]): FindSummary {
  const pick = (field: (outcome: FindOutcome) => number) => outcomes.map(field);
  const reads = pick((outcome) => outcome.reads);
  const early = pick((outcome) => outcome.earlyAsks);
  const rounds = pick((outcome) => outcome.rounds);
  const times = pick((outcome) => outcome.timeMs);
  const next = pick((outcome) => outcome.nextSlotEarlyAsks);
  return {
    runs: outcomes.length,
    reads: { p50: quantile(reads, 0.5), p90: quantile(reads, 0.9) },
    earlyAsks: { p50: quantile(early, 0.5), p90: quantile(early, 0.9) },
    nextSlotEarlyAsks: { mean: mean(next), max: Math.max(...next) },
    rounds: { p50: quantile(rounds, 0.5), p90: quantile(rounds, 0.9) },
    timeMs: { p50: quantile(times, 0.5), p90: quantile(times, 0.9), max: Math.max(...times) },
    correct: outcomes.filter((outcome) => outcome.correct).length / outcomes.length,
    fallbacks: outcomes.filter((outcome) => outcome.usedFallback).length / outcomes.length,
  };
}
