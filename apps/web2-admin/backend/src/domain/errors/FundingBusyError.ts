/**
 * A send refused because another one is not over: an item of an earlier send is not settled yet, or another send is
 * being signed right now. The API answers 409 `{ error: 'conflict' }`. Nothing was signed.
 */
export class FundingBusyError extends Error {
  constructor() {
    super('An earlier send from the brand wallet is not settled yet, so no new one starts.');
    this.name = 'FundingBusyError';
  }
}
