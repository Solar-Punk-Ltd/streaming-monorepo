/**
 * A send refused because another one is not over: an item of an earlier send is not settled yet, or another send is
 * being signed right now. Or a stamp request refused for the same reasons about stamp bulks, which do not wait on
 * sends, nor sends on them. The API answers 409 `{ error: 'conflict' }`. Nothing was signed or journalled.
 */
export class FundingBusyError extends Error {
  constructor(what: 'send' | 'stamp bulk' = 'send') {
    super(
      what === 'send'
        ? 'An earlier send from the brand wallet is not settled yet, so no new one starts.'
        : 'An earlier stamp bulk is not settled yet, so no new one starts.',
    );
    this.name = 'FundingBusyError';
  }
}
