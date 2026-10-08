/**
 * Why the Funding page's write cannot go ahead, by what it is about:
 * - `not_set_up`: the admin has no manager funding settings, or no brand wallet;
 * - `chain`: the manager answers for another chain than the one the admin signs for;
 * - `node`: a node is not in the manager's inventory, its wallet could not be read, it was never pinned, or it answers
 *   another address than the pinned one; for a chequebook operation, also a node no stage lists, the catalogue node
 *   alone, or a gateway, whose chequebook the manager does not move;
 * - `fee`: the manager suggested a fee or a gas limit over the admin's own ceilings, so nothing is signed;
 * - `insufficient_funds`: the brand wallet cannot pay for the send, its fees counted, or a node cannot pay for its
 *   stamp operations, its top-ups in xBZZ or their gas in xDAI, or for its chequebook operation, its deposit in xBZZ
 *   or the gas of either way in xDAI;
 * - `batch`: a stamp operation's batch is not one its node uploads with, could not be read, is not usable, has expired
 *   or is no longer at the depth the page showed, or a dilution would leave it under 7 days;
 * - `price`: the manager read no price of postage, so a top-up cannot be priced;
 * - `chequebook`: a chequebook operation's chequebook: the node has none, the manager did not read it or could not,
 *   it stands at the target already, or it moved since the page read it so that the move the page worked out no
 *   longer holds.
 */
export type FundingRefusalProblem =
  | 'not_set_up'
  | 'chain'
  | 'node'
  | 'fee'
  | 'insufficient_funds'
  | 'batch'
  | 'price'
  | 'chequebook';

/**
 * A pin, a send, a stamp request or a chequebook request the funding services refused before anything was signed or
 * written. `message` is the sentence the console shows. The API answers 409: each is a state of the admin, the
 * manager, a node or the wallet, which changes, not a request that was wrong.
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
