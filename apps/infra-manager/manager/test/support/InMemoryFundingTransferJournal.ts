import type {
  FundingTransferJournal,
  FundingTransferPatch,
  FundingTransferRow,
} from '../../src/domain/funding/FundingTransferJournal.js';

/** The funding transfer journal in memory, with the table's one rule: a request id is journalled once. */
export class InMemoryFundingTransferJournal implements FundingTransferJournal {
  readonly rows = new Map<string, FundingTransferRow>();

  async find(requestId: string): Promise<FundingTransferRow | null> {
    const row = this.rows.get(requestId);
    return row ? { ...row } : null;
  }

  async insert(row: FundingTransferRow): Promise<boolean> {
    if (this.rows.has(row.requestId)) return false;
    this.rows.set(row.requestId, { ...row });
    return true;
  }

  async update(requestId: string, patch: FundingTransferPatch): Promise<void> {
    const row = this.rows.get(requestId);
    if (row) this.rows.set(requestId, { ...row, ...patch });
  }
}
