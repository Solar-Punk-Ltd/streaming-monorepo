/** What a busy refusal is about: sends, stamp bulks and chequebook bulks each wait only on their own kind. */
export type FundingBusyKind = 'send' | 'stamp bulk' | 'chequebook bulk';

const BUSY: Readonly<Record<FundingBusyKind, string>> = {
  send: 'An earlier send from the brand wallet is not settled yet, so no new one starts.',
  'stamp bulk': 'An earlier stamp bulk is not settled yet, so no new one starts.',
  'chequebook bulk': 'An earlier chequebook bulk is not settled yet, so no new one starts.',
};

/**
 * A send refused because another one is not over: an item of an earlier send is not settled yet, or another send is
 * being signed right now. Or a stamp request, or a chequebook request, refused for the same reasons about its own
 * kind of bulk: a send, a stamp bulk and a chequebook bulk do not wait on each other. The API answers 409
 * `{ error: 'conflict' }`. Nothing was signed or journalled.
 */
export class FundingBusyError extends Error {
  constructor(what: FundingBusyKind = 'send') {
    super(BUSY[what]);
    this.name = 'FundingBusyError';
  }
}
