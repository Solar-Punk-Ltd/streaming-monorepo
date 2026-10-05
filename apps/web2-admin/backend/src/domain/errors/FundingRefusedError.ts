/**
 * Why the Funding page's write cannot go ahead, by what it is about:
 * - `not_set_up`: the admin has no manager funding settings, or no brand wallet;
 * - `chain`: the manager answers for another chain than the one the admin signs for;
 * - `node`: a node is not in the manager's inventory, its wallet could not be read, it was never pinned, or it answers
 *   another address than the pinned one;
 * - `fee`: the manager suggested a fee or a gas limit over the admin's own ceilings, so nothing is signed;
 * - `insufficient_funds`: the brand wallet cannot pay for the send, its fees counted.
 */
export type FundingRefusalProblem = 'not_set_up' | 'chain' | 'node' | 'fee' | 'insufficient_funds';

/**
 * A pin or a send the funding service refused before anything was signed or written. `message` is the sentence the
 * console shows. The API answers 409: each is a state of the admin, the manager or the wallet, which changes, not a
 * request that was wrong.
 */
export class FundingRefusedError extends Error {
  constructor(
    public readonly problem: FundingRefusalProblem,
    message: string,
  ) {
    super(message);
    this.name = 'FundingRefusedError';
  }
}
