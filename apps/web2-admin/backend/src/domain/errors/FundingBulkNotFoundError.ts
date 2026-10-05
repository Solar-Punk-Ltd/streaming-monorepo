/** `GET /api/funding/transfers?bulkId=` named a send the admin never journalled. The API answers 404. */
export class FundingBulkNotFoundError extends Error {
  constructor(public readonly bulkId: string) {
    super(`No send has the id ${bulkId}.`);
    this.name = 'FundingBulkNotFoundError';
  }
}
