import type { FundingTransferState } from '@streaming-monorepo/contracts';

import type {
  FundingStampOperationJournal,
  FundingStampOperationPatch,
  FundingStampOperationRow,
} from '../../src/domain/funding/FundingStampOperationJournal.js';

/**
 * The stamp operation journal in memory, with the table's two rules the service leans on: a request id is journalled
 * once, and an update lands only on a row still in the state it names.
 */
export class InMemoryFundingStampOperationJournal implements FundingStampOperationJournal {
  readonly rows = new Map<string, FundingStampOperationRow>();

  async find(requestId: string): Promise<FundingStampOperationRow | null> {
    const row = this.rows.get(requestId);
    return row ? { ...row } : null;
  }

  async insert(row: FundingStampOperationRow): Promise<boolean> {
    if (this.rows.has(row.requestId)) return false;
    this.rows.set(row.requestId, { ...row });
    return true;
  }

  async update(requestId: string, from: FundingTransferState, patch: FundingStampOperationPatch): Promise<boolean> {
    const row = this.rows.get(requestId);
    if (!row || row.state !== from) return false;
    this.rows.set(requestId, { ...row, ...patch });
    return true;
  }
}
