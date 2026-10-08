import type { FundingBatch, FundingPostage } from './funding.js';

/**
 * The arithmetic of a stamp operation, one rule for the admin's backend, which checks and sends one, and for its
 * Funding page, which shows what one costs and leaves: docs/architecture/funding.md, "Stamps tab". Every amount is
 * BigInt, in base units (PLUR).
 */

/** Seconds in a day. */
export const SECONDS_PER_DAY = 86_400;

/** The most steps one dilution takes; each doubles what a batch holds and halves its time left. */
export const DILUTE_MAX_STEPS = 2;

/** The time left a dilution must leave its batch: 7 days, as the owner decided on 2026-10-08. */
export const DILUTE_MIN_SECONDS_AFTER = 7 * SECONDS_PER_DAY;

/**
 * The deepest the manager dilutes a batch to: the manager's own ceiling, `MAX_STAMP_DEPTH` of its common package, which
 * it refuses a dilution past. The admin cannot import it, since apps never import each other, so it keeps the same
 * number here and refuses such a dilution first.
 */
export const STAMP_MAX_DEPTH = 40;

/** What a top-up costs and leaves, at the price the chain asks now. */
export interface StampTopUpQuote {
  /** What a node's `PATCH /stamps/topup` takes: PLUR per chunk, for every block of the days. */
  amountPerChunkPlur: string;
  /** What the node pays in all, in PLUR: the amount per chunk, for each of the batch's 2^depth chunks. */
  costPlur: string;
  /**
   * The batch's time left after it, at today's price: exact while it is a safe integer, some 285 million years, and
   * the nearest number past that, never NaN or Infinity.
   */
  ttlAfterSeconds: number;
}

/**
 * A top-up of `days` more days on a batch of `depth` with `ttlSeconds` left, at `postage`'s price. The blocks are
 * rounded up, so the days are never short, and counted in BigInt, so any whole number of days stays exact: its seconds
 * in a number would lose digits past 2^53. `days` is a whole number of 1 or more, with no cap; anything else throws,
 * since the page and the routes refuse it before they ask.
 */
export function stampTopUpQuote(
  days: number,
  depth: number,
  ttlSeconds: number,
  postage: FundingPostage,
): StampTopUpQuote {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('days must be a whole number of 1 or more');
  const seconds = BigInt(days) * BigInt(SECONDS_PER_DAY);
  const blockSeconds = BigInt(postage.blockSeconds);
  const blocks = (seconds + blockSeconds - 1n) / blockSeconds;
  const amountPerChunk = blocks * BigInt(postage.pricePerChunkPerBlockPlur);
  return {
    amountPerChunkPlur: amountPerChunk.toString(),
    costPlur: (amountPerChunk * 2n ** BigInt(depth)).toString(),
    // The exact seconds become a number only here, rounded only past 2^53, so the sum is exact while it can be.
    ttlAfterSeconds: ttlSeconds + Number(seconds),
  };
}

/** What a dilution leaves, and why it is refused. */
export interface StampDiluteQuote {
  newDepth: number;
  /** The batch's time left after it: what it had, halved for each step. */
  ttlAfterSeconds: number;
  /** Why the dilution is refused, in a sentence, or null when it is not. */
  problem: string | null;
}

/**
 * A dilution of `steps` on a batch of `depth` with `ttlSeconds` left. It is refused for other than 1 or 2 steps, when
 * it would take the batch past {@link STAMP_MAX_DEPTH}, and when it would leave the batch under 7 days: the floor is on
 * the time left after it, so a batch of 10 days cannot be diluted two steps to 2.5.
 */
export function stampDiluteQuote(steps: number, depth: number, ttlSeconds: number): StampDiluteQuote {
  const newDepth = depth + steps;
  const ttlAfterSeconds = Math.floor(ttlSeconds / 2 ** steps);
  let problem: string | null = null;
  if (!Number.isInteger(steps) || steps < 1 || steps > DILUTE_MAX_STEPS) {
    problem = `A dilution takes 1 or ${DILUTE_MAX_STEPS} steps.`;
  } else if (newDepth > STAMP_MAX_DEPTH) {
    problem = `It would take the batch past depth ${STAMP_MAX_DEPTH}, the deepest the manager dilutes a batch to.`;
  } else if (ttlAfterSeconds < DILUTE_MIN_SECONDS_AFTER) {
    problem = 'It would leave the batch under 7 days.';
  }
  return { newDepth, ttlAfterSeconds, problem };
}

/** A batch read whole, usable and not expired: the only kind a stamp operation is offered for or sent for. */
export type OperableBatch = FundingBatch & { depth: number; ttlSeconds: number; usable: true };

/**
 * Whether a batch can take a stamp operation at all. A batch its node could not be read about has nulls and a
 * `readError`, and is never operated on; nor is one that is not usable, or has expired (`ttlSeconds` 0).
 */
export function operableBatch(batch: FundingBatch | null | undefined): batch is OperableBatch {
  return (
    batch !== null &&
    batch !== undefined &&
    batch.readError === null &&
    batch.depth !== null &&
    batch.ttlSeconds !== null &&
    batch.ttlSeconds > 0 &&
    batch.usable === true
  );
}
