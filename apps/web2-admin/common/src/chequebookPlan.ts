import type { FundingChequebook, FundingChequebookDirection, FundingNode } from './funding.js';

/**
 * The arithmetic of a chequebook operation, one rule for the admin's backend, which checks and sends one, and for its
 * Funding page, which shows what each ticked chequebook takes: docs/architecture/funding.md, "Chequebooks tab". The page
 * shows `chequebookMove` from the balance it read; the backend moves `chequebookMoveNow`, the same worked out again
 * from the balance read when the request comes in, and never more. Every amount is a whole number of PLUR as a decimal
 * string, worked in BigInt.
 */

/** The least a chequebook may be brought to, in PLUR: 1 xBZZ, as the owner decided on 2026-10-08. */
export const CHEQUEBOOK_TARGET_MIN_PLUR = '10000000000000000';

/** What brings one chequebook to a target: which way xBZZ moves, and how much, PLUR as a decimal string above 0. */
export interface ChequebookMove {
  direction: FundingChequebookDirection;
  amountPlur: string;
}

const PLUR = /^(0|[1-9]\d*)$/;

function plur(value: string, name: string): bigint {
  if (!PLUR.test(value)) throw new RangeError(`${name} must be a whole number of PLUR`);
  return BigInt(value);
}

/**
 * What brings a chequebook whose available balance is `availablePlur` to `targetPlur`: a deposit of the difference from
 * its node's wallet when it is under the target, a withdrawal of the difference into its node's wallet when it is over
 * it, and null when it is at it, since a move of nothing is not sent. Both are whole numbers of PLUR as decimal
 * strings; anything else throws, since the page and the routes refuse it before they ask.
 */
export function chequebookMove(targetPlur: string, availablePlur: string): ChequebookMove | null {
  const target = plur(targetPlur, 'targetPlur');
  const available = plur(availablePlur, 'availablePlur');
  if (target === available) return null;
  return target > available
    ? { direction: 'deposit', amountPlur: (target - available).toString() }
    : { direction: 'withdraw', amountPlur: (available - target).toString() };
}

/**
 * The move that brings a chequebook to `targetPlur` from its available balance read now, `availableNowPlur`, when the
 * confirm dialog showed it at `shownAvailablePlur`: worked out again when the request comes in, and never more than
 * the move the dialog listed, `chequebookMove(targetPlur, shownAvailablePlur)`.
 *
 * A deposit is the target less the larger of the two balances. Into a chequebook that grew since, it shrinks and lands
 * on the target; into one its node drew on since, paying its peers, it keeps the amount shown and lands a little under
 * the target. A withdrawal is the smaller of the two balances less the target. From a chequebook its node drew on since,
 * it shrinks and lands on the target; from one that grew since, it keeps the amount shown and lands a little over it.
 * Either way the balance read now is never taken past the target. Null when the dialog showed no move, when the
 * chequebook is at the target or past it now, so that the move now would go the other way, or nowhere.
 *
 * Every amount is a whole number of PLUR as a decimal string; anything else throws, as for {@link chequebookMove}.
 */
export function chequebookMoveNow(
  targetPlur: string,
  shownAvailablePlur: string,
  availableNowPlur: string,
): ChequebookMove | null {
  const target = plur(targetPlur, 'targetPlur');
  const shown = plur(shownAvailablePlur, 'shownAvailablePlur');
  const now = plur(availableNowPlur, 'availableNowPlur');
  if (shown < target && now < target) {
    const from = shown > now ? shown : now;
    return { direction: 'deposit', amountPlur: (target - from).toString() };
  }
  if (shown > target && now > target) {
    const from = shown < now ? shown : now;
    return { direction: 'withdraw', amountPlur: (from - target).toString() };
  }
  return null;
}

/**
 * The cheques the node wrote out of its chequebook that its peers have not cashed yet, PLUR as a decimal string: its
 * total balance less its available one. Null when either was not read, and when the two do not add up.
 */
export function chequebookUncashedPlur(chequebook: FundingChequebook): string | null {
  const { totalPlur, availablePlur } = chequebook;
  if (totalPlur === null || availablePlur === null || !PLUR.test(totalPlur) || !PLUR.test(availablePlur)) return null;
  const uncashed = BigInt(totalPlur) - BigInt(availablePlur);
  return uncashed >= 0n ? uncashed.toString() : null;
}

/**
 * Whether a stage's node's chequebook can be brought to a target from the Chequebooks tab: the node is a stage's own
 * Bee node or a rung, never a gateway, whose chequebook the manager does not move, and its wallet and its chequebook
 * were both read. The catalogue node is no stage's node, so the tab never asks about it.
 */
export function movableChequebook(node: FundingNode): boolean {
  const chequebook = node.chequebook ?? null;
  return (
    (node.role === 'uploader' || node.role === 'rung') &&
    node.walletAddress !== null &&
    node.xdaiWei !== null &&
    node.xbzzPlur !== null &&
    chequebook !== null &&
    chequebook.readError === null &&
    chequebook.availablePlur !== null
  );
}
