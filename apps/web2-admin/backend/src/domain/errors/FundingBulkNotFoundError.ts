/**
 * `GET /api/funding/transfers?bulkId=` named a send the admin never journalled, `GET
 * /api/funding/stamp-operations?bulkId=` a stamp bulk, or `GET /api/funding/chequebook-operations?bulkId=` a
 * chequebook bulk. The API answers 404.
 */
export class FundingBulkNotFoundError extends Error {
  constructor(
    public readonly bulkId: string,
    what: 'send' | 'stamp bulk' | 'chequebook bulk' = 'send',
  ) {
    super(`No ${what} has the id ${bulkId}.`);
    this.name = 'FundingBulkNotFoundError';
  }
}
